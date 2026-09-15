/**
 * MCTS を対戦場に出すための包み。
 *
 * 本番対戦（限られた探索量）と育成（大量探索）で同じ実装を使い、
 * simulations だけを変えて比較できるようにする。
 */
import type { Rng } from '../../game/rng.ts'
import type { AgentSpec } from '../arena/arena.ts'
import type { FastAgent } from '../sim/fastMatch.ts'
import { createRolloutValue, heuristicPolicy, heuristicValue, uniformPolicy } from './heuristics.ts'
import { Mcts, type MctsConfig, type PolicyFn, type ValueFn } from './mcts.ts'

export type MctsAgentOptions = {
  id: string
  label: string
  config?: Partial<MctsConfig>
  policy?: PolicyFn
  value?: ValueFn
  /** value を rng から作る場合（ランダムプレイアウト）。value より優先する */
  valueFactory?: (rng: Rng) => ValueFn
}

export function createMctsAgent(options: MctsAgentOptions): FastAgent {
  let engine: Mcts | null = null
  let boundRng: Rng | null = null

  return {
    id: options.id,
    decide(match, side, rng) {
      if (!engine || (options.valueFactory && boundRng !== rng)) {
        boundRng = rng
        engine = new Mcts({
          config: options.config,
          policy: options.policy ?? heuristicPolicy,
          value: options.valueFactory
            ? options.valueFactory(rng)
            : (options.value ?? heuristicValue),
        })
      }
      return engine.search(match, side, rng)
    },
  }
}

export function mctsAgentSpec(options: MctsAgentOptions): AgentSpec {
  return {
    id: options.id,
    label: options.label,
    create: () => createMctsAgent(options),
  }
}

/** Phase 4 の比較対象（学習前の MCTS 各種） */
export function phase4Specs(): AgentSpec[] {
  const specs: AgentSpec[] = []

  for (const sims of [64, 256, 1024]) {
    specs.push(
      mctsAgentSpec({
        id: `mcts_rollout_${sims}`,
        label: `MCTS 一様+プレイアウト ${sims}`,
        config: { simulations: sims, allowWait: false },
        policy: uniformPolicy,
        valueFactory: (rng) => createRolloutValue(rng),
      }),
    )
    specs.push(
      mctsAgentSpec({
        id: `mcts_heur_${sims}`,
        label: `MCTS 静的評価 ${sims}`,
        config: { simulations: sims, allowWait: false },
        policy: heuristicPolicy,
        value: heuristicValue,
      }),
    )
  }

  specs.push(
    mctsAgentSpec({
      id: 'mcts_heur_256_wait',
      label: 'MCTS 静的評価 256（待機あり）',
      config: { simulations: 256, allowWait: true },
      policy: heuristicPolicy,
      value: heuristicValue,
    }),
  )

  return specs
}
