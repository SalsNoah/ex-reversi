/**
 * 対戦場が「独立した標本」を作れていることを確認する。
 *
 * このゲームの乱数は初期の同時着手優先側と無操作強制着手にしか効かないので、
 * 決定的なエンジン同士だと決定シードを変えても試合が完全に同一になる。
 * その状態では何局測っても統計にならない
 * （実測で 4 マスターシードすべて 15-15-0 / 0-30-0 と一致した）。
 */
import { describe, expect, it } from 'vitest'
import { maxFlipAgent, randomAgent } from '../agents/baselines.ts'
import { createMctsAgent } from '../mcts/mctsAgent.ts'
import { heuristicPolicy, heuristicValue } from '../mcts/heuristics.ts'
import { listLegalActions, runFastMatch, type FastAgent } from '../sim/fastMatch.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'
import { playSeries, type AgentSpec } from './arena.ts'

/**
 * 完全に決定的なエージェント（合法手のうち添字が最小の手を打つ）。
 * `maxFlipAgent` は同点を乱数で崩すので、この確認には使えない。
 */
const firstMoveAgent: FastAgent = {
  id: 'first_move',
  decide(match, side) {
    const buf = new Int32Array(101)
    const n = listLegalActions(match, side, buf)
    if (n === 0) return WAIT_ACTION
    let best = buf[0]!
    for (let k = 1; k < n; k += 1) if (buf[k]! < best) best = buf[k]!
    return best
  },
}

/** 着手列をまとめた指紋 */
function gameFingerprint(decisionSeed: number, randomOpeningDecisions: number): string {
  const steps: number[] = []
  runFastMatch({
    seed: 4242,
    decisionSeed,
    black: firstMoveAgent,
    white: firstMoveAgent,
    randomOpeningDecisions,
    hooks: {
      onStep(_match, actionBlack, actionWhite) {
        steps.push(actionBlack, actionWhite)
      },
    },
  })
  return steps.join(',')
}

describe('決定的なエンジン同士でも局がばらける', () => {
  it('ランダム開幕なしだと決定シードが試合に効かない', () => {
    // これがバグの正体。退行検知として固定しておく
    const a = gameFingerprint(1, 0)
    const b = gameFingerprint(98765, 0)
    expect(b).toBe(a)
  })

  it('ランダム開幕を入れると決定シードで試合が変わる', () => {
    const prints = new Set([1, 2, 3, 4, 5].map((s) => gameFingerprint(s * 7919, 4)))
    expect(prints.size).toBe(5)
  })

  it('ランダム開幕でも試合は正常に終わる', () => {
    const mcts: AgentSpec = {
      id: 'det_mcts',
      label: '静的評価MCTS 32',
      create: () =>
        createMctsAgent({
          id: 'det_mcts',
          label: '静的評価MCTS 32',
          config: { simulations: 32, maxNodes: 4000, allowWait: true },
          policy: heuristicPolicy,
          value: heuristicValue,
        }),
    }
    const r = playSeries({
      a: mcts,
      b: { id: 'random', label: 'ランダム型', create: () => randomAgent },
      games: 8,
      masterSeed: 4242,
    })
    expect(r.abnormal).toBe(0)
    expect(r.aWins + r.bWins + r.draws).toBe(8)
    // 開幕 4 手がランダムでも、静的評価MCTS はランダム型に明確に勝つ
    expect(r.aScoreRate).toBeGreaterThan(0.7)
  })

  it('playSeries の既定でランダム開幕が入っている', () => {
    const withDefault = playSeries({
      a: { id: 'max_flip', label: '即時反転数優先型', create: () => maxFlipAgent },
      b: { id: 'random', label: 'ランダム型', create: () => randomAgent },
      games: 6,
      masterSeed: 11,
    })
    const withoutOpening = playSeries({
      a: { id: 'max_flip', label: '即時反転数優先型', create: () => maxFlipAgent },
      b: { id: 'random', label: 'ランダム型', create: () => randomAgent },
      games: 6,
      masterSeed: 11,
      randomOpeningDecisions: 0,
    })
    expect(withDefault.avgStoneDiffForA).not.toBe(withoutOpening.avgStoneDiffForA)
  })
})
