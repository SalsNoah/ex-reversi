/**
 * ニューラルネット無しで MCTS を動かすための事前確率と価値。
 *
 * Phase 4 の比較用。ここが Phase 5〜7 で学習済みネットに置き換わる。
 * 既存の静的評価（src/cpu/strategy/evaluate.ts）を流用し、二重実装を避ける。
 */
import { BLACK, cellIndex } from '../../cpu/strategy/fastBoard.ts'
import { evaluate } from '../../cpu/strategy/evaluate.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import type { Rng } from '../../game/rng.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'
import { countFlipsAt } from '../agents/baselines.ts'
import {
  ACTION_TO_CELL,
  OUTCOME_BLACK_WIN,
  OUTCOME_WHITE_WIN,
  OUT_CAN_ACT,
  OUT_SIZE,
  OUT_THINK_READY,
  PHASE_FINISHED,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_COOLDOWN,
  TS_PHASE,
  TS_SIZE,
  advanceToDecision,
  applyFastStep,
  colorOfSide,
  lastStepUndo,
  listLegalActions,
  outcomeOf,
  restoreTimeState,
  saveTimeState,
  undoAppliedMoves,
  type FastMatch,
} from '../sim/fastMatch.ts'
import type { PolicyFn, ValueFn } from './mcts.ts'

/**
 * 静的評価を [-1, 1] に写すための、進行度ごとの目安（標準偏差）。
 *
 * 実局面 14823 サンプルで測った値（tmp 計測、docs/ai-experiments.md に記録）。
 * 序盤は着手可能数の振れで大きく、中盤で小さく、終盤は石差で再び大きくなる。
 * 進行度で割り直さないと tanh がほぼ 0 に潰れて、価値が探索に効かなくなる。
 */
const PHASE_SD = [2805, 751, 343, 1260]
const SD_MULTIPLIER = 1.5
const VALUE_SCALE_TABLE = buildValueScaleTable()

function buildValueScaleTable(): Float64Array {
  const startDiscs = 16
  const size = GAME_CONFIG.boardSize * GAME_CONFIG.boardSize - startDiscs + 1
  const table = new Float64Array(size)
  const centers = PHASE_SD.map((_, i) => (i + 0.5) / PHASE_SD.length)
  for (let i = 0; i < size; i += 1) {
    const progress = i / (size - 1)
    let sd: number
    if (progress <= centers[0]!) sd = PHASE_SD[0]!
    else if (progress >= centers[centers.length - 1]!) {
      sd = PHASE_SD[PHASE_SD.length - 1]!
    } else {
      let k = 0
      while (k < centers.length - 2 && progress > centers[k + 1]!) k += 1
      const t = (progress - centers[k]!) / (centers[k + 1]! - centers[k]!)
      sd = PHASE_SD[k]! + (PHASE_SD[k + 1]! - PHASE_SD[k]!) * t
    }
    table[i] = 1 / (sd * SD_MULTIPLIER)
  }
  return table
}

/** 黒視点の静的評価を勝率っぽい値にする */
export const heuristicValue: ValueFn = (match: FastMatch): number => {
  if (match.ts[TS_PHASE] === PHASE_FINISHED) {
    const outcome = outcomeOf(match)
    if (outcome === OUTCOME_BLACK_WIN) return 1
    if (outcome === OUTCOME_WHITE_WIN) return -1
    return 0
  }
  // selfTurn は偶数理論にしか使われない。次に動けるのが黒かどうかで決める
  const blackSooner =
    match.ts[TS_COOLDOWN + SIDE_BLACK]! <= match.ts[TS_COOLDOWN + SIDE_WHITE]!
  const raw = evaluate(match.pos, BLACK, blackSooner)
  let slot = match.pos.black + match.pos.white - 16
  if (slot < 0) slot = 0
  else if (slot >= VALUE_SCALE_TABLE.length) slot = VALUE_SCALE_TABLE.length - 1
  return Math.tanh(raw * VALUE_SCALE_TABLE[slot]!)
}

/** 一様分布。MCTS 単体の素の強さを見るときに使う */
export const uniformPolicy: PolicyFn = (
  _match,
  _side,
  _actions,
  count,
  priors,
): void => {
  const p = 1 / count
  for (let k = 0; k < count; k += 1) priors[k] = p
}

/** 手順付け用の静的なマス価値（search.ts と同じ考え方の表） */
const SQUARE_VALUE = buildSquareValue()

function buildSquareValue(): Float32Array {
  const n = GAME_CONFIG.boardSize
  const quarter = [
    [120, -25, 12, 6, 4],
    [-25, -60, -4, -3, -3],
    [12, -4, 4, 1, 1],
    [6, -3, 1, 1, 0],
    [4, -3, 1, 0, 1],
  ]
  const table = new Float32Array(1024)
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const r = row < n / 2 ? row : n - 1 - row
      const c = col < n / 2 ? col : n - 1 - col
      table[cellIndex(row, col)] = quarter[r]![c]!
    }
  }
  return table
}

/**
 * マス価値と「相手の着手可能数を減らすか」から事前確率を作る。
 * 学習済み Policy が無い間の代用。
 */
export const heuristicPolicy: PolicyFn = (
  match,
  side,
  actions,
  count,
  priors,
): void => {
  const cells = match.pos.cells
  const color = colorOfSide(side)
  const logits = scratchLogits
  let max = -Infinity

  for (let k = 0; k < count; k += 1) {
    const action = actions[k]!
    if (action === WAIT_ACTION) {
      // 待機は基本的に損。わずかな確率だけ残す
      logits[k] = -3
      if (logits[k]! > max) max = logits[k]!
      continue
    }
    const cell = ACTION_TO_CELL[action]!
    const flips = countFlipsAt(cells, cell, color)
    // たくさん返す手は開放度が悪くなりやすい（オセロの基本）
    const score = SQUARE_VALUE[cell]! * 0.02 - flips * 0.06
    logits[k] = score
    if (score > max) max = score
  }

  let sum = 0
  for (let k = 0; k < count; k += 1) {
    const e = Math.exp(logits[k]! - max)
    priors[k] = e
    sum += e
  }
  for (let k = 0; k < count; k += 1) priors[k] = priors[k]! / sum
}

const scratchLogits = new Float64Array(101)

/**
 * ランダムプレイアウト。純 MCTS（Policy/Value 無し）の比較用。
 * 盤面と時間状態を必ず元へ戻す。
 */
export function createRolloutValue(rng: Rng, maxSteps = 200): ValueFn {
  const actionBuf = new Int32Array(128)
  const savedTime = new Int32Array(TS_SIZE * (maxSteps + 2))
  const savedOut = new Int32Array(OUT_SIZE)
  const undoCount = new Int32Array(maxSteps + 2)
  const undoCells = new Int32Array((maxSteps + 2) * 2)
  const undoColors = new Int32Array((maxSteps + 2) * 2)
  const undoFlips = new Int32Array((maxSteps + 2) * 2)

  return (match: FastMatch): number => {
    if (match.ts[TS_PHASE] === PHASE_FINISHED) {
      const outcome = outcomeOf(match)
      if (outcome === OUTCOME_BLACK_WIN) return 1
      if (outcome === OUTCOME_WHITE_WIN) return -1
      return 0
    }
    savedOut.set(match.out)

    let depth = 0
    while (depth < maxSteps && match.ts[TS_PHASE] !== PHASE_FINISHED) {
      saveTimeState(match, savedTime, depth * TS_SIZE)
      const out = match.out
      let actionBlack = WAIT_ACTION
      let actionWhite = WAIT_ACTION
      for (const side of [SIDE_BLACK, SIDE_WHITE]) {
        if (out[OUT_CAN_ACT + side] !== 1 || out[OUT_THINK_READY + side] !== 1) {
          continue
        }
        const n = listLegalActions(match, side, actionBuf)
        if (n === 0) continue
        const pick = actionBuf[rng.nextInt(0, n)]!
        if (side === SIDE_BLACK) actionBlack = pick
        else actionWhite = pick
      }
      applyFastStep(match, actionBlack, actionWhite)
      undoCount[depth] = lastStepUndo.count
      for (let k = 0; k < lastStepUndo.count; k += 1) {
        undoCells[depth * 2 + k] = lastStepUndo.cells[k]!
        undoColors[depth * 2 + k] = lastStepUndo.colors[k]!
        undoFlips[depth * 2 + k] = lastStepUndo.flips[k]!
      }
      advanceToDecision(match)
      depth += 1
    }

    let result: number
    if (match.ts[TS_PHASE] === PHASE_FINISHED) {
      const outcome = outcomeOf(match)
      result = outcome === OUTCOME_BLACK_WIN ? 1 : outcome === OUTCOME_WHITE_WIN ? -1 : 0
    } else {
      result = match.pos.black > match.pos.white ? 1 : match.pos.black < match.pos.white ? -1 : 0
    }

    for (let slot = depth - 1; slot >= 0; slot -= 1) {
      undoAppliedMoves(
        match,
        undoCount[slot]!,
        undoCells,
        undoColors,
        undoFlips,
        slot * 2,
      )
      restoreTimeState(match, savedTime, slot * TS_SIZE)
    }
    match.out.set(savedOut)
    return result
  }
}
