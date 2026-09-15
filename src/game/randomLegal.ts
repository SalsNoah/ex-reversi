import { listLegalMoves } from './board.ts'
import type { Coord, Board, Stone } from './types.ts'
import type { Rng } from './rng.ts'

export function pickRandomLegalMove(
  board: Board,
  stone: Stone,
  rng: Rng,
): Coord | undefined {
  const moves = listLegalMoves(board, stone)
  if (moves.length === 0) return undefined
  return moves[rng.nextInt(0, moves.length)]!
}
