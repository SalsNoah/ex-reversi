import type { Individual, IndividualFitness } from './genes.ts'
import {
  makeMatchId,
  matchSeeds,
  runGaMatch,
  scoreForSide,
  type GaMatchResult,
} from './matchRunner.ts'
import type { PanelEntry } from './panel.ts'
import type { Stone } from '../game/types.ts'

function emptyFitness(): IndividualFitness {
  return {
    primaryScore: 0,
    primaryGames: 0,
    extraScore: 0,
    extraGames: 0,
    scoreRate: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    totalStoneDiff: 0,
    byOpponent: {},
  }
}

function applyResult(
  fit: IndividualFitness,
  oppId: string,
  points: number,
  win: boolean,
  draw: boolean,
  _loss: boolean,
  stoneDiff: number,
  bucket: 'primary' | 'extra',
): void {
  if (bucket === 'primary') {
    fit.primaryScore += points
    fit.primaryGames += 1
  } else {
    fit.extraScore += points
    fit.extraGames += 1
  }
  if (win) fit.wins += 1
  else if (draw) fit.draws += 1
  else fit.losses += 1
  fit.totalStoneDiff += stoneDiff
  const row = fit.byOpponent[oppId] ?? {
    wins: 0,
    draws: 0,
    losses: 0,
    score: 0,
    games: 0,
  }
  row.games += 1
  row.score += points
  if (win) row.wins += 1
  else if (draw) row.draws += 1
  else row.losses += 1
  fit.byOpponent[oppId] = row
  const games = fit.primaryGames + fit.extraGames
  fit.scoreRate = games > 0 ? (fit.primaryScore + fit.extraScore) / games : 0
}

export type EvalProgress = {
  completedMatches: number
  totalMatches: number
  matchesPerSec: number
  lastMatchId: string
}

/**
 * 個体集団を共通パネルで評価する。
 * completedIds に含まれる試合はスキップ（再開用）。
 */
export function evaluatePopulation(options: {
  population: Individual[]
  panel: PanelEntry[]
  generation: number
  phase: 'primary' | 'extra'
  masterSeed: number
  seedOffset: number
  /** 相手×色あたりの試合数。未指定は1 */
  gamesPerOpponentSide?: number
  completedIds: Set<string>
  onMatch?: (r: GaMatchResult, progress: EvalProgress) => void
  shouldStop?: () => boolean
  wallStart: number
  completedMatchesGlobal: { n: number }
}): {
  results: GaMatchResult[]
  moveHashes: string[]
  stopped: boolean
} {
  const results: GaMatchResult[] = []
  const moveHashes: string[] = []
  const sides: Stone[] = ['black', 'white']
  const gamesPerSide = Math.max(1, options.gamesPerOpponentSide ?? 1)
  let planned = 0
  for (const _ of options.population) {
    for (const __ of options.panel) {
      for (const ___ of sides) planned += gamesPerSide
    }
  }

  let localDone = 0
  for (const ind of options.population) {
    if (!ind.fitness) ind.fitness = emptyFitness()
    for (const opp of options.panel) {
      for (const side of sides) {
        for (let game = 0; game < gamesPerSide; game += 1) {
          if (options.shouldStop?.()) {
            return { results, moveHashes, stopped: true }
          }
          const slot = options.seedOffset + game
          const matchId = makeMatchId({
            generation: options.generation,
            phase: options.phase,
            indId: ind.id,
            oppId: opp.panelId,
            side,
            slot,
          })
          if (options.completedIds.has(matchId)) {
            localDone += 1
            continue
          }

          const { gameSeed, decisionSeed } = matchSeeds(
            options.masterSeed,
            options.generation,
            ind.id,
            opp.panelId,
            side,
            slot + (options.phase === 'extra' ? 10_000 : 0),
          )

          const selfSpec = {
            kind: 'gene' as const,
            id: ind.id,
            genes: ind.genes,
            labelId: ind.id,
          }
          const oppSpec = {
            ...opp.spec,
            labelId: opp.panelId,
          }

          const black = side === 'black' ? selfSpec : oppSpec
          const white = side === 'white' ? selfSpec : oppSpec

          const result = runGaMatch({
            matchId,
            seed: gameSeed,
            black,
            white,
            decisionSeed,
          })
          if (result.abnormal) {
            throw new Error(`Abnormal match ${matchId}`)
          }
          results.push(result)
          moveHashes.push(result.moveHash)
          options.completedIds.add(matchId)
          options.completedMatchesGlobal.n += 1
          localDone += 1

          const scored = scoreForSide(result, side)
          applyResult(
            ind.fitness,
            opp.panelId,
            scored.points,
            scored.win,
            scored.draw,
            scored.loss,
            scored.stoneDiff,
            options.phase,
          )

          const elapsed = (performance.now() - options.wallStart) / 1000
          options.onMatch?.(result, {
            completedMatches: options.completedMatchesGlobal.n,
            totalMatches: planned,
            matchesPerSec:
              elapsed > 0 ? options.completedMatchesGlobal.n / elapsed : 0,
            lastMatchId: matchId,
          })
        }
      }
    }
  }
  return { results, moveHashes, stopped: false }
}

export function resetFitness(pop: Individual[]): void {
  for (const ind of pop) {
    ind.fitness = emptyFitness()
  }
}
