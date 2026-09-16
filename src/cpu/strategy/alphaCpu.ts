/**
 * 「アルファ」= 2026-09-15 23時に裏取りしてゲームへ載せた構成。
 *
 * `strategyCpu` は開発中の現行版で、調整のたびに中身が動く。
 * こちらは画面から選ぶ対戦相手として固定しておきたいので、
 * 設定値を `MASTER_LEVEL` から広げずに、この場に数値で書き出す。
 *
 * この個体のあとに明確に勝ち越した版は、アルファを上書きせず
 * ベータ以降として残す（仕様 2.9）。
 *
 * 2026-09-15 23時の裏取り（docs/strategy-ai.md）:
 * - 着手可能数を変える前の構成に、同じ探索量・60戦で 49勝11敗
 * - GA 代表 5 体（第20/40/60/80/100世代）各24戦・計120戦で 111勝8敗1分（92.9%）
 * - 1 手の探索時間は平均 45ms / p95 99ms（50ms ステップ内で同期実行）
 *
 * 全滅の余裕（`wipeout`）は持たない。後から足した版はベータ。
 */
import { GAME_CONFIG } from '../../game/config.ts'
import type { CpuAgent } from '../types.ts'
import {
  DEFAULT_WEIGHT_SPEC,
  buildWeightTables,
  type WeightSpec,
} from './evaluate.ts'
import { createStrategyCpu, type StrategyLevel } from './strategyCpu.ts'

/**
 * アルファの評価重み。既定から着手可能数だけ 1.5 倍にしてある。
 *
 * 1 項ずつ増減して既定と当てる `strategy:tune` で見つけた
 * （探索 3500 ノード・80戦で 2 倍が 62勝14敗4分）。
 * 本番のノード上限 14000・60戦でも 1.5 倍が **49勝11敗（平均石差 +24.1）**。
 * 読みの量を 4 倍にしても 6 割止まりだったのに対し、こちらは 8 割を超える。
 * このゲームでは読みを増やすより、相手の選択肢を減らす側に寄せた方が効く。
 */
const MOBILITY_GAIN = 1.5

export const ALPHA_WEIGHT_SPEC: WeightSpec = {
  ...DEFAULT_WEIGHT_SPEC,
  opening: {
    ...DEFAULT_WEIGHT_SPEC.opening,
    mobility: DEFAULT_WEIGHT_SPEC.opening.mobility * MOBILITY_GAIN,
  },
  midgame: {
    ...DEFAULT_WEIGHT_SPEC.midgame,
    mobility: DEFAULT_WEIGHT_SPEC.midgame.mobility * MOBILITY_GAIN,
  },
  endgame: {
    ...DEFAULT_WEIGHT_SPEC.endgame,
    mobility: DEFAULT_WEIGHT_SPEC.endgame.mobility * MOBILITY_GAIN,
  },
  // 23時時点の評価にこれらの項は無い。省略すると開発中の既定が乗るので明示する
  wipeout: 0,
  wipeout2: 0,
}

export const ALPHA_WEIGHTS = buildWeightTables(ALPHA_WEIGHT_SPEC)

export const ALPHA_LEVEL: StrategyLevel = {
  maxDepth: 64,
  nodeBudget: 14_000,
  // 手番前の下読みは実装済みだが、対戦で負け越したので切っている
  ponderStepNodes: 0,
  opponentIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
  opponentReactionMs: GAME_CONFIG.cpuThinkDelayMs,
  adaptPace: true,
  weights: ALPHA_WEIGHTS,
}

/** 相手ペースの推定を実体ごとに持つので、両側に置くときは別々に作る */
export function createAlphaCpu(): CpuAgent {
  return createStrategyCpu({ id: 'alpha', label: 'アルファ', level: ALPHA_LEVEL })
}

export const alphaCpu: CpuAgent = createAlphaCpu()
