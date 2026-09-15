import { listLegalMoves } from '../game/board.ts'
import { GAME_CONFIG } from '../game/config.ts'
import type { MatchState, MoveRequest, Stone } from '../game/types.ts'
import { ACTION_SPACE_SIZE, WAIT_ACTION } from './constants.ts'
import type { ActionMask } from './types.ts'

export function actionToCoord(action: number): { row: number; col: number } | null {
  if (action < 0 || action >= WAIT_ACTION) return null
  return {
    row: Math.floor(action / GAME_CONFIG.boardSize),
    col: action % GAME_CONFIG.boardSize,
  }
}

export function coordToAction(row: number, col: number): number {
  return row * GAME_CONFIG.boardSize + col
}

export function actionToMoveRequest(action: number): MoveRequest | undefined {
  const coord = actionToCoord(action)
  if (!coord) return undefined
  return { row: coord.row, col: coord.col }
}

/**
 * 今選べる行動マスク（合法手 ∩ 時間条件）。
 * 終局後はすべて false（着手処理を進めない前提で呼び出し側が step を止める）。
 */
export function buildActionMask(
  match: MatchState,
  stone: Stone,
  thinkReady: boolean,
): ActionMask {
  const mask = Array.from({ length: ACTION_SPACE_SIZE }, () => false)

  if (match.phase !== 'playing') {
    return mask
  }

  const canPlace =
    match.cooldowns[stone] === 0 &&
    thinkReady &&
    listLegalMoves(match.board, stone).length > 0

  if (!canPlace) {
    mask[WAIT_ACTION] = true
    return mask
  }

  for (const move of listLegalMoves(match.board, stone)) {
    mask[coordToAction(move.row, move.col)] = true
  }
  mask[WAIT_ACTION] = true
  return mask
}

export function isWaitAction(action: number): boolean {
  return action === WAIT_ACTION
}
