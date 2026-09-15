import { GAME_CONFIG } from '../game/config.ts'
import {
  countStones,
  hasLegalMove,
  inBounds,
  listLegalMoves,
} from '../game/board.ts'
import { oppositeStone } from '../game/rng.ts'
import type { Board, Stone } from '../game/types.ts'
import { FEATURE_COUNT } from './constants.ts'

const CORNERS: ReadonlyArray<Readonly<{ row: number; col: number }>> = [
  { row: 0, col: 0 },
  { row: 0, col: 9 },
  { row: 9, col: 0 },
  { row: 9, col: 9 },
]

const X_SQUARES: ReadonlyArray<
  Readonly<{ corner: { row: number; col: number }; x: { row: number; col: number } }>
> = [
  { corner: { row: 0, col: 0 }, x: { row: 1, col: 1 } },
  { corner: { row: 0, col: 9 }, x: { row: 1, col: 8 } },
  { corner: { row: 9, col: 0 }, x: { row: 8, col: 1 } },
  { corner: { row: 9, col: 9 }, x: { row: 8, col: 8 } },
]

const DIRS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
] as const

function isCorner(row: number, col: number): boolean {
  return (
    (row === 0 || row === 9) && (col === 0 || col === 9)
  )
}

function isEdgeExcludingCorner(row: number, col: number): boolean {
  if (isCorner(row, col)) return false
  return row === 0 || row === 9 || col === 0 || col === 9
}

function hasEmptyNeighbor(board: Board, row: number, col: number): boolean {
  for (const [dr, dc] of DIRS) {
    const r = row + dr
    const c = col + dc
    if (inBounds(r, c) && board[r]![c] === null) return true
  }
  return false
}

/**
 * 12特徴量。自分視点。
 * WAIT 用の項目10–12は isWait / public 情報から付与する。
 */
export function computeBoardFeatures(
  board: Board,
  me: Stone,
): number[] {
  const opp = oppositeStone(me)
  const counts = countStones(board)
  const myStones = me === 'black' ? counts.black : counts.white
  const oppStones = me === 'black' ? counts.white : counts.black

  let myCorners = 0
  let oppCorners = 0
  for (const { row, col } of CORNERS) {
    const cell = board[row]![col]
    if (cell === me) myCorners += 1
    else if (cell === opp) oppCorners += 1
  }

  const myMob = listLegalMoves(board, me).length
  const oppMob = listLegalMoves(board, opp).length

  let myAdjEmpty = 0
  let oppAdjEmpty = 0
  for (let row = 0; row < GAME_CONFIG.boardSize; row += 1) {
    for (let col = 0; col < GAME_CONFIG.boardSize; col += 1) {
      const cell = board[row]![col]
      if (cell === me && hasEmptyNeighbor(board, row, col)) myAdjEmpty += 1
      if (cell === opp && hasEmptyNeighbor(board, row, col)) oppAdjEmpty += 1
    }
  }

  let myX = 0
  let oppX = 0
  for (const { corner, x } of X_SQUARES) {
    if (board[corner.row]![corner.col] !== null) continue
    const cell = board[x.row]![x.col]
    if (cell === me) myX += 1
    else if (cell === opp) oppX += 1
  }

  let myEdge = 0
  let oppEdge = 0
  for (let row = 0; row < GAME_CONFIG.boardSize; row += 1) {
    for (let col = 0; col < GAME_CONFIG.boardSize; col += 1) {
      if (!isEdgeExcludingCorner(row, col)) continue
      const cell = board[row]![col]
      if (cell === me) myEdge += 1
      else if (cell === opp) oppEdge += 1
    }
  }

  const features = [
    (myStones - oppStones) / 100, // 1
    (myCorners - oppCorners) / 4, // 2
    myMob / 100, // 3
    oppMob / 100, // 4
    myAdjEmpty / 100, // 5
    oppAdjEmpty / 100, // 6
    myX / 4, // 7
    oppX / 4, // 8
    (myEdge - oppEdge) / 32, // 9
    0, // 10 WAIT flag — filled by caller
    0, // 11
    0, // 12
  ]
  if (features.length !== FEATURE_COUNT) {
    throw new Error('feature count mismatch')
  }
  return features
}

export function attachWaitFeatures(
  boardFeatures: number[],
  options: {
    isWait: boolean
    opponentCooldownMs: number
    remainingMatchMs: number
  },
): number[] {
  const f = boardFeatures.slice()
  f[9] = options.isWait ? 1 : 0
  f[10] = options.isWait
    ? options.opponentCooldownMs / GAME_CONFIG.cooldownMs
    : 0
  f[11] = options.isWait
    ? options.remainingMatchMs / GAME_CONFIG.matchDurationMs
    : 0
  return f
}

/** 着手前盤面の進行度。全候補で同じ値を使う。 */
export function phaseProgress(board: Board): number {
  const { black, white } = countStones(board)
  const total = black + white
  const p = (total - 16) / 84
  return Math.min(1, Math.max(0, p))
}

export function hasAnyLegal(board: Board, stone: Stone): boolean {
  return hasLegalMove(board, stone)
}
