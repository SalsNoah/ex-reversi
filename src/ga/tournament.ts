import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GA_MILESTONES, type GaMilestone } from '../cpu/gaMilestones.ts'
import { matchSeeds, runGaMatch, type OpponentSpec } from './matchRunner.ts'

export type FirstToWinner = 'a' | 'b' | null

export type FirstToSeriesOutcome = {
  aWins: number
  bWins: number
  draws: number
  games: number
  winner: FirstToWinner
}

export function playFirstToSeries(options: {
  firstTo: number
  maxGames?: number
  playGame: (gameIndex: number, aIsBlack: boolean) => 'a' | 'b' | 'draw'
}): FirstToSeriesOutcome {
  const firstTo = options.firstTo
  const maxGames = options.maxGames ?? firstTo * 20
  let aWins = 0
  let bWins = 0
  let draws = 0
  let games = 0
  while (aWins < firstTo && bWins < firstTo && games < maxGames) {
    const aIsBlack = games % 2 === 0
    const result = options.playGame(games, aIsBlack)
    games += 1
    if (result === 'a') aWins += 1
    else if (result === 'b') bWins += 1
    else draws += 1
  }
  let winner: FirstToWinner = null
  if (aWins >= firstTo && aWins > bWins) winner = 'a'
  else if (bWins >= firstTo && bWins > aWins) winner = 'b'
  return { aWins, bWins, draws, games, winner }
}

export function playFixedGames(options: {
  games: number
  playGame: (gameIndex: number, aIsBlack: boolean) => 'a' | 'b' | 'draw'
}): FirstToSeriesOutcome {
  let aWins = 0
  let bWins = 0
  let draws = 0
  for (let games = 0; games < options.games; games += 1) {
    const aIsBlack = games % 2 === 0
    const result = options.playGame(games, aIsBlack)
    if (result === 'a') aWins += 1
    else if (result === 'b') bWins += 1
    else draws += 1
  }
  let winner: FirstToWinner = null
  if (aWins > bWins) winner = 'a'
  else if (bWins > aWins) winner = 'b'
  return { aWins, bWins, draws, games: options.games, winner }
}

export type TournamentPlayer = {
  id: string
  generation: number
  sourceId: string
  genes: readonly number[]
}

export type PairingResult = {
  aId: string
  bId: string
  aWins: number
  bWins: number
  draws: number
  games: number
  winnerId: string | null
}

export type StandingRow = {
  id: string
  generation: number
  sourceId: string
  seriesWins: number
  seriesLosses: number
  seriesDraws: number
  gameWins: number
  gameLosses: number
  gameDraws: number
  gameWinRate: number
}

export type RoundRobinReport = {
  firstTo: number
  gamesPerPair: number | null
  masterSeed: number
  playerIds: string[]
  pairings: PairingResult[]
  standings: StandingRow[]
  totalGames: number
  elapsedSec: number
}

function geneSpec(player: TournamentPlayer): OpponentSpec & { labelId: string } {
  return {
    kind: 'gene',
    id: player.id,
    genes: [...player.genes],
    labelId: player.id,
  }
}

function playersFromMilestones(
  milestones: readonly GaMilestone[] = GA_MILESTONES,
  playerIds?: readonly string[],
): TournamentPlayer[] {
  const selected = playerIds
    ? playerIds.map((id) => {
        const found = milestones.find((m) => m.id === id)
        if (!found) throw new Error(`milestone not found: ${id}`)
        return found
      })
    : [...milestones]
  return selected.map((m) => ({
    id: m.id,
    generation: m.generation,
    sourceId: m.sourceId,
    genes: m.genes,
  }))
}

function emptyStanding(player: TournamentPlayer): StandingRow {
  return {
    id: player.id,
    generation: player.generation,
    sourceId: player.sourceId,
    seriesWins: 0,
    seriesLosses: 0,
    seriesDraws: 0,
    gameWins: 0,
    gameLosses: 0,
    gameDraws: 0,
    gameWinRate: 0,
  }
}

function rankStandings(rows: StandingRow[]): StandingRow[] {
  return [...rows].sort((a, b) => {
    if (b.seriesWins !== a.seriesWins) return b.seriesWins - a.seriesWins
    if (a.seriesLosses !== b.seriesLosses) return a.seriesLosses - b.seriesLosses
    const aDiff = a.gameWins - a.gameLosses
    const bDiff = b.gameWins - b.gameLosses
    if (bDiff !== aDiff) return bDiff - aDiff
    if (b.gameWinRate !== a.gameWinRate) return b.gameWinRate - a.gameWinRate
    return b.generation - a.generation
  })
}

export function runInstalledRoundRobin(options?: {
  firstTo?: number
  gamesPerPair?: number
  playerIds?: readonly string[]
  masterSeed?: number
  onSeries?: (pairing: PairingResult, index: number, total: number) => void
}): RoundRobinReport {
  const gamesPerPair = options?.gamesPerPair
  const firstTo = gamesPerPair ? 0 : (options?.firstTo ?? 10)
  const masterSeed = options?.masterSeed ?? 20260915
  const wallStart = performance.now()
  const players = playersFromMilestones(GA_MILESTONES, options?.playerIds)
  if (players.length < 2) {
    throw new Error('round-robin needs at least 2 players')
  }
  const pairings: PairingResult[] = []
  const standings = new Map(players.map((p) => [p.id, emptyStanding(p)]))
  const totalPairs = (players.length * (players.length - 1)) / 2
  let pairIndex = 0

  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i]!
      const b = players[j]!
      const playGame = (gameIndex: number, aIsBlack: boolean) => {
          const side = aIsBlack ? 'black' : 'white'
          const { gameSeed, decisionSeed } = matchSeeds(
            masterSeed,
            0,
            a.id,
            b.id,
            side,
            gameIndex,
          )
          const black = aIsBlack ? geneSpec(a) : geneSpec(b)
          const white = aIsBlack ? geneSpec(b) : geneSpec(a)
          const result = runGaMatch({
            matchId: `rr-${a.id}-vs-${b.id}-g${gameIndex}`,
            seed: gameSeed,
            black,
            white,
            decisionSeed,
          })
          if (result.abnormal) {
            throw new Error(`abnormal match ${result.matchId}`)
          }
          if (result.outcome === 'draw') return 'draw'
          const blackWon = result.outcome === 'black_win'
          if (aIsBlack) return blackWon ? 'a' : 'b'
          return blackWon ? 'b' : 'a'
      }
      const series = gamesPerPair
        ? playFixedGames({ games: gamesPerPair, playGame })
        : playFirstToSeries({ firstTo, playGame })
      const pairing: PairingResult = {
        aId: a.id,
        bId: b.id,
        aWins: series.aWins,
        bWins: series.bWins,
        draws: series.draws,
        games: series.games,
        winnerId:
          series.winner === 'a' ? a.id : series.winner === 'b' ? b.id : null,
      }
      pairings.push(pairing)
      pairIndex += 1
      options?.onSeries?.(pairing, pairIndex, totalPairs)

      const aRow = standings.get(a.id)!
      const bRow = standings.get(b.id)!
      aRow.gameWins += series.aWins
      aRow.gameLosses += series.bWins
      aRow.gameDraws += series.draws
      bRow.gameWins += series.bWins
      bRow.gameLosses += series.aWins
      bRow.gameDraws += series.draws
      if (pairing.winnerId === a.id) {
        aRow.seriesWins += 1
        bRow.seriesLosses += 1
      } else if (pairing.winnerId === b.id) {
        bRow.seriesWins += 1
        aRow.seriesLosses += 1
      } else {
        aRow.seriesDraws += 1
        bRow.seriesDraws += 1
      }
    }
  }

  const ranked = [...standings.values()].map((row) => {
    const decided = row.gameWins + row.gameLosses
    return {
      ...row,
      gameWinRate: decided > 0 ? row.gameWins / decided : 0,
    }
  })

  return {
    firstTo,
    gamesPerPair: gamesPerPair ?? null,
    masterSeed,
    playerIds: players.map((p) => p.id),
    pairings,
    standings: rankStandings(ranked),
    totalGames: pairings.reduce((n, p) => n + p.games, 0),
    elapsedSec: (performance.now() - wallStart) / 1000,
  }
}

export function writeRoundRobinReport(
  path: string,
  report: RoundRobinReport,
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}
