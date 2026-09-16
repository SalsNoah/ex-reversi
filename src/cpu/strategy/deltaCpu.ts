/**
 * 「デルタ」= ガンマの C 打ちの罰を 2 倍にし、2 手先の全滅を見るようにした構成。
 *
 * アルファ・ベータ・ガンマは上書きせず、新しい名前でゲームに載せる。
 * 変えるときは、過去の名前付き個体すべてに明確に勝ち越した実測を
 * docs/strategy-ai.md に残してからにする（仕様 2.9）。
 *
 * 2026-09-16 の裏取り（docs/strategy-ai.md）:
 * - ガンマ・ベータ・アルファに、同速60戦で **すべて 60勝0敗**（計180勝0敗）
 * - GA 代表 5 体・各24戦（120戦）で 114勝6敗（95.0%）
 * - 最速 700ms / 850ms の `max_flip` に 60.0% / 60.0%。ガンマは 55.0% / 55.0%
 *
 * 2 つの変更は**単独ではどちらも速い相手に負け越す**（C打ちだけだと 48.3%、
 * 2手先の全滅だけだと 46.7%）。両方入れて初めて 60.0% になる。
 */
import type { CpuAgent } from '../types.ts'
import { buildWeightTables, type WeightSpec } from './evaluate.ts'
import { GAMMA_LEVEL, GAMMA_WEIGHT_SPEC } from './gammaCpu.ts'
import { createStrategyCpu, type StrategyLevel } from './strategyCpu.ts'

/** ガンマからの倍率。既定に対しては 2 倍（序盤 76 / 中盤 60 / 終盤 16） */
const CSQUARE_GAIN = 2

/**
 * デルタの評価重み。ガンマとの違いは C 打ちの罰と 2 手先の全滅だけ。
 *
 * `cSquare` は「角が空いている間、自分が C 打ちしていると減点」。倍率を上げると
 * C 打ちを強く避ける。既定の 38 は X 打ちの 115 に比べて小さすぎた。
 * 2 倍（76）にしても X 打ちより小さいので、オセロの通説（C 打ちは X 打ちほど悪くない）
 * とは矛盾しない。
 *
 * 本番ノード上限 14000 のガンマ基準の掃引では、ほかに潜在着手×2（対ガンマ 60勝0敗）・
 * 着手可能数×2（同）・石数×0.5（同）も勝ったが、過去の名前付き個体すべてに
 * 60勝0敗だったのは C 打ちだけだった。まとめて動かすと逆に弱くなる（45勝15敗）。
 */
export const DELTA_WEIGHT_SPEC: WeightSpec = {
  ...GAMMA_WEIGHT_SPEC,
  opening: {
    ...GAMMA_WEIGHT_SPEC.opening,
    cSquare: GAMMA_WEIGHT_SPEC.opening.cSquare * CSQUARE_GAIN,
  },
  midgame: {
    ...GAMMA_WEIGHT_SPEC.midgame,
    cSquare: GAMMA_WEIGHT_SPEC.midgame.cSquare * CSQUARE_GAIN,
  },
  endgame: {
    ...GAMMA_WEIGHT_SPEC.endgame,
    cSquare: GAMMA_WEIGHT_SPEC.endgame.cSquare * CSQUARE_GAIN,
  },
  wipeout2: 6_000,
}

export const DELTA_WEIGHTS = buildWeightTables(DELTA_WEIGHT_SPEC)

export const DELTA_LEVEL: StrategyLevel = {
  ...GAMMA_LEVEL,
  weights: DELTA_WEIGHTS,
}

export function createDeltaCpu(): CpuAgent {
  return createStrategyCpu({ id: 'delta', label: 'デルタ', level: DELTA_LEVEL })
}

export const deltaCpu: CpuAgent = createDeltaCpu()
