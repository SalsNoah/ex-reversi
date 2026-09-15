import { GAME_CONFIG } from './config.ts'
import type { Board, Cell, Coord, Stone, StoneCounts } from './types.ts'

const DIRECTIONS: ReadonlyArray<Readonly<{ dr: number; dc: number }>> = [
  { dr: -1, dc: -1 },
  { dr: -1, dc: 0 },
  { dr: -1, dc: 1 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 },
  { dr: 1, dc: -1 },
  { dr: 1, dc: 0 },
  { dr: 1, dc: 1 },
]

export function createEmptyBoard(size = GAME_CONFIG.boardSize): Board {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null as Cell),
  )
}

/**
 * 中央4×4を市松模様で配置。左上 (centerMin, centerMin) は黒。
 * (row + col) が偶数なら黒、奇数なら白。
 */
export function createInitialBoard(size = GAME_CONFIG.boardSize): Board {
  const board = createEmptyBoard(size)
  const { centerMin, centerMax } = GAME_CONFIG

  for (let row = centerMin; row <= centerMax; row += 1) {
    for (let col = centerMin; col <= centerMax; col += 1) {
      board[row]![col] = (row + col) % 2 === 0 ? 'black' : 'white'
    }
  }

  return board
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice())
}

export function inBounds(
  row: number,
  col: number,
  size = GAME_CONFIG.boardSize,
): boolean {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    col >= 0 &&
    row < size &&
    col < size
  )
}

export function countStones(board: Board): StoneCounts {
  let black = 0
  let white = 0
  let empty = 0

  for (const row of board) {
    for (const cell of row) {
      if (cell === 'black') black += 1
      else if (cell === 'white') white += 1
      else empty += 1
    }
  }

  return { black, white, empty }
}

function opponentOf(stone: Stone): Stone {
  return stone === 'black' ? 'white' : 'black'
}

/**
 * 指定方向で挟める相手石の座標一覧。
 * 空きを挟んだ先や、自分の石で閉じていない列は空配列。
 * 盤外へは進まない（行・列の回り込みなし）。
 */
export function collectFlipsInDirection(
  board: Board,
  row: number,
  col: number,
  stone: Stone,
  dr: number,
  dc: number,
): Coord[] {
  const opponent = opponentOf(stone)
  const flips: Coord[] = []
  let r = row + dr
  let c = col + dc

  while (inBounds(r, c)) {
    const cell = board[r]![c]
    if (cell === opponent) {
      flips.push({ row: r, col: c })
      r += dr
      c += dc
      continue
    }
    if (cell === stone) {
      return flips
    }
    // 空き、または想定外 → この方向は不成立
    return []
  }

  // 盤外に出た＝自分の石で閉じていない
  return []
}

export function collectFlips(
  board: Board,
  row: number,
  col: number,
  stone: Stone,
): Coord[] {
  const flips: Coord[] = []
  for (const { dr, dc } of DIRECTIONS) {
    flips.push(...collectFlipsInDirection(board, row, col, stone, dr, dc))
  }
  return flips
}

export function isLegalMove(
  board: Board,
  row: number,
  col: number,
  stone: Stone,
): boolean {
  if (!inBounds(row, col)) return false
  if (board[row]![col] !== null) return false
  return collectFlips(board, row, col, stone).length > 0
}

export function listLegalMoves(board: Board, stone: Stone): Coord[] {
  const moves: Coord[] = []
  const size = board.length

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (isLegalMove(board, row, col, stone)) {
        moves.push({ row, col })
      }
    }
  }

  return moves
}

export function hasLegalMove(board: Board, stone: Stone): boolean {
  const size = board.length
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (isLegalMove(board, row, col, stone)) return true
    }
  }
  return false
}

export type PlaceStoneResult =
  | { ok: true; board: Board; flipped: Coord[] }
  | {
      ok: false
      reason: 'out_of_bounds' | 'occupied' | 'illegal'
    }

/** 盤面のみの着手。待ち時間や試合状態は触らない。 */
export function placeStone(
  board: Board,
  row: number,
  col: number,
  stone: Stone,
): PlaceStoneResult {
  if (!inBounds(row, col)) {
    return { ok: false, reason: 'out_of_bounds' }
  }
  if (board[row]![col] !== null) {
    return { ok: false, reason: 'occupied' }
  }

  const flipped = collectFlips(board, row, col, stone)
  if (flipped.length === 0) {
    return { ok: false, reason: 'illegal' }
  }

  const next = cloneBoard(board)
  next[row]![col] = stone
  for (const pos of flipped) {
    next[pos.row]![pos.col] = stone
  }

  return { ok: true, board: next, flipped }
}
