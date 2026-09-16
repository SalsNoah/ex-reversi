import { annCpu } from './ann/annCpu.ts'
import { gaBestCpu, gaMilestoneCpus } from './gaAgents.ts'
import {
  GA_MILESTONES,
} from './gaMilestones.ts'
import { maxFlipCpu } from './maxFlipCpu.ts'
import { randomCpu } from './randomCpu.ts'
import { alphaCpu, betaCpu, strategyCpu } from './strategy/index.ts'
import { waitCpu } from './waitCpu.ts'
import type { CpuAgent, CpuTypeId } from './types.ts'

export type { CpuAgent, CpuDecision, CpuTypeId } from './types.ts'
export {
  boardSignature,
  createIdleThinkGate,
  tickThinkGate,
} from './thinkGate.ts'
export type { ThinkGateState } from './thinkGate.ts'
export { gaBestCpu, gaMilestoneCpus, resolveCpuType } from './gaAgents.ts'
export { GA_BEST_GENES, GA_BEST_META } from './gaBestGenes.ts'
export {
  GA_MILESTONES,
  strongestMilestone,
  type GaMilestone,
  type GaMilestoneId,
} from './gaMilestones.ts'
export { ANN_SIMULATIONS, annCpu, createAnnCpu } from './ann/annCpu.ts'
export { maxFlipCpu } from './maxFlipCpu.ts'
export { randomCpu } from './randomCpu.ts'
export { waitCpu } from './waitCpu.ts'
export {
  ALPHA_LEVEL,
  BETA_LEVEL,
  MASTER_LEVEL,
  alphaCpu,
  betaCpu,
  createAlphaCpu,
  createBetaCpu,
  createStrategyCpu,
  decideStrategyMove,
  strategyCpu,
  type StrategyLevel,
} from './strategy/index.ts'

const MILESTONE_AGENTS: Record<string, CpuAgent> = {}
for (const agent of gaMilestoneCpus) {
  MILESTONE_AGENTS[agent.id] = agent
}

const AGENTS: Record<string, CpuAgent> = {
  ann: annCpu,
  alpha: alphaCpu,
  beta: betaCpu,
  strategy: strategyCpu,
  ga_best: gaBestCpu,
  random: randomCpu,
  max_flip: maxFlipCpu,
  wait: waitCpu,
  ...MILESTONE_AGENTS,
}

export function getCpuAgent(id: CpuTypeId): CpuAgent {
  const agent = AGENTS[id]
  if (!agent) {
    throw new Error(`unknown cpu type: ${id}`)
  }
  return agent
}

export const CPU_OPTIONS: ReadonlyArray<{ id: CpuTypeId; label: string }> = [
  // 強さを裏取りできている最新の名前付き個体を先頭＝既定の対戦相手にする
  { id: 'beta', label: betaCpu.label },
  { id: 'alpha', label: alphaCpu.label },
  { id: 'strategy', label: strategyCpu.label },
  { id: 'ann', label: annCpu.label },
  ...[...gaMilestoneCpus]
    .sort((a, b) => {
      const ga = GA_MILESTONES.find((m) => m.id === a.id)?.generation ?? 0
      const gb = GA_MILESTONES.find((m) => m.id === b.id)?.generation ?? 0
      return gb - ga
    })
    .map((a) => ({ id: a.id, label: a.label })),
  { id: 'random', label: randomCpu.label },
  { id: 'max_flip', label: maxFlipCpu.label },
]
