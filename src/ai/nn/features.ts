/**
 * Policy / Value ネットワークの入力特徴量。
 *
 * 方針:
 * - すべて「自分視点」で作る。盤面・クールタイムを入れ替えるだけで色が反転するので、
 *   1 つのネットを黒白どちらでも使えて、学習データも両視点ぶん使える。
 * - 盤面は疎な二値特徴（立っている添字だけ渡す）。全結合の 1 層目を
 *   立っている特徴の数（実測 70 前後）ぶんだけの積和で済ませるため。
 * - 時間特徴は連続値。ここが「非同期・時間制約」を学習に載せる本体。
 *
 * 使える情報の範囲:
 *   画面（PublicMatchState + 自分のセッション）から復元できるものに限る。
 *   相手の判断待ち残量は仕様上非公開なので直接読まず、
 *   「最後に石が置かれてからの経過」から推定する（判断待ちは盤面変化で測り直すので、
 *   定常状態ではこの推定が実値と一致する）。
 */
import { BLACK, generateMoves } from '../../cpu/strategy/fastBoard.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import {
  ACTION_TO_CELL,
  CELL_TO_ACTION,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_COOLDOWN,
  TS_IDLE_REM,
  TS_LAST_CHANGE,
  TS_PRIORITY,
  TS_TIME,
  colorOfSide,
  type FastMatch,
} from '../sim/fastMatch.ts'

/** 1 平面のマス数（= 行動空間の着手部分） */
export const PLANE_SIZE = GAME_CONFIG.boardSize * GAME_CONFIG.boardSize

/** 盤面の平面（自分の石 / 相手の石 / 自分の合法手 / 相手の合法手） */
export const PLANE_COUNT = 4
export const SPARSE_FEATURE_COUNT = PLANE_COUNT * PLANE_SIZE

/** 時間・数え上げ系の連続値特徴 */
export const DENSE_OWN_COOLDOWN = 0
export const DENSE_OPP_COOLDOWN = 1
export const DENSE_OWN_READY = 2
export const DENSE_OPP_READY = 3
export const DENSE_TEMPO_GAP = 4
export const DENSE_SINCE_CHANGE = 5
export const DENSE_THINK_REM = 6
export const DENSE_OWN_IDLE = 7
export const DENSE_OPP_IDLE = 8
export const DENSE_MATCH_REMAIN = 9
export const DENSE_FILLED = 10
export const DENSE_STONE_DIFF = 11
export const DENSE_OWN_LEGAL = 12
export const DENSE_OPP_LEGAL = 13
export const DENSE_OWN_PRIORITY = 14
export const DENSE_FEATURE_COUNT = 15

/** 合法手数の正規化に使う目安 */
const LEGAL_SCALE = 20

/** 特徴量の書き込み先。使い回して確保を避ける */
export type FeatureBuffer = {
  /** 立っている疎特徴の添字 */
  sparse: Int32Array
  sparseCount: number
  dense: Float32Array
  /** 自分の合法手（action 値）。Policy のマスクに使う */
  ownActions: Int32Array
  ownActionCount: number
}

export function createFeatureBuffer(): FeatureBuffer {
  return {
    sparse: new Int32Array(SPARSE_FEATURE_COUNT),
    sparseCount: 0,
    dense: new Float32Array(DENSE_FEATURE_COUNT),
    ownActions: new Int32Array(PLANE_SIZE),
    ownActionCount: 0,
  }
}

const moveScratch = new Int32Array(256)

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** match を side 視点で符号化する。盤面・時間状態は書き換えない */
export function encodeFeatures(
  match: FastMatch,
  side: number,
  buf: FeatureBuffer,
): void {
  const pos = match.pos
  const ts = match.ts
  const cfg = match.config
  const cells = pos.cells
  const own = colorOfSide(side)
  const opp = own ^ 3
  const sparse = buf.sparse
  let n = 0

  // 石の平面（0: 自分 / 1: 相手）
  for (let action = 0; action < PLANE_SIZE; action += 1) {
    const v = cells[ACTION_TO_CELL[action]!]!
    if (v === own) {
      sparse[n] = action
      n += 1
    } else if (v === opp) {
      sparse[n] = PLANE_SIZE + action
      n += 1
    }
  }

  // 合法手の平面（2: 自分 / 3: 相手）
  const ownCount = generateMoves(pos, own, moveScratch, 0)
  const ownActions = buf.ownActions
  for (let k = 0; k < ownCount; k += 1) {
    const action = CELL_TO_ACTION[moveScratch[k]!]!
    ownActions[k] = action
    sparse[n] = 2 * PLANE_SIZE + action
    n += 1
  }
  buf.ownActionCount = ownCount

  const oppCount = generateMoves(pos, opp, moveScratch, 0)
  for (let k = 0; k < oppCount; k += 1) {
    sparse[n] = 3 * PLANE_SIZE + CELL_TO_ACTION[moveScratch[k]!]!
    n += 1
  }

  buf.sparseCount = n

  // --- 時間特徴 ---
  const dense = buf.dense
  const oppSide = side === SIDE_BLACK ? SIDE_WHITE : SIDE_BLACK
  const cooldownMs = cfg.cooldownMs
  const ownCd = ts[TS_COOLDOWN + side]!
  const oppCd = ts[TS_COOLDOWN + oppSide]!
  const now = ts[TS_TIME]!

  dense[DENSE_OWN_COOLDOWN] = ownCd / cooldownMs
  dense[DENSE_OPP_COOLDOWN] = oppCd / cooldownMs
  dense[DENSE_OWN_READY] = ownCd === 0 ? 1 : 0
  dense[DENSE_OPP_READY] = oppCd === 0 ? 1 : 0
  dense[DENSE_TEMPO_GAP] = (oppCd - ownCd) / cooldownMs

  const thinkDelay = Math.max(cfg.thinkDelayMs[0]!, cfg.thinkDelayMs[1]!, 1)
  const sinceChange = now - ts[TS_LAST_CHANGE]!
  dense[DENSE_SINCE_CHANGE] = Math.min(2, sinceChange / thinkDelay)
  dense[DENSE_THINK_REM] = clamp01((thinkDelay - sinceChange) / thinkDelay)

  const idleMs = cfg.idleAutoMoveMs
  const ownIdle = ts[TS_IDLE_REM + side]!
  const oppIdle = ts[TS_IDLE_REM + oppSide]!
  dense[DENSE_OWN_IDLE] = ownIdle < 0 ? 1 : ownIdle / idleMs
  dense[DENSE_OPP_IDLE] = oppIdle < 0 ? 1 : oppIdle / idleMs

  dense[DENSE_MATCH_REMAIN] = clamp01(
    (cfg.matchDurationMs - now) / cfg.matchDurationMs,
  )

  const ownStones = own === BLACK ? pos.black : pos.white
  const oppStones = own === BLACK ? pos.white : pos.black
  dense[DENSE_FILLED] = (ownStones + oppStones) / PLANE_SIZE
  dense[DENSE_STONE_DIFF] = (ownStones - oppStones) / PLANE_SIZE
  dense[DENSE_OWN_LEGAL] = Math.min(2, ownCount / LEGAL_SCALE)
  dense[DENSE_OPP_LEGAL] = Math.min(2, oppCount / LEGAL_SCALE)
  dense[DENSE_OWN_PRIORITY] = ts[TS_PRIORITY] === side ? 1 : 0
}
