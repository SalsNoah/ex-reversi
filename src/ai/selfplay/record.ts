/**
 * 自己対戦の棋譜形式。
 *
 * 局面そのものは持たず「シード + 各意思決定点で両者が要求した行動」だけ持つ。
 * 高速シミュレータは決定的なので、これだけで全局面・全時間状態を再現できる。
 * 特徴量の設計を変えてもデータを作り直さずに済む。
 *
 * 1 行 1 局の JSONL。
 */
import type { FastMatchConfig } from '../sim/fastMatch.ts'

export type SelfPlaySample = {
  /** steps の添字 */
  i: number
  /** 探索した側（0=黒, 1=白） */
  s: number
  /** 探索対象の行動（100 は自発待機） */
  a: number[]
  /** MCTS の訪問回数（Policy Target の素） */
  n: number[]
  /** root の推定値（黒視点 [-1, 1]） */
  v: number
  /** 実行シミュレーション数 */
  sims: number
  /** 到達した最大段数 */
  d: number
  /** 使ったノード数 */
  k: number
  /** 無操作 3 秒で着手が差し替わったか */
  f?: 1
}

export type SelfPlayRecord = {
  v: 1
  seed: number
  decisionSeed: number
  /** 側ごとの判断待ち（多様性のため試合ごとに変える場合がある） */
  think: [number, number]
  /** エンジン識別（黒, 白） */
  eng: [string, string]
  /** 各意思決定点で両者が要求した行動 */
  steps: Array<[number, number]>
  samples: SelfPlaySample[]
  /** 0=黒勝ち, 1=白勝ち, 2=引分 */
  outcome: number
  endReason: number
  black: number
  white: number
  elapsedMs: number
  moves: number
}

export function recordConfig(record: SelfPlayRecord): Partial<FastMatchConfig> {
  return { thinkDelayMs: [record.think[0], record.think[1]] }
}
