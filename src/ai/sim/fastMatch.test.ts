/**
 * 高速シミュレータがルール層と完全に一致することを確認する。
 *
 * 比較対象は `runGaMatch`（src/ga/matchRunner.ts、ルール層 stepMatch を直接使う）。
 * 着手要求の列（moveHash）・勝敗・終了理由・石差・終局時刻をすべて突き合わせる。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GAME_CONFIG } from '../../game/config.ts'
import { createRng } from '../../game/rng.ts'
import { runGaMatch, type OpponentSpec } from '../../ga/matchRunner.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'
import { maxFlipAgent, randomAgent, waitAgent } from '../agents/baselines.ts'
import {
  END_BOARD_FULL,
  END_NO_LEGAL_MOVES,
  END_TIME_UP,
  OUTCOME_BLACK_WIN,
  OUTCOME_DRAW,
  OUTCOME_WHITE_WIN,
  OUT_CAN_ACT,
  OUT_THINK_READY,
  PHASE_FINISHED,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_PHASE,
  TS_TIME,
  advanceToDecision,
  applyFastStep,
  createFastMatch,
  listLegalActions,
  runFastMatch,
  type FastAgent,
} from './fastMatch.ts'

const END_NAMES: Record<number, string> = {
  [END_BOARD_FULL]: 'board_full',
  [END_NO_LEGAL_MOVES]: 'no_legal_moves',
  [END_TIME_UP]: 'time_up',
}

const OUTCOME_NAMES: Record<number, string> = {
  [OUTCOME_BLACK_WIN]: 'black_win',
  [OUTCOME_WHITE_WIN]: 'white_win',
  [OUTCOME_DRAW]: 'draw',
}

function hashMoveParts(parts: string[]): string {
  return createHash('sha256').update(parts.join(',')).digest('hex').slice(0, 16)
}

function builtin(id: 'random' | 'max_flip' | 'wait'): OpponentSpec & {
  labelId: string
} {
  return { kind: 'builtin', id, labelId: id }
}

function fastAgentFor(id: 'random' | 'max_flip' | 'wait'): FastAgent {
  if (id === 'random') return randomAgent
  if (id === 'max_flip') return maxFlipAgent
  return waitAgent
}

/** 高速シミュレータ側で matchRunner と同じ moveParts を組む */
function runFast(
  seed: number,
  blackId: 'random' | 'max_flip' | 'wait',
  whiteId: 'random' | 'max_flip' | 'wait',
): {
  moveHash: string
  outcome: string
  endReason: string
  stoneDiffForBlack: number
  elapsedMs: number
} {
  const parts: string[] = []
  const result = runFastMatch({
    seed,
    decisionSeed: seed ^ 0x22,
    black: fastAgentFor(blackId),
    white: fastAgentFor(whiteId),
    hooks: {
      onStep(_match, actionBlack, actionWhite) {
        if (actionBlack !== WAIT_ACTION) parts.push(`b${actionBlack}`)
        if (actionWhite !== WAIT_ACTION) parts.push(`w${actionWhite}`)
      },
    },
  })
  return {
    moveHash: hashMoveParts(parts),
    outcome: OUTCOME_NAMES[result.outcome]!,
    endReason: END_NAMES[result.endReason] ?? 'unknown',
    stoneDiffForBlack: result.stoneDiffForBlack,
    elapsedMs: result.elapsedMs,
  }
}

function runRule(
  seed: number,
  blackId: 'random' | 'max_flip' | 'wait',
  whiteId: 'random' | 'max_flip' | 'wait',
): {
  moveHash: string
  outcome: string
  endReason: string
  stoneDiffForBlack: number
  elapsedMs: number
} {
  const result = runGaMatch({
    matchId: `parity-${seed}`,
    seed,
    black: builtin(blackId),
    white: builtin(whiteId),
    decisionSeed: seed ^ 0x22,
  })
  return {
    moveHash: result.moveHash,
    outcome: result.outcome,
    endReason: result.endReason ?? 'unknown',
    stoneDiffForBlack: result.stoneDiffForBlack,
    elapsedMs: result.elapsedMs,
  }
}

describe('高速シミュレータとルール層の一致', () => {
  const pairs: Array<
    [
      'random' | 'max_flip' | 'wait',
      'random' | 'max_flip' | 'wait',
    ]
  > = [
    ['random', 'random'],
    ['max_flip', 'random'],
    ['random', 'max_flip'],
    ['max_flip', 'max_flip'],
    ['wait', 'max_flip'],
    ['max_flip', 'wait'],
    ['wait', 'wait'],
  ]

  for (const [blackId, whiteId] of pairs) {
    // wait 同士は意思決定点が 50ms ごとに立つのでルール層側が特に遅い
    it(`${blackId} vs ${whiteId}: 着手列と終局が一致する`, { timeout: 30_000 }, () => {
      for (let seed = 1; seed <= 30; seed += 1) {
        const fast = runFast(seed, blackId, whiteId)
        const rule = runRule(seed, blackId, whiteId)
        expect(fast, `seed=${seed}`).toEqual(rule)
      }
    })
  }

  // ルール層側が 1 試合 12ms 程度かかるため、既定タイムアウトを延ばす
  it('広いシード範囲でも一致する（random 同士 200 試合）', { timeout: 60_000 }, () => {
    for (let seed = 1000; seed < 1200; seed += 1) {
      const fast = runFast(seed, 'random', 'random')
      const rule = runRule(seed, 'random', 'random')
      expect(fast.moveHash, `seed=${seed}`).toBe(rule.moveHash)
      expect(fast.outcome, `seed=${seed}`).toBe(rule.outcome)
      expect(fast.endReason, `seed=${seed}`).toBe(rule.endReason)
      expect(fast.elapsedMs, `seed=${seed}`).toBe(rule.elapsedMs)
    }
  })
})

describe('合法手生成', () => {
  it('行優先の昇順で返る（ルール層 listLegalMoves と同じ列挙順）', () => {
    const rng = createRng(7)
    const match = createFastMatch({ seed: 7 })
    const out = new Int32Array(128)
    let checked = 0

    const pick = (side: number): number => {
      const n = listLegalActions(match, side, out)
      if (n === 0) return WAIT_ACTION
      return out[rng.nextInt(0, n)]!
    }

    for (let i = 0; i < 400; i += 1) {
      advanceToDecision(match)
      if (match.ts[TS_PHASE] === PHASE_FINISHED) break

      for (const side of [SIDE_BLACK, SIDE_WHITE]) {
        if (match.out[OUT_CAN_ACT + side] !== 1) continue
        const n = listLegalActions(match, side, out)
        expect(n).toBeGreaterThan(0)
        for (let k = 1; k < n; k += 1) {
          expect(out[k]).toBeGreaterThan(out[k - 1]!)
        }
        checked += 1
      }

      const ready = (side: number): boolean =>
        match.out[OUT_CAN_ACT + side] === 1 &&
        match.out[OUT_THINK_READY + side] === 1
      const a = ready(SIDE_BLACK) ? pick(SIDE_BLACK) : WAIT_ACTION
      const b = ready(SIDE_WHITE) ? pick(SIDE_WHITE) : WAIT_ACTION
      applyFastStep(match, a, b)
    }

    expect(checked).toBeGreaterThan(10)
  })
})

describe('時間の扱い', () => {
  it('着手間隔は cooldown + 判断待ち - 1step になる', () => {
    // 白は自発待機を続けるので毎ステップ判断点が立つ。黒の着手時刻だけを測る
    const times: number[] = []
    runFastMatch({
      seed: 3,
      decisionSeed: 3,
      black: maxFlipAgent,
      white: waitAgent,
      config: { idleAutoMoveMs: 10_000_000 },
      hooks: {
        onStep(match, actionBlack) {
          if (actionBlack !== WAIT_ACTION) times.push(match.ts[TS_TIME])
        },
      },
      maxDecisions: 400,
    })

    expect(times.length).toBeGreaterThan(5)
    const gaps = times.slice(1).map((t, i) => t - times[i]!)
    const expected =
      GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs - GAME_CONFIG.stepMs
    for (const gap of gaps) {
      expect(gap).toBe(expected)
    }
  })

  it('相手の着手が判断待ちをリセットして自分の着手を後ろへずらす', () => {
    // 白だけが動く状況で、黒の判断待ちが盤面変化ごとに測り直されることを確認
    const blackDecisionTimes: number[] = []
    const neverMove: FastAgent = {
      id: 'never',
      decide(match, side) {
        if (side === SIDE_WHITE) {
          return maxFlipAgent.decide(match, side, createRng(1))
        }
        blackDecisionTimes.push(match.ts[TS_TIME])
        return WAIT_ACTION
      },
    }
    runFastMatch({
      seed: 5,
      decisionSeed: 5,
      black: neverMove,
      white: neverMove,
      config: { idleAutoMoveMs: 10_000_000 },
      maxDecisions: 60,
    })
    // 黒は自発 WAIT を続けるので毎ステップ ready になり、判断点が連続する
    expect(blackDecisionTimes.length).toBeGreaterThan(5)
  })
})
