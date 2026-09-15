import { listLegalMoves } from '../game/board.ts'
import type { Rng } from '../game/rng.ts'
import type { PublicMatchState, Stone } from '../game/types.ts'
import type { CpuAgent, CpuDecision } from './types.ts'

function pickRandom<T>(items: readonly T[], rng: Rng): T {
  return items[rng.nextInt(0, items.length)]!
}

export const randomCpu: CpuAgent = {
  id: 'random',
  label: 'ランダム型',
  decide(
    publicState: PublicMatchState,
    rng: Rng,
    stone: Stone,
  ): CpuDecision {
    if (publicState.phase !== 'playing') return { type: 'wait' }
    if (publicState.cooldowns[stone] > 0) return { type: 'wait' }

    const moves = listLegalMoves(publicState.board, stone)
    if (moves.length === 0) return { type: 'wait' }

    const pick = pickRandom(moves, rng)
    return { type: 'move', row: pick.row, col: pick.col }
  },
}
