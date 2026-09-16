/**
 * 対戦場に出せるAIの名簿。
 * ここに載せたものは `npm run ai:arena` などから ID で呼べる。
 */
import { createAnnCpu } from '../../cpu/ann/annCpu.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import { GA_MILESTONES } from '../../cpu/gaMilestones.ts'
import type { AgentSpec } from '../arena/arena.ts'
import { phase4Specs } from '../mcts/mctsAgent.ts'
import { maxFlipAgent, randomAgent, waitAgent } from './baselines.ts'
import { legacyAgentOf, legacyCpuAgent, legacyGeneAgent } from './legacy.ts'

export { maxFlipAgent, randomAgent, waitAgent } from './baselines.ts'
export { legacyAgentOf, legacyCpuAgent, legacyGeneAgent } from './legacy.ts'

const BASE_SPECS: AgentSpec[] = [
  { id: 'random', label: 'ランダム型', create: () => randomAgent },
  { id: 'max_flip', label: '即時反転数優先型', create: () => maxFlipAgent },
  { id: 'wait', label: '常に待機（動作確認用）', create: () => waitAgent },
  {
    id: 'legacy_strategy',
    label: '既存 戦略AI（時間対応αβ）',
    create: () => legacyCpuAgent('strategy'),
  },
  {
    id: 'legacy_alpha',
    label: '既存 アルファAI',
    create: () => legacyCpuAgent('alpha'),
  },
  {
    id: 'legacy_beta',
    label: '既存 ベータAI',
    create: () => legacyCpuAgent('beta'),
  },
  {
    id: 'legacy_gamma',
    label: '既存 ガンマAI',
    create: () => legacyCpuAgent('gamma'),
  },
  {
    id: 'legacy_delta',
    label: '既存 デルタAI',
    create: () => legacyCpuAgent('delta'),
  },
  {
    // ゲームに載っている最新の名前付き個体。勝てたらそう言ってよい相手
    id: 'legacy_epsilon',
    label: '既存 イプシロンAI',
    create: () => legacyCpuAgent('epsilon'),
  },
  {
    // ゲームに載っている「アン」をそのまま測る（公開状態への変換も含めて確認する）
    // 相手を人間と想定しているので、CPU 同士の対戦では相手の判断待ちを読み違える
    id: 'legacy_ann',
    label: 'アン（ゲーム登録版・相手は即断と想定）',
    create: () => legacyCpuAgent('ann'),
  },
  {
    // CPU 同士の対戦環境に合わせた版。時間モデルが合っているときの実力を見る
    id: 'legacy_ann_matched',
    label: 'アン（相手も判断待ち500ms）',
    create: () =>
      legacyAgentOf(
        createAnnCpu({ opponentThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs }),
        'legacy:ann_matched',
      ),
  },
  {
    id: 'legacy_ga_best',
    label: '既存 GA採用個体',
    create: () => legacyCpuAgent('ga_best'),
  },
]

const MILESTONE_SPECS: AgentSpec[] = GA_MILESTONES.map((m) => ({
  id: `legacy_${m.id}`,
  label: `既存 GA第${m.generation}世代`,
  create: () => legacyGeneAgent(m.id, m.genes),
}))

const REGISTRY = new Map<string, AgentSpec>()
for (const spec of [...BASE_SPECS, ...MILESTONE_SPECS, ...phase4Specs()]) {
  REGISTRY.set(spec.id, spec)
}

/** 後から（MCTS などを）名簿に足す */
export function registerAgent(spec: AgentSpec): void {
  REGISTRY.set(spec.id, spec)
}

export function getAgentSpec(id: string): AgentSpec {
  const spec = REGISTRY.get(id)
  if (!spec) {
    throw new Error(
      `unknown agent: ${id}\n使えるID: ${[...REGISTRY.keys()].join(', ')}`,
    )
  }
  return spec
}

export function listAgentIds(): string[] {
  return [...REGISTRY.keys()]
}

/** 既存勢の代表（比較の基準）。実際にどれが最強かは総当たりで測る */
export const BASELINE_IDS: readonly string[] = [
  'random',
  'max_flip',
  ...MILESTONE_SPECS.map((s) => s.id),
  'legacy_ga_best',
  'legacy_strategy',
]
