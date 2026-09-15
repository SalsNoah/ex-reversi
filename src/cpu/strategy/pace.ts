/**
 * 相手の着手ペースの推定。
 *
 * 探索は「次に着手できる時刻が早い側が手番」で読む（`search.ts`）。
 * そこで使う相手の着手間隔を固定値にすると、想定が外れたときに大きく損をする。
 *
 * - 速い相手（待ち時間 700ms だけで打つ人）を 1200ms と見なすと、
 *   回ってこない手番を当てにして読むため、連打で潰される
 * - 遅い相手（CPU と同じ 1200ms）を 700ms と見なすと、
 *   取れるはずの手を取らずに守りすぎる
 *
 * どちらも実測で負け越しが出たので、相手の速さは決め打ちせず観測する。
 * 使うのは公開情報（盤面と試合内経過時間）だけで、実時計は見ない。
 */
import { GAME_CONFIG } from '../../game/config.ts'
import type { Board } from '../../game/types.ts'

const SIZE = GAME_CONFIG.boardSize
const CELLS = SIZE * SIZE

/** 1 観測ごとに古い分へ掛ける係数。半減期は約 4 観測（およそ 5 秒） */
const DECAY = 0.85

/** これだけ相手の着手を見るまでは既定の想定を使う */
const MIN_OBSERVED_MOVES = 2

/**
 * 推定値の上限。相手が本当に遅くても、ここより遅いとは見なさない。
 * 遅いと見すぎると「相手が打つ前に自分が 2 回打てる」という前提で読み、
 * 外れたときの損が大きいため、自分の間隔の 2 倍で止める。
 */
const MAX_INTERVAL_MS = 2 * (GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs)

/** 推定値の刻み。細かく揺らすと同じ局面でも読みが変わって落ち着かない */
const QUANTUM_MS = 50

export type PaceTracker = {
  /** 直前に見た盤面の占有（0=空き, 1=石）。空き→石だけを着手として数える */
  seen: Uint8Array
  /** seen の石数。試合が変わったことを見分けるために持つ */
  seenDiscs: number
  initialized: boolean
  lastElapsedMs: number
  /** 自分が直前に返した着手のマス。相手の着手と区別するために覚える */
  ownMoveCell: number
  /** 減衰付きの相手着手数と、その観測に対応する経過時間 */
  weightedMoves: number
  weightedTimeMs: number
}

export type PaceEstimate = {
  intervalMs: number
  reactionMs: number
  /** 観測に基づく値か（false なら既定の想定を返している） */
  measured: boolean
}

export function createPaceTracker(): PaceTracker {
  return {
    seen: new Uint8Array(CELLS),
    seenDiscs: 0,
    initialized: false,
    lastElapsedMs: 0,
    ownMoveCell: -1,
    weightedMoves: 0,
    weightedTimeMs: 0,
  }
}

export function resetPaceTracker(tracker: PaceTracker): void {
  tracker.seen.fill(0)
  tracker.seenDiscs = 0
  tracker.initialized = false
  tracker.lastElapsedMs = 0
  tracker.ownMoveCell = -1
  tracker.weightedMoves = 0
  tracker.weightedTimeMs = 0
}

/** 自分が返した着手を覚える。次の観測で相手の着手と取り違えないため */
export function notePlayedMove(
  tracker: PaceTracker,
  row: number,
  col: number,
): void {
  tracker.ownMoveCell = row * SIZE + col
}

/**
 * 盤面を 1 枚前と比べ、相手が何手打ったかと、その間の経過時間を積む。
 *
 * 石は返っても増えないので、「空きだったマスが石になった」数がそのまま着手数。
 * 自分の着手が返されて色が変わっていても、空き→石の判定なら取りこぼさない。
 */
export function observePace(
  tracker: PaceTracker,
  board: Board,
  elapsedMs: number,
  defaultIntervalMs: number,
  defaultReactionMs: number,
): PaceEstimate {
  // 試合が変わったら測り直す。試合内時間は開始で 0 に戻り、
  // 石は 1 試合のあいだ減らない（返っても数は変わらない）ので、
  // どちらかが巻き戻っていれば別の試合だと分かる。
  if (
    !tracker.initialized ||
    elapsedMs < tracker.lastElapsedMs ||
    countDiscs(board) < tracker.seenDiscs
  ) {
    resetPaceTracker(tracker)
    snapshot(tracker, board)
    tracker.initialized = true
    tracker.lastElapsedMs = elapsedMs
    return {
      intervalMs: defaultIntervalMs,
      reactionMs: defaultReactionMs,
      measured: false,
    }
  }

  let opponentMoves = 0
  let discs = 0
  for (let row = 0; row < SIZE; row += 1) {
    const line = board[row]
    for (let col = 0; col < SIZE; col += 1) {
      const index = row * SIZE + col
      const occupied = line[col] === null ? 0 : 1
      if (occupied === 1) {
        discs += 1
        if (tracker.seen[index] === 0) {
          if (index === tracker.ownMoveCell) tracker.ownMoveCell = -1
          else opponentMoves += 1
        }
      }
      tracker.seen[index] = occupied
    }
  }
  tracker.seenDiscs = discs

  const deltaMs = elapsedMs - tracker.lastElapsedMs
  tracker.lastElapsedMs = elapsedMs
  if (deltaMs > 0) {
    tracker.weightedMoves = tracker.weightedMoves * DECAY + opponentMoves
    tracker.weightedTimeMs = tracker.weightedTimeMs * DECAY + deltaMs
  }

  return currentPace(tracker, defaultIntervalMs, defaultReactionMs)
}

/** 観測を進めずに、いまの推定値だけを読む（手番前の下読み用） */
export function currentPace(
  tracker: PaceTracker,
  defaultIntervalMs: number,
  defaultReactionMs: number,
): PaceEstimate {
  if (tracker.weightedMoves < MIN_OBSERVED_MOVES) {
    return {
      intervalMs: defaultIntervalMs,
      reactionMs: defaultReactionMs,
      measured: false,
    }
  }

  const raw = tracker.weightedTimeMs / tracker.weightedMoves
  const clamped = Math.min(Math.max(raw, GAME_CONFIG.cooldownMs), MAX_INTERVAL_MS)
  const intervalMs = Math.round(clamped / QUANTUM_MS) * QUANTUM_MS
  return {
    intervalMs,
    reactionMs: intervalMs - GAME_CONFIG.cooldownMs,
    measured: true,
  }
}

function snapshot(tracker: PaceTracker, board: Board): void {
  let discs = 0
  for (let row = 0; row < SIZE; row += 1) {
    const line = board[row]
    for (let col = 0; col < SIZE; col += 1) {
      const occupied = line[col] === null ? 0 : 1
      tracker.seen[row * SIZE + col] = occupied
      discs += occupied
    }
  }
  tracker.seenDiscs = discs
}

function countDiscs(board: Board): number {
  let discs = 0
  for (let row = 0; row < SIZE; row += 1) {
    const line = board[row]
    for (let col = 0; col < SIZE; col += 1) {
      if (line[col] !== null) discs += 1
    }
  }
  return discs
}
