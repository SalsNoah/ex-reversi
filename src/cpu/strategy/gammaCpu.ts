/**
 * 「ガンマ」= ベータの着手可能数を 3 倍にして、直接対戦で完封した構成。
 *
 * アルファ・ベータは上書きせず、新しい名前でゲームに載せる。
 * 変えるときは、過去の名前付き個体すべてに明確に勝ち越した実測を
 * docs/strategy-ai.md に残してからにする（仕様 2.9）。
 *
 * 2026-09-16 の裏取り（docs/strategy-ai.md）:
 * - ベータ（同じ探索量・60戦・黒白交互）に **60勝0敗（平均石差 +33.6）**
 * - アルファ（同上）に **50勝10敗（83.3%・平均石差 +20.2）** Wilson 95% 下限 71.9%
 * - GA 代表 5 体・各24戦（120戦）で 115勝5敗（95.8%）。ベータは 93.3%
 * - 850ms の `max_flip` は 45.5% → 55.0%（ベータ比）
 *
 * 同じ個体どうしを当てた対照は 30勝30敗（50.0%）で、対戦装置に偏りはない。
 */
import type { CpuAgent } from '../types.ts'
import { buildWeightTables, type WeightSpec } from './evaluate.ts'
import { BETA_LEVEL, BETA_WEIGHT_SPEC } from './betaCpu.ts'
import { createStrategyCpu, type StrategyLevel } from './strategyCpu.ts'

/** ベータからの倍率。既定に対しては 4.5 倍（序盤 1800 / 中盤 1350 / 終盤 405） */
const MOBILITY_GAIN = 3

/**
 * ガンマの評価重み。ベータとの違いは着手可能数だけ。
 *
 * 本番ノード上限 14000 での 1 項掃引で見つけた。倍率ごとの勝敗（対ベータ・各60戦）は
 * 1.25倍 22勝38敗 / 1.5倍 30勝30敗 / 2倍 48勝12敗 / **3倍 60勝0敗** /
 * 4倍 60勝0敗 / 6倍 45勝15敗 / 8倍 42勝18敗。3倍と4倍を当てると 3倍が 60勝0敗。
 *
 * 軽い探索（3500 ノード）では 2 倍止まりに見えるので、**本番ノード数で測ること**。
 * 同じ掃引で角 0.5倍・X打ち 2倍は軽い探索で勝ち、本番では負けた。
 */
export const GAMMA_WEIGHT_SPEC: WeightSpec = {
  ...BETA_WEIGHT_SPEC,
  opening: {
    ...BETA_WEIGHT_SPEC.opening,
    mobility: BETA_WEIGHT_SPEC.opening.mobility * MOBILITY_GAIN,
  },
  midgame: {
    ...BETA_WEIGHT_SPEC.midgame,
    mobility: BETA_WEIGHT_SPEC.midgame.mobility * MOBILITY_GAIN,
  },
  endgame: {
    ...BETA_WEIGHT_SPEC.endgame,
    mobility: BETA_WEIGHT_SPEC.endgame.mobility * MOBILITY_GAIN,
  },
}

export const GAMMA_WEIGHTS = buildWeightTables(GAMMA_WEIGHT_SPEC)

export const GAMMA_LEVEL: StrategyLevel = {
  ...BETA_LEVEL,
  weights: GAMMA_WEIGHTS,
}

export function createGammaCpu(): CpuAgent {
  return createStrategyCpu({ id: 'gamma', label: 'ガンマ', level: GAMMA_LEVEL })
}

export const gammaCpu: CpuAgent = createGammaCpu()
