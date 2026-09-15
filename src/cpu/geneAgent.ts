import { decideWithGenesSimple } from '../ga/geneCpu.ts'
import type { Rng } from '../game/rng.ts'
import type { PublicMatchState, Stone } from '../game/types.ts'
import type { CpuAgent, CpuDecision, CpuTypeId } from './types.ts'

export function createGeneCpu(options: {
  id: CpuTypeId
  label: string
  genes: readonly number[]
}): CpuAgent {
  const genes = options.genes.slice()
  return {
    id: options.id,
    label: options.label,
    decide(
      publicState: PublicMatchState,
      rng: Rng,
      stone: Stone,
    ): CpuDecision {
      const d = decideWithGenesSimple(genes, publicState, stone, rng)
      if (d.type === 'move') {
        return { type: 'move', row: d.row, col: d.col }
      }
      return { type: 'wait' }
    },
  }
}
