import { collectFlips, listLegalMoves } from '../game/board.ts'
import type { Rng } from '../game/rng.ts'
import type { Coord, PublicMatchState, Stone } from '../game/types.ts'
import type { CpuAgent, CpuDecision } from './types.ts'

function pickRandom<T>(items: readonly T[], rng: Rng): T {
  return items[rng.nextInt(0, items.length)]!
}

export const maxFlipCpu: CpuAgent = {
  id: 'max_flip',
  label: '即時反転数優先型',
  decide(
    publicState: PublicMatchState,
    rng: Rng,
    stone: Stone,
  ): CpuDecision {
    if (publicState.phase !== 'playing') return { type: 'wait' }
    if (publicState.cooldowns[stone] > 0) return { type: 'wait' }

    const moves = listLegalMoves(publicState.board, stone)
    if (moves.length === 0) return { type: 'wait' }

    let bestCount = -1
    const best: Coord[] = []
    for (const move of moves) {
      const count = collectFlips(
        publicState.board,
        move.row,
        move.col,
        stone,
      ).length
      if (count > bestCount) {
        bestCount = count
        best.length = 0
        best.push(move)
      } else if (count === bestCount) {
        best.push(move)
      }
    }

    const pick = pickRandom(best, rng)
    return { type: 'move', row: pick.row, col: pick.col }
  },
}
