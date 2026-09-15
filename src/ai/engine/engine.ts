/**
 * 探索エンジンの組み立て。
 *
 * 「静的評価 MCTS」「ランダムプレイアウト MCTS」「学習済みネット MCTS」を
 * 同じ 1 つの記述（EngineSpec）から作れるようにする。
 * 対戦場・自己対戦・パイプラインがすべてここを通るので、
 * Champion が静的評価でもネットでも同じ手順で扱える。
 */
import type { Rng } from '../../game/rng.ts'
import type { AgentSpec } from '../arena/arena.ts'
import {
  createRolloutValue,
  heuristicPolicy,
  heuristicValue,
  uniformPolicy,
} from '../mcts/heuristics.ts'
import { Mcts, type MctsConfig } from '../mcts/mcts.ts'
import { NnEvaluator } from '../nn/nnEval.ts'
import { loadNetwork } from '../nn/modelStore.ts'
import type { FastAgent } from '../sim/fastMatch.ts'

export type EngineKind = 'heuristic' | 'rollout' | 'nn'

export type EngineSpec = {
  id: string
  label: string
  kind: EngineKind
  /** kind === 'nn' のとき必須 */
  modelPath?: string
  /**
   * kind === 'nn' のときの事前確率の出どころ。
   * 'heuristic' にすると価値だけネットを使う（ネット方策が効いているかの切り分け用）。
   */
  policySource?: 'nn' | 'heuristic'
  mcts?: Partial<MctsConfig>
}

export type Engine = {
  mcts: Mcts
  /** ネットを使う場合だけ。試合の切り替えでキャッシュを捨てる */
  evaluator: NnEvaluator | null
}

/** 時間戦略（自発待機）は実測で Elo +290 なので既定で有効にする */
export const ENGINE_MCTS_DEFAULTS: Partial<MctsConfig> = {
  allowWait: true,
}

export function buildEngine(spec: EngineSpec, rng: Rng): Engine {
  const config = { ...ENGINE_MCTS_DEFAULTS, ...spec.mcts }

  if (spec.kind === 'nn') {
    if (!spec.modelPath) throw new Error(`engine ${spec.id}: modelPath is required`)
    const evaluator = new NnEvaluator(loadNetwork(spec.modelPath))
    return {
      mcts: new Mcts({
        config,
        policy: spec.policySource === 'heuristic' ? heuristicPolicy : evaluator.policy,
        value: evaluator.value,
      }),
      evaluator,
    }
  }

  if (spec.kind === 'rollout') {
    return {
      mcts: new Mcts({
        config,
        policy: uniformPolicy,
        value: createRolloutValue(rng),
      }),
      evaluator: null,
    }
  }

  return {
    mcts: new Mcts({ config, policy: heuristicPolicy, value: heuristicValue }),
    evaluator: null,
  }
}

/**
 * 対戦場に出すための包み。
 *
 * MCTS の節点配列は数 MB あるので、試合ごとに作り直さない。
 * ランダムプレイアウトだけは乱数を内部に抱えるので、差し替え可能な代理を渡す。
 */
export function engineAgent(spec: EngineSpec): FastAgent {
  const holder = { rng: null as Rng | null }
  const proxy: Rng = {
    next: () => holder.rng!.next(),
    nextInt: (min, max) => holder.rng!.nextInt(min, max),
  }
  let engine: Engine | null = null

  return {
    id: spec.id,
    onMatchStart() {
      engine?.evaluator?.reset()
    },
    decide(match, side, rng) {
      holder.rng = rng
      if (!engine) engine = buildEngine(spec, proxy)
      return engine.mcts.search(match, side, rng)
    },
  }
}

export function engineAgentSpec(spec: EngineSpec): AgentSpec {
  return { id: spec.id, label: spec.label, create: () => engineAgent(spec) }
}

/** 静的評価 MCTS の Champion 相当（学習前の出発点） */
export function heuristicChampionSpec(simulations: number): EngineSpec {
  return {
    id: `heur_mcts_${simulations}`,
    label: `静的評価MCTS ${simulations}`,
    kind: 'heuristic',
    mcts: { simulations },
  }
}

export function nnEngineSpec(options: {
  id: string
  label: string
  modelPath: string
  simulations: number
  policySource?: 'nn' | 'heuristic'
  extra?: Partial<MctsConfig>
}): EngineSpec {
  return {
    id: options.id,
    label: options.label,
    kind: 'nn',
    modelPath: options.modelPath,
    policySource: options.policySource,
    mcts: { simulations: options.simulations, ...options.extra },
  }
}
