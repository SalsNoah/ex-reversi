import { createGeneCpu } from './geneAgent.ts'
import {
  GA_MILESTONES,
  strongestMilestone,
  type GaMilestone,
} from './gaMilestones.ts'
import type { CpuAgent, CpuTypeId } from './types.ts'

function labelOf(m: GaMilestone, strongest: boolean): string {
  if (strongest) {
    return `GA育成（第${m.generation}世代・最強）`
  }
  return `GA育成（第${m.generation}世代）`
}

const strongest = strongestMilestone()

export const gaMilestoneCpus: CpuAgent[] = GA_MILESTONES.map((m) =>
  createGeneCpu({
    id: m.id,
    label: labelOf(m, m.id === strongest.id),
    genes: m.genes,
  }),
)

export const gaBestCpu: CpuAgent = createGeneCpu({
  id: 'ga_best',
  label: labelOf(strongest, true),
  genes: strongest.genes,
})

export function resolveCpuType(id: CpuTypeId): CpuTypeId {
  if (id === 'ga_best') return strongest.id
  return id
}
