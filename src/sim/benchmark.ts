import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CpuTypeId } from '../cpu/types.ts'
import { GAME_CONFIG } from '../game/config.ts'
import { runCpuMatch } from './cpuMatch.ts'
import type { CpuMatchResult, MatchAgents } from './types.ts'

export type BenchmarkPair = {
  id: string
  agents: MatchAgents
}

export const DEFAULT_BENCHMARK_PAIRS: BenchmarkPair[] = [
  { id: 'random_vs_random', agents: { black: 'random', white: 'random' } },
  {
    id: 'max_flip_vs_random',
    agents: { black: 'max_flip', white: 'random' },
  },
  {
    id: 'random_vs_max_flip',
    agents: { black: 'random', white: 'max_flip' },
  },
  {
    id: 'max_flip_vs_max_flip',
    agents: { black: 'max_flip', white: 'max_flip' },
  },
]

export type BenchmarkOptions = {
  matchesPerPair: number
  /** 共通シード群の起点。pair ごとに seedBase+i を使う */
  seedBase: number
  cooldownMs: number
  thinkDelayMs: number
  pairs?: BenchmarkPair[]
  recordReplayForSeeds?: number[]
}

export type PairAggregate = {
  id: string
  agents: MatchAgents
  matches: number
  blackWins: number
  whiteWins: number
  draws: number
  truncated: number
  totalBlackStones: number
  totalWhiteStones: number
  totalSuccessfulMovesBlack: number
  totalSuccessfulMovesWhite: number
  totalElapsedMs: number
  endReasons: Record<string, number>
  simultaneousConflicts: number
  otherIllegalRequests: number
  wallMs: number
  steps: number
}

export type BenchmarkReport = {
  generatedAt: string
  options: BenchmarkOptions
  note: string
  pairs: PairAggregate[]
  totals: {
    matches: number
    truncated: number
    wallMs: number
    steps: number
    stepsPerWallSecond: number | null
  }
  matches: CpuMatchResult[]
}

function emptyAggregate(pair: BenchmarkPair): PairAggregate {
  return {
    id: pair.id,
    agents: pair.agents,
    matches: 0,
    blackWins: 0,
    whiteWins: 0,
    draws: 0,
    truncated: 0,
    totalBlackStones: 0,
    totalWhiteStones: 0,
    totalSuccessfulMovesBlack: 0,
    totalSuccessfulMovesWhite: 0,
    totalElapsedMs: 0,
    endReasons: {},
    simultaneousConflicts: 0,
    otherIllegalRequests: 0,
    wallMs: 0,
    steps: 0,
  }
}

export function runBenchmark(options: BenchmarkOptions): BenchmarkReport {
  const pairs = options.pairs ?? DEFAULT_BENCHMARK_PAIRS
  const replaySeeds = new Set(options.recordReplayForSeeds ?? [])
  const allMatches: CpuMatchResult[] = []
  const aggregates = pairs.map(emptyAggregate)

  const wallStart = performance.now()

  for (let p = 0; p < pairs.length; p += 1) {
    const pair = pairs[p]!
    const agg = aggregates[p]!
    for (let i = 0; i < options.matchesPerPair; i += 1) {
      const seed = options.seedBase + i
      const result = runCpuMatch({
        seed,
        cooldownMs: options.cooldownMs,
        blackThinkDelayMs: options.thinkDelayMs,
        whiteThinkDelayMs: options.thinkDelayMs,
        agents: pair.agents,
        recordRequests: replaySeeds.has(seed),
      })
      allMatches.push(result)

      agg.matches += 1
      if (result.truncated) agg.truncated += 1
      else if (result.outcome === 'black_win') agg.blackWins += 1
      else if (result.outcome === 'white_win') agg.whiteWins += 1
      else if (result.outcome === 'draw') agg.draws += 1

      agg.totalBlackStones += result.stoneCounts.black
      agg.totalWhiteStones += result.stoneCounts.white
      agg.totalSuccessfulMovesBlack += result.successfulMoves.black
      agg.totalSuccessfulMovesWhite += result.successfulMoves.white
      agg.totalElapsedMs += result.elapsedMs
      const reason = result.truncated
        ? 'truncated_safety'
        : (result.endReason ?? 'unknown')
      agg.endReasons[reason] = (agg.endReasons[reason] ?? 0) + 1
      agg.simultaneousConflicts += result.simultaneousConflicts
      agg.otherIllegalRequests += result.otherIllegalRequests
      agg.wallMs += result.wallMs
      agg.steps += result.stepCount
    }
  }

  const totalWall = performance.now() - wallStart
  const totalSteps = aggregates.reduce((s, a) => s + a.steps, 0)

  return {
    generatedAt: new Date().toISOString(),
    options,
    note:
      'CPU同士・同一時間条件での傾向確認であり、対人勝率や強さの確定評価ではない。',
    pairs: aggregates,
    totals: {
      matches: aggregates.reduce((s, a) => s + a.matches, 0),
      truncated: aggregates.reduce((s, a) => s + a.truncated, 0),
      wallMs: totalWall,
      steps: totalSteps,
      stepsPerWallSecond:
        totalWall > 0 ? totalSteps / (totalWall / 1000) : null,
    },
    matches: allMatches,
  }
}

export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines: string[] = []
  lines.push('# 自動対戦ベースライン')
  lines.push('')
  lines.push(`生成日時: ${report.generatedAt}`)
  lines.push('')
  lines.push(report.note)
  lines.push('')
  lines.push('## 条件')
  lines.push('')
  lines.push(`- 組み合わせ数: ${report.pairs.length}`)
  lines.push(`- 各組み合わせ試合数: ${report.options.matchesPerPair}`)
  lines.push(`- 合計試合数: ${report.totals.matches}`)
  lines.push(`- シード群: ${report.options.seedBase} 〜 ${report.options.seedBase + report.options.matchesPerPair - 1}（各組み合わせで共通）`)
  lines.push(`- クールタイム: 双方 ${report.options.cooldownMs} ms`)
  lines.push(`- 判断待ち: 双方 ${report.options.thinkDelayMs} ms`)
  lines.push(`- 固定ステップ: ${GAME_CONFIG.stepMs} ms`)
  lines.push(`- 制限時間: ${GAME_CONFIG.matchDurationMs} ms`)
  lines.push('')
  lines.push('## 全体')
  lines.push('')
  lines.push(`- 処理実時間: ${report.totals.wallMs.toFixed(1)} ms`)
  lines.push(`- 総ステップ数: ${report.totals.steps}`)
  lines.push(
    `- 1秒あたりステップ数: ${
      report.totals.stepsPerWallSecond === null
        ? '（計測不能）'
        : report.totals.stepsPerWallSecond.toFixed(1)
    }`,
  )
  lines.push(`- 安全上限による中断: ${report.totals.truncated}`)
  lines.push('')

  for (const pair of report.pairs) {
    lines.push(`## ${pair.id}`)
    lines.push('')
    lines.push(
      `- 黒: ${labelOf(pair.agents.black)} / 白: ${labelOf(pair.agents.white)}`,
    )
    lines.push(`- 試合数: ${pair.matches}（うち truncate ${pair.truncated}）`)
    lines.push(
      `- 黒勝ち / 白勝ち / 引分: ${pair.blackWins} / ${pair.whiteWins} / ${pair.draws}`,
    )
    lines.push(
      `- 平均最終石数（黒/白）: ${(pair.totalBlackStones / pair.matches).toFixed(1)} / ${(pair.totalWhiteStones / pair.matches).toFixed(1)}`,
    )
    lines.push(
      `- 平均着手成功（黒/白）: ${(pair.totalSuccessfulMovesBlack / pair.matches).toFixed(1)} / ${(pair.totalSuccessfulMovesWhite / pair.matches).toFixed(1)}`,
    )
    lines.push(
      `- 平均ゲーム内時間: ${(pair.totalElapsedMs / pair.matches).toFixed(0)} ms`,
    )
    lines.push(
      `- 終了理由: ${Object.entries(pair.endReasons)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    )
    lines.push(`- 同時着手競合による不成立: ${pair.simultaneousConflicts}`)
    lines.push(`- 競合以外の不正要求: ${pair.otherIllegalRequests}`)
    lines.push(`- 組み合わせ処理実時間: ${pair.wallMs.toFixed(1)} ms`)
    lines.push('')
  }

  return lines.join('\n')
}

function labelOf(id: CpuTypeId): string {
  if (id === 'random') return 'ランダム型'
  if (id === 'max_flip') return '即時反転数優先型'
  if (id === 'ga_best' || id.startsWith('ga_g')) return 'GA育成'
  return id
}

export function writeBenchmarkOutputs(
  report: BenchmarkReport,
  outDir: string,
): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, 'benchmark-latest.json')
  const mdPath = join(outDir, 'benchmark-latest.md')
  // 巨大な requestRecords は JSON から省略し、必要なシードだけ残す
  const slim = {
    ...report,
    matches: report.matches.map((m) => ({
      ...m,
      requestRecords:
        m.requestRecords && m.requestRecords.length > 0
          ? m.requestRecords
          : null,
    })),
  }
  writeFileSync(jsonPath, JSON.stringify(slim, null, 2), 'utf8')
  writeFileSync(mdPath, formatBenchmarkMarkdown(report), 'utf8')
  return { jsonPath, mdPath }
}

export function defaultOutDir(fromCwd = process.cwd()): string {
  return join(fromCwd, 'docs', 'benchmark-output')
}

export { dirname }
