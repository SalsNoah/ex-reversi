/**
 * 探索専用の高速盤面。ルール層（src/game/board.ts）とは別表現だが、
 * 合法手・反転の結果は完全に一致させる（strategy.test.ts で照合）。
 *
 * 10×10 の周囲に番兵を 1 マス足した 12×12 の一次元配列で持ち、
 * 盤外判定を分岐なしで済ませる。
 */
import { GAME_CONFIG } from '../../game/config.ts'
import type { Board, Stone } from '../../game/types.ts'

export const N = GAME_CONFIG.boardSize
export const W = N + 2
export const CELL_COUNT = W * W
/** 空きマス双方向リストの番兵 */
export const EMPTY_HEAD = CELL_COUNT

export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2
export const BORDER = 3

export const DIRS = new Int32Array([
  -W - 1,
  -W,
  -W + 1,
  -1,
  1,
  W - 1,
  W,
  W + 1,
])

/** 盤内 100 マスの一次元添字 */
export const PLAYABLE = buildPlayable()

function buildPlayable(): Int32Array {
  const list = new Int32Array(N * N)
  let k = 0
  for (let row = 0; row < N; row += 1) {
    for (let col = 0; col < N; col += 1) {
      list[k] = (row + 1) * W + (col + 1)
      k += 1
    }
  }
  return list
}

export function cellIndex(row: number, col: number): number {
  return (row + 1) * W + (col + 1)
}

export function rowOf(index: number): number {
  return ((index / W) | 0) - 1
}

export function colOf(index: number): number {
  return (index % W) - 1
}

export function colorOf(stone: Stone): number {
  return stone === 'black' ? BLACK : WHITE
}

export function opponentColor(color: number): number {
  return color ^ 3
}

const ZOBRIST_A = new Int32Array(CELL_COUNT * 4)
const ZOBRIST_B = new Int32Array(CELL_COUNT * 4)
fillZobrist()

function fillZobrist(): void {
  let s = 0x9e3779b9 | 0
  const next = (): number => {
    s ^= s << 13
    s |= 0
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return s
  }
  for (let i = 0; i < ZOBRIST_A.length; i += 1) {
    ZOBRIST_A[i] = next()
    ZOBRIST_B[i] = next()
  }
}

/** 探索中に何度も使い回す可変盤面 */
export type FastPosition = {
  cells: Uint8Array
  emptyNext: Int32Array
  emptyPrev: Int32Array
  emptyCount: number
  /**
   * 隣接 8 マスにある石の数。反転では増減しないので、着手のたびに
   * 置いたマスの周り 8 つを足し引きするだけで保てる。
   * 0 のマスはどちらの色も置けず、開放度にも効かないので走査を省ける。
   */
  adjacent: Uint8Array
  black: number
  white: number
  hashA: number
  hashB: number
  /** 反転済みマスの履歴（undo 用の LIFO スタック） */
  flips: Int32Array
  flipTop: number
}

/** 1 手の最大反転数は 8 方向 × 8 枚 */
const MAX_FLIPS_PER_MOVE = 64
const FLIP_STACK_SIZE = MAX_FLIPS_PER_MOVE * (N * N + 8)

export function createFastPosition(): FastPosition {
  return {
    cells: new Uint8Array(CELL_COUNT),
    emptyNext: new Int32Array(CELL_COUNT + 1),
    emptyPrev: new Int32Array(CELL_COUNT + 1),
    emptyCount: 0,
    adjacent: new Uint8Array(CELL_COUNT),
    black: 0,
    white: 0,
    hashA: 0,
    hashB: 0,
    flips: new Int32Array(FLIP_STACK_SIZE),
    flipTop: 0,
  }
}

export function loadBoard(pos: FastPosition, board: Board): void {
  const cells = pos.cells
  const adjacent = pos.adjacent
  cells.fill(BORDER)
  adjacent.fill(0)
  let black = 0
  let white = 0
  let hashA = 0
  let hashB = 0
  let prev = EMPTY_HEAD
  let emptyCount = 0

  for (let k = 0; k < PLAYABLE.length; k += 1) {
    const index = PLAYABLE[k]
    const row = ((index / W) | 0) - 1
    const col = (index % W) - 1
    const cell = board[row][col]
    if (cell === 'black') {
      cells[index] = BLACK
      black += 1
      hashA ^= ZOBRIST_A[index * 4 + BLACK]
      hashB ^= ZOBRIST_B[index * 4 + BLACK]
    } else if (cell === 'white') {
      cells[index] = WHITE
      white += 1
      hashA ^= ZOBRIST_A[index * 4 + WHITE]
      hashB ^= ZOBRIST_B[index * 4 + WHITE]
    } else {
      cells[index] = EMPTY
      pos.emptyNext[prev] = index
      pos.emptyPrev[index] = prev
      prev = index
      emptyCount += 1
      continue
    }
    for (let d = 0; d < 8; d += 1) adjacent[index + DIRS[d]] += 1
  }

  pos.emptyNext[prev] = EMPTY_HEAD
  pos.emptyPrev[EMPTY_HEAD] = prev
  pos.emptyCount = emptyCount
  pos.black = black
  pos.white = white
  pos.hashA = hashA
  pos.hashB = hashB
  pos.flipTop = 0
}

/** 合法手を out[offset..] に詰めて件数を返す */
export function generateMoves(
  pos: FastPosition,
  color: number,
  out: Int32Array,
  offset: number,
): number {
  const cells = pos.cells
  const next = pos.emptyNext
  const adjacent = pos.adjacent
  const opp = color ^ 3
  let n = 0

  for (let i = next[EMPTY_HEAD]; i !== EMPTY_HEAD; i = next[i]) {
    if (adjacent[i] === 0) continue
    for (let d = 0; d < 8; d += 1) {
      const dir = DIRS[d]
      let j = i + dir
      if (cells[j] !== opp) continue
      do {
        j += dir
      } while (cells[j] === opp)
      if (cells[j] === color) {
        out[offset + n] = i
        n += 1
        break
      }
    }
  }
  return n
}

export function countMobility(pos: FastPosition, color: number): number {
  const cells = pos.cells
  const next = pos.emptyNext
  const adjacent = pos.adjacent
  const opp = color ^ 3
  let n = 0

  for (let i = next[EMPTY_HEAD]; i !== EMPTY_HEAD; i = next[i]) {
    if (adjacent[i] === 0) continue
    for (let d = 0; d < 8; d += 1) {
      const dir = DIRS[d]
      let j = i + dir
      if (cells[j] !== opp) continue
      do {
        j += dir
      } while (cells[j] === opp)
      if (cells[j] === color) {
        n += 1
        break
      }
    }
  }
  return n
}

export function hasMoves(pos: FastPosition, color: number): boolean {
  const cells = pos.cells
  const next = pos.emptyNext
  const adjacent = pos.adjacent
  const opp = color ^ 3

  for (let i = next[EMPTY_HEAD]; i !== EMPTY_HEAD; i = next[i]) {
    if (adjacent[i] === 0) continue
    for (let d = 0; d < 8; d += 1) {
      const dir = DIRS[d]
      let j = i + dir
      if (cells[j] !== opp) continue
      do {
        j += dir
      } while (cells[j] === opp)
      if (cells[j] === color) return true
    }
  }
  return false
}

/** 着手して反転枚数を返す。undoMove と必ず対で呼ぶ */
export function doMove(
  pos: FastPosition,
  index: number,
  color: number,
): number {
  const cells = pos.cells
  const flips = pos.flips
  const opp = color ^ 3
  const base = pos.flipTop
  let top = base

  for (let d = 0; d < 8; d += 1) {
    const dir = DIRS[d]
    let j = index + dir
    if (cells[j] !== opp) continue
    do {
      j += dir
    } while (cells[j] === opp)
    if (cells[j] !== color) continue
    j -= dir
    while (j !== index) {
      flips[top] = j
      top += 1
      j -= dir
    }
  }

  const count = top - base
  let hashA = pos.hashA
  let hashB = pos.hashB

  for (let k = base; k < top; k += 1) {
    const j = flips[k]
    cells[j] = color
    hashA ^= ZOBRIST_A[j * 4 + opp] ^ ZOBRIST_A[j * 4 + color]
    hashB ^= ZOBRIST_B[j * 4 + opp] ^ ZOBRIST_B[j * 4 + color]
  }

  cells[index] = color
  hashA ^= ZOBRIST_A[index * 4 + color]
  hashB ^= ZOBRIST_B[index * 4 + color]

  const adjacent = pos.adjacent
  for (let d = 0; d < 8; d += 1) adjacent[index + DIRS[d]] += 1

  const prev = pos.emptyPrev[index]
  const nxt = pos.emptyNext[index]
  pos.emptyNext[prev] = nxt
  pos.emptyPrev[nxt] = prev
  pos.emptyCount -= 1

  if (color === BLACK) {
    pos.black += count + 1
    pos.white -= count
  } else {
    pos.white += count + 1
    pos.black -= count
  }

  pos.flipTop = top
  pos.hashA = hashA
  pos.hashB = hashB
  return count
}

export function undoMove(
  pos: FastPosition,
  index: number,
  color: number,
  count: number,
): void {
  const cells = pos.cells
  const flips = pos.flips
  const opp = color ^ 3
  const top = pos.flipTop
  const base = top - count
  let hashA = pos.hashA
  let hashB = pos.hashB

  for (let k = base; k < top; k += 1) {
    const j = flips[k]
    cells[j] = opp
    hashA ^= ZOBRIST_A[j * 4 + opp] ^ ZOBRIST_A[j * 4 + color]
    hashB ^= ZOBRIST_B[j * 4 + opp] ^ ZOBRIST_B[j * 4 + color]
  }

  cells[index] = EMPTY
  hashA ^= ZOBRIST_A[index * 4 + color]
  hashB ^= ZOBRIST_B[index * 4 + color]

  const adjacent = pos.adjacent
  for (let d = 0; d < 8; d += 1) adjacent[index + DIRS[d]] -= 1

  // unlink 時に index 自身のリンクは壊していないので、そのまま戻せる
  const prev = pos.emptyPrev[index]
  const nxt = pos.emptyNext[index]
  pos.emptyNext[prev] = index
  pos.emptyPrev[nxt] = index
  pos.emptyCount += 1

  if (color === BLACK) {
    pos.black -= count + 1
    pos.white += count
  } else {
    pos.white -= count + 1
    pos.black += count
  }

  pos.flipTop = base
  pos.hashA = hashA
  pos.hashB = hashB
}
