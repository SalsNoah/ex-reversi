/**
 * 対戦場。AIの採否はここで出る勝率だけで決める。
 *
 * - 黒白を必ず入れ替えて同数打つ（先手・後手の偏りを消す）
 * - 入れ替えた 2 局は同じシードを使う（同条件で色だけ違う＝分散が小さい）
 * - SPRT を渡せば、結論が出た時点で打ち切る
 */
import { deriveSeed } from '../../ga/rng.ts'
import {
  END_BOARD_FULL,
  END_NO_LEGAL_MOVES,
  END_TIME_UP,
  OUTCOME_BLACK_WIN,
  OUTCOME_DRAW,
  OUTCOME_WHITE_WIN,
  createFastMatch,
  runFastMatch,
  type FastAgent,
  type FastMatch,
  type FastMatchConfig,
} from '../sim/fastMatch.ts'
import {
  DEFAULT_SPRT,
  binomialTestTwoSided,
  eloFromScoreRate,
  fitBradleyTerryElo,
  sprtDecision,
  wilsonInterval,
  type PairwiseRecord,
  type SprtBounds,
  type SprtVerdict,
} from './stats.ts'

export type AgentSpec = {
  id: string
  label: string
  /** 対戦ごとに内部状態を分けたいので都度生成する */
  create: () => FastAgent
}

export type SeriesResult = {
  aId: string
  bId: string
  games: number
  aWins: number
  bWins: number
  draws: number
  /** 勝ち1・引分0.5 の得点率 */
  aScoreRate: number
  wilsonLow: number
  wilsonHigh: number
  /** 引き分けを除いた勝敗の両側二項検定 */
  pValue: number
  significant: boolean
  eloDiff: number
  avgStoneDiffForA: number
  endReasons: Record<string, number>
  abnormal: number
  sprt: { verdict: SprtVerdict; llr: number } | null
  wallMs: number
}

const END_NAMES: Record<number, string> = {
  [END_BOARD_FULL]: 'board_full',
  [END_NO_LEGAL_MOVES]: 'no_legal_moves',
  [END_TIME_UP]: 'time_up',
}

export type SeriesOptions = {
  a: AgentSpec
  b: AgentSpec
  games: number
  masterSeed: number
  config?: Partial<FastMatchConfig>
  /** 渡すと結論が出た時点で打ち切る */
  sprt?: SprtBounds | null
  /** SPRT 判定を始める最小試合数（少数での暴走を防ぐ） */
  sprtMinGames?: number
  onProgress?: (done: number, total: number) => void
  /** 使い回す盤面（省略時は内部で 1 つ確保） */
  match?: FastMatch
  /**
   * 最初の N 意思決定をランダム着手にして開幕をばらす。
   *
   * 決定的なエンジン同士だとシードを変えても試合が同一になり、
   * 何局測っても独立標本にならない（実測: 4 シードすべて 15-15-0 で完全一致）。
   * 既定で開幕をばらす。0 を渡すと従来どおり固定開幕。
   */
  randomOpeningDecisions?: number
}

/** 既定のランダム開幕数。序盤が荒れすぎず、初期条件は十分に散る */
export const DEFAULT_RANDOM_OPENING = 4

export function playSeries(options: SeriesOptions): SeriesResult {
  const wallStart = performance.now()
  const match = options.match ?? createFastMatch({ seed: 1, config: options.config })
  const agentA = options.a.create()
  const agentB = options.b.create()
  const sprtMinGames = options.sprtMinGames ?? 40

  let aWins = 0
  let bWins = 0
  let draws = 0
  let stoneDiffSum = 0
  let abnormal = 0
  const endReasons: Record<string, number> = {}
  let played = 0
  let sprtState: { verdict: SprtVerdict; llr: number } | null = null

  const randomOpening = options.randomOpeningDecisions ?? DEFAULT_RANDOM_OPENING

  for (let i = 0; i < options.games; i += 1) {
    // 色を入れ替えた 2 局で同じシードを使う（開幕も同じになるので公平）
    const pairIndex = i >> 1
    const aIsBlack = (i & 1) === 0
    const gameSeed = deriveSeed(
      options.masterSeed,
      hashId(options.a.id),
      hashId(options.b.id),
      pairIndex,
      0x11,
    )
    const decisionSeed = deriveSeed(gameSeed, 0x22)

    const result = runFastMatch({
      seed: gameSeed,
      decisionSeed,
      black: aIsBlack ? agentA : agentB,
      white: aIsBlack ? agentB : agentA,
      config: options.config,
      match,
      randomOpeningDecisions: randomOpening,
    })

    played += 1
    if (result.abnormal) {
      abnormal += 1
      endReasons.abnormal = (endReasons.abnormal ?? 0) + 1
      continue
    }
    const name = END_NAMES[result.endReason] ?? 'unknown'
    endReasons[name] = (endReasons[name] ?? 0) + 1

    const diffForA = aIsBlack
      ? result.stoneDiffForBlack
      : -result.stoneDiffForBlack
    stoneDiffSum += diffForA

    if (result.outcome === OUTCOME_DRAW) draws += 1
    else if (
      (aIsBlack && result.outcome === OUTCOME_BLACK_WIN) ||
      (!aIsBlack && result.outcome === OUTCOME_WHITE_WIN)
    ) {
      aWins += 1
    } else {
      bWins += 1
    }

    options.onProgress?.(played, options.games)

    // 色の偏りが出ないよう、必ず偶数局で判定する
    if (
      options.sprt &&
      played >= sprtMinGames &&
      played % 2 === 0
    ) {
      const decision = sprtDecision(aWins, draws, bWins, options.sprt)
      sprtState = { verdict: decision.verdict, llr: decision.llr }
      if (decision.verdict !== 'continue') break
    }
  }

  const decided = aWins + bWins
  const score = aWins + draws * 0.5
  const scoreRate = played > 0 ? score / played : 0
  const wilson = wilsonInterval(score, played)
  const pValue = binomialTestTwoSided(aWins, bWins)

  return {
    aId: options.a.id,
    bId: options.b.id,
    games: played,
    aWins,
    bWins,
    draws,
    aScoreRate: scoreRate,
    wilsonLow: wilson.low,
    wilsonHigh: wilson.high,
    pValue,
    significant: decided > 0 && pValue < 0.05,
    eloDiff: eloFromScoreRate(scoreRate),
    avgStoneDiffForA: played > 0 ? stoneDiffSum / played : 0,
    endReasons,
    abnormal,
    sprt: sprtState,
    wallMs: performance.now() - wallStart,
  }
}

export type RoundRobinResult = {
  playerIds: string[]
  series: SeriesResult[]
  elo: Array<{ id: string; label: string; elo: number; scoreRate: number; games: number }>
  totalGames: number
  wallMs: number
}

export function playRoundRobin(options: {
  players: readonly AgentSpec[]
  gamesPerPair: number
  masterSeed: number
  config?: Partial<FastMatchConfig>
  anchorId?: string
  onSeries?: (result: SeriesResult, index: number, total: number) => void
  onProgress?: (done: number, total: number, aId: string, bId: string) => void
}): RoundRobinResult {
  const wallStart = performance.now()
  const players = [...options.players]
  if (players.length < 2) throw new Error('round robin needs at least 2 players')
  const match = createFastMatch({ seed: 1, config: options.config })
  const series: SeriesResult[] = []
  const total = (players.length * (players.length - 1)) / 2
  let index = 0

  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const result = playSeries({
        a: players[i]!,
        b: players[j]!,
        games: options.gamesPerPair,
        masterSeed: options.masterSeed,
        config: options.config,
        match,
        onProgress(done, totalGames) {
          options.onProgress?.(done, totalGames, players[i]!.id, players[j]!.id)
        },
      })
      series.push(result)
      index += 1
      options.onSeries?.(result, index, total)
    }
  }

  const records: PairwiseRecord[] = series.map((s) => ({
    aId: s.aId,
    bId: s.bId,
    aWins: s.aWins,
    bWins: s.bWins,
    draws: s.draws,
  }))
  const eloMap = fitBradleyTerryElo(records, { anchorId: options.anchorId })

  const scoreById = new Map<string, { score: number; games: number }>()
  for (const p of players) scoreById.set(p.id, { score: 0, games: 0 })
  for (const s of series) {
    const a = scoreById.get(s.aId)!
    const b = scoreById.get(s.bId)!
    a.score += s.aWins + s.draws * 0.5
    a.games += s.games
    b.score += s.bWins + s.draws * 0.5
    b.games += s.games
  }

  const elo = players
    .map((p) => {
      const agg = scoreById.get(p.id)!
      return {
        id: p.id,
        label: p.label,
        elo: eloMap.get(p.id) ?? 0,
        scoreRate: agg.games > 0 ? agg.score / agg.games : 0,
        games: agg.games,
      }
    })
    .sort((x, y) => y.elo - x.elo)

  return {
    playerIds: players.map((p) => p.id),
    series,
    elo,
    totalGames: series.reduce((n, s) => n + s.games, 0),
    wallMs: performance.now() - wallStart,
  }
}

export function formatSeries(result: SeriesResult): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`
  const sprt = result.sprt
    ? ` SPRT=${result.sprt.verdict}(LLR ${result.sprt.llr.toFixed(2)})`
    : ''
  return [
    `${result.aId} vs ${result.bId}`,
    `${result.games}局`,
    `${result.aWins}-${result.bWins}-${result.draws}`,
    `得点率 ${pct(result.aScoreRate)} [${pct(result.wilsonLow)}, ${pct(result.wilsonHigh)}]`,
    `Elo ${result.eloDiff >= 0 ? '+' : ''}${result.eloDiff.toFixed(0)}`,
    `p=${result.pValue.toFixed(4)}${result.significant ? ' *有意*' : ''}`,
    `石差 ${result.avgStoneDiffForA >= 0 ? '+' : ''}${result.avgStoneDiffForA.toFixed(1)}`,
    `${(result.wallMs / 1000).toFixed(1)}s${sprt}`,
  ].join(' | ')
}

export const DEFAULT_ARENA_SPRT = DEFAULT_SPRT

function hashId(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
