/**
 * 「イプシロン」= デルタから C 打ちの罰をさらに 2 倍にし、石数の重みを半分にした構成。
 *
 * アルファ〜デルタは上書きせず、新しい名前でゲームに載せる。
 * 変えるときは、過去の名前付き個体すべてに明確に勝ち越した実測を
 * docs/strategy-ai.md に残してからにする（仕様 2.9）。
 *
 * 2026-09-16 の裏取り（docs/strategy-ai.md）。同速・黒白交互・各60戦:
 * - デルタに **44勝16敗**（73.3%・Wilson 95% 下限 61.0%）
 * - ガンマに **58勝0敗2分**（得点率 98.3%）
 * - ベータに **60勝0敗**、アルファに **60勝0敗**
 * - GA 代表 5 体・各24戦（120戦）で 112勝8敗（93.3%）
 * - 700ms / 850ms の `max_flip` に 60.0% / 63.3%（歴代で最も高い）
 *
 * **2 つの変更は単独ではガンマに勝てない。** C 打ちだけだと 32勝28敗、
 * 石数だけだと 21勝39敗。合わせて初めて 58勝0敗2分になる。
 * ガンマ（着手可能数だけを極端に上げた個体）は、単項の変更では抜けない壁だった。
 */
import type { CpuAgent } from '../types.ts'
import { buildWeightTables, type WeightSpec } from './evaluate.ts'
import { DELTA_LEVEL, DELTA_WEIGHT_SPEC } from './deltaCpu.ts'
import { createStrategyCpu, type StrategyLevel } from './strategyCpu.ts'

/** デルタからの倍率。既定に対しては C 打ち 4 倍・石数 0.5 倍 */
const CSQUARE_GAIN = 2
const DISC_GAIN = 0.5

function scale(
  phase: WeightSpec['opening'],
): WeightSpec['opening'] {
  return {
    ...phase,
    cSquare: phase.cSquare * CSQUARE_GAIN,
    disc: phase.disc * DISC_GAIN,
  }
}

/**
 * イプシロンの評価重み。既定からの通算は
 * 着手可能数 4.5 倍・C 打ち 4 倍・石数 0.5 倍（序盤 C 打ち 152 / 石数 0.5）。
 *
 * C 打ちの罰がここで初めて X 打ち（115/90/25）を超える。
 * 通説とは逆だが、この 10×10・実時間のゲームでは**角の隣に打たされないこと**が
 * X 打ちを避けること以上に効いた、と見ている（確かめてはいない）。
 *
 * 石数を下げるのは、ゲーム後半まで石を増やさない方が着手可能数を保てるため。
 * 終局の勝敗は `terminalScore` が別に見ているので、評価の石数を下げても
 * 「勝ちを取りこぼす」向きには働かない。
 */
export const EPSILON_WEIGHT_SPEC: WeightSpec = {
  ...DELTA_WEIGHT_SPEC,
  opening: scale(DELTA_WEIGHT_SPEC.opening),
  midgame: scale(DELTA_WEIGHT_SPEC.midgame),
  endgame: scale(DELTA_WEIGHT_SPEC.endgame),
}

export const EPSILON_WEIGHTS = buildWeightTables(EPSILON_WEIGHT_SPEC)

export const EPSILON_LEVEL: StrategyLevel = {
  ...DELTA_LEVEL,
  weights: EPSILON_WEIGHTS,
}

export function createEpsilonCpu(): CpuAgent {
  return createStrategyCpu({
    id: 'epsilon',
    label: 'イプシロン',
    level: EPSILON_LEVEL,
  })
}

export const epsilonCpu: CpuAgent = createEpsilonCpu()
