/**
 * 「ベータ」= アルファに全滅の余裕を足し、直接対戦で明確に勝ち越した構成。
 *
 * アルファ（23時固定）を上書きせず、新しい名前でゲームに載せる。
 * 変えるときは、過去の名前付き個体すべてに明確に勝ち越した実測を
 * docs/strategy-ai.md に残してからにする（仕様 2.9）。
 *
 * 2026-09-15 の裏取り（docs/strategy-ai.md）:
 * - アルファ（同じ探索量・60戦・黒白交互）に **48勝12敗（80.0%・平均石差 +7.5）**
 *   Wilson 95% 下限 66.7% > 50%。両側二項検定 p ≈ 3×10^-6
 * - GA 代表 5 体・各24戦（120戦）で 112勝8敗（93.3%）
 * - 850ms の `max_flip` は 46.7% → 60.0%（アルファ比）
 * - 1 手の所要は同じ実行の A/B で +2%
 */
import type { CpuAgent } from '../types.ts'
import { buildWeightTables, type WeightSpec } from './evaluate.ts'
import { ALPHA_LEVEL, ALPHA_WEIGHT_SPEC } from './alphaCpu.ts'
import { createStrategyCpu, type StrategyLevel } from './strategyCpu.ts'

/**
 * ベータの評価重み。アルファと同じ着手可能数 1.5 倍に、
 * 相手の 1 手で全部返る形への罰（重み 1200）を足した。
 *
 * 同じ探索量での直接対戦が 48勝12敗。これはアルファを定義した
 * 着手可能数 1.5 倍（49勝11敗）と同じ水準の裏取りである。
 */
export const BETA_WEIGHT_SPEC: WeightSpec = {
  ...ALPHA_WEIGHT_SPEC,
  wipeout: 1_200,
  // 相手の 2 手先を見る項はこの個体には無い。後から足した版はガンマ
  wipeout2: 0,
}

export const BETA_WEIGHTS = buildWeightTables(BETA_WEIGHT_SPEC)

export const BETA_LEVEL: StrategyLevel = {
  ...ALPHA_LEVEL,
  weights: BETA_WEIGHTS,
}

export function createBetaCpu(): CpuAgent {
  return createStrategyCpu({ id: 'beta', label: 'ベータ', level: BETA_LEVEL })
}

export const betaCpu: CpuAgent = createBetaCpu()
