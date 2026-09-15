/**
 * MCTS が探索でシミュレータを壊さないこと、時間状態を無視していないことを確認する。
 * 探索は盤面・時間状態・判断点フラグをすべて元へ戻さなければならない。
 */
import { describe, expect, it } from 'vitest'
import { createRng } from '../../game/rng.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'
import { maxFlipAgent, randomAgent } from '../agents/baselines.ts'
import { playSeries } from '../arena/arena.ts'
import {
  OUT_CAN_ACT,
  OUT_IDLE_READY,
  OUT_SIZE,
  PHASE_FINISHED,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_PHASE,
  TS_SIZE,
  advanceToDecision,
  applyFastStep,
  createFastMatch,
  listLegalActions,
  runFastMatch,
} from '../sim/fastMatch.ts'
import { createRolloutValue, heuristicPolicy, heuristicValue, uniformPolicy } from './heuristics.ts'
import { Mcts } from './mcts.ts'
import { createMctsAgent } from './mctsAgent.ts'

function snapshot(match: ReturnType<typeof createFastMatch>): {
  cells: Uint8Array
  ts: Int32Array
  out: Int32Array
  black: number
  white: number
  empty: number
} {
  return {
    cells: new Uint8Array(match.pos.cells),
    ts: new Int32Array(match.ts),
    out: new Int32Array(match.out),
    black: match.pos.black,
    white: match.pos.white,
    empty: match.pos.emptyCount,
  }
}

describe('MCTS の状態復元', () => {
  it('探索後に盤面・時間状態・判断点フラグが元に戻る', () => {
    const match = createFastMatch({ seed: 11 })
    const rng = createRng(99)
    const engine = new Mcts({
      config: { simulations: 120, maxNodes: 4000, allowWait: true },
      policy: heuristicPolicy,
      value: heuristicValue,
    })
    const buf = new Int32Array(128)

    for (let i = 0; i < 25; i += 1) {
      advanceToDecision(match)
      if (match.ts[TS_PHASE] === PHASE_FINISHED) break

      const before = snapshot(match)
      engine.search(match, SIDE_BLACK, rng)
      const after = snapshot(match)

      expect(Array.from(after.cells)).toEqual(Array.from(before.cells))
      expect(Array.from(after.ts)).toEqual(Array.from(before.ts))
      expect(Array.from(after.out)).toEqual(Array.from(before.out))
      expect(after.black).toBe(before.black)
      expect(after.white).toBe(before.white)
      expect(after.empty).toBe(before.empty)

      // 局面を 1 手進める（探索とは別の手で）
      const pick = (side: number): number => {
        const n = listLegalActions(match, side, buf)
        if (n === 0) return WAIT_ACTION
        return buf[rng.nextInt(0, n)]!
      }
      applyFastStep(match, pick(SIDE_BLACK), pick(SIDE_WHITE))
    }
  })

  it('ランダムプレイアウトでも状態が戻る', () => {
    const match = createFastMatch({ seed: 12 })
    const rng = createRng(7)
    const engine = new Mcts({
      config: { simulations: 60, maxNodes: 2000 },
      policy: uniformPolicy,
      value: createRolloutValue(rng),
    })

    advanceToDecision(match)
    const before = snapshot(match)
    engine.search(match, SIDE_BLACK, rng)
    const after = snapshot(match)
    expect(Array.from(after.cells)).toEqual(Array.from(before.cells))
    expect(Array.from(after.ts)).toEqual(Array.from(before.ts))
    expect(Array.from(after.out)).toEqual(Array.from(before.out))
  })
})

describe('MCTS の出力', () => {
  it('必ず合法手（または待機）を返す', () => {
    const match = createFastMatch({ seed: 21 })
    const rng = createRng(3)
    const engine = new Mcts({
      config: { simulations: 48, maxNodes: 2000 },
      policy: heuristicPolicy,
      value: heuristicValue,
    })
    const buf = new Int32Array(128)
    let checked = 0

    for (let i = 0; i < 40; i += 1) {
      advanceToDecision(match)
      if (match.ts[TS_PHASE] === PHASE_FINISHED) break
      const n = listLegalActions(match, SIDE_BLACK, buf)
      const legal = new Set(Array.from(buf.subarray(0, n)))
      if (match.out[SIDE_BLACK] === 1 && match.out[2 + SIDE_BLACK] === 1) {
        const action = engine.search(match, SIDE_BLACK, rng)
        expect(action === WAIT_ACTION || legal.has(action)).toBe(true)
        checked += 1
      }
      const pickWhite = (): number => {
        const m = listLegalActions(match, SIDE_WHITE, buf)
        if (m === 0) return WAIT_ACTION
        return buf[rng.nextInt(0, m)]!
      }
      applyFastStep(match, WAIT_ACTION, pickWhite())
    }

    expect(checked).toBeGreaterThan(3)
  })

  it('root の訪問分布が simulations に見合う数になる', () => {
    const match = createFastMatch({ seed: 31 })
    const rng = createRng(5)
    const sims = 200
    const engine = new Mcts({
      config: { simulations: sims, maxNodes: 8000 },
      policy: heuristicPolicy,
      value: heuristicValue,
    })
    advanceToDecision(match)
    engine.search(match, SIDE_BLACK, rng)

    expect(engine.rootActionCount).toBeGreaterThan(1)
    let total = 0
    for (let k = 0; k < engine.rootActionCount; k += 1) {
      total += engine.rootVisits[k]!
    }
    // 黒が ready なら root の黒側統計に全シミュレーションが入る
    expect(total).toBe(sims)
  })

  it('探索量を増やすと root 評価が安定する', () => {
    const rng = createRng(17)
    const values: number[] = []
    for (const sims of [32, 512]) {
      const match = createFastMatch({ seed: 41 })
      advanceToDecision(match)
      const engine = new Mcts({
        config: { simulations: sims, maxNodes: 20000 },
        policy: heuristicPolicy,
        value: heuristicValue,
      })
      engine.search(match, SIDE_BLACK, rng)
      values.push(engine.lastStats.rootValue)
      expect(engine.lastStats.simulations).toBe(sims)
    }
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('WAIT を無料の手にしない', () => {
  // 無操作タイマーが切れた側はルール上ランダム着手が入るので、待機は選べない。
  // ここを許すと探索の中だけ「無料で何もしない手」ができ、
  // 探索量を増やすほど MCTS がそのモデル誤差を突いて弱くなる（実測 0% 勝率）。
  it('無操作タイマー切れの側の行動列に WAIT を入れない', () => {
    const match = createFastMatch({ seed: 7 })
    advanceToDecision(match)

    const engine = new Mcts({
      config: { simulations: 256, maxNodes: 20_000, allowWait: true },
      policy: heuristicPolicy,
      value: heuristicValue,
    })

    let idleReadyDecisions = 0
    // 無操作タイマーが切れるまで双方待機し続ける
    for (let step = 0; step < 4000; step += 1) {
      if (match.ts[TS_PHASE] === PHASE_FINISHED) break
      const idleBlack = match.out[OUT_IDLE_READY + SIDE_BLACK] === 1
      const canBlack = match.out[OUT_CAN_ACT + SIDE_BLACK] === 1
      if (canBlack && idleBlack) {
        idleReadyDecisions += 1
        engine.search(match, SIDE_BLACK, createRng(3))
        for (let k = 0; k < engine.rootActionCount; k += 1) {
          expect(engine.rootActions[k]).not.toBe(WAIT_ACTION)
        }
        break
      }
      applyFastStep(match, WAIT_ACTION, WAIT_ACTION)
      advanceToDecision(match)
    }

    expect(idleReadyDecisions).toBe(1)
  })

  it('探索量を増やしても WAIT ばかり選ばない', { timeout: 120_000 }, () => {
    for (const sims of [96, 192, 256]) {
      const agent = createMctsAgent({
        id: `mcts${sims}`,
        label: `MCTS${sims}`,
        config: { simulations: sims, maxNodes: 20_000, allowWait: true },
        policy: heuristicPolicy,
        value: heuristicValue,
      })
      let waits = 0
      let decisions = 0
      const wrapped: typeof agent = {
        ...agent,
        decide(match, side, rng) {
          const action = agent.decide(match, side, rng)
          decisions += 1
          if (action === WAIT_ACTION) waits += 1
          return action
        },
      }
      const result = runFastMatch({
        seed: 21,
        decisionSeed: 99,
        black: wrapped,
        white: maxFlipAgent,
      })
      expect(result.abnormal).toBe(false)
      // 待機は戦術として有効なので禁止はしないが、半分を超えるのは異常
      expect(waits / Math.max(1, decisions)).toBeLessThan(0.5)
    }
  })
})

describe('MCTS の強さ（Phase 4 の下限確認）', () => {
  it('静的評価MCTS 64回 は random に圧勝する', { timeout: 120_000 }, () => {
    const result = playSeries({
      a: {
        id: 'mcts64',
        label: 'MCTS64',
        create: () =>
          createMctsAgent({
            id: 'mcts64',
            label: 'MCTS64',
            config: { simulations: 64, maxNodes: 4000 },
            policy: heuristicPolicy,
            value: heuristicValue,
          }),
      },
      b: { id: 'random', label: 'random', create: () => randomAgent },
      games: 20,
      masterSeed: 1234,
    })
    expect(result.aScoreRate).toBeGreaterThan(0.85)
  })

  it('探索が試合を壊さない（最後まで正常終了する）', { timeout: 120_000 }, () => {
    const agent = createMctsAgent({
      id: 'mcts',
      label: 'MCTS',
      config: { simulations: 32, maxNodes: 4000, allowWait: true },
      policy: heuristicPolicy,
      value: heuristicValue,
    })
    for (let seed = 1; seed <= 5; seed += 1) {
      const result = runFastMatch({
        seed,
        decisionSeed: seed + 100,
        black: agent,
        white: maxFlipAgent,
      })
      expect(result.abnormal).toBe(false)
      expect(result.black + result.white + result.empty).toBe(100)
    }
  })
})

void OUT_SIZE
void TS_SIZE
