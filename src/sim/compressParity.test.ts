import { describe, expect, it } from 'vitest'
import { GAME_CONFIG } from '../game/config.ts'
import { WAIT_ACTION } from './constants.ts'
import {
  createLearnerSession,
  decisionSnapshot,
  stepLearner,
  type LearnerSession,
} from './learnerMatch.ts'

function canPlace(session: LearnerSession): boolean {
  return session.env
    .getActionMask(session.learnerSide)
    .some((v, i) => v && i !== WAIT_ACTION)
}

function isVoluntary(r: ReturnType<typeof stepLearner>): boolean {
  return Boolean((r.info as { voluntaryWait?: boolean }).voluntaryWait)
}

/** 細かい実行を圧縮側の stepCount まで WAIT で追いつかせる */
function catchUpFine(fine: LearnerSession, targetSteps: number): number {
  let reward = 0
  while (
    fine.env.getStepCount() < targetSteps &&
    !fine.env.isTerminated() &&
    !fine.env.isTruncated()
  ) {
    reward += stepLearner(fine, WAIT_ACTION, { compressForcedWait: false })
      .reward
  }
  return reward
}

describe('強制WAIT圧縮の一致', () => {
  it('着手後クールタイム区間が一致する', () => {
    const seed = 101
    const fine = createLearnerSession({
      seed,
      learnerSide: 'black',
      opponent: 'random',
      thinkDelayMs: 0,
    })
    const comp = createLearnerSession({
      seed,
      learnerSide: 'black',
      opponent: 'random',
      thinkDelayMs: 0,
    })
    const place = fine.env
      .getActionMask('black')
      .findIndex((v, i) => v && i < 100)
    expect(place).toBeGreaterThanOrEqual(0)

    let rewardFine = stepLearner(fine, place, { compressForcedWait: false })
      .reward
    const rComp = stepLearner(comp, place, { compressForcedWait: true })
    rewardFine += catchUpFine(fine, comp.env.getStepCount())

    expect(decisionSnapshot(fine)).toEqual(decisionSnapshot(comp))
    expect(rewardFine).toBeCloseTo(rComp.reward, 10)
    expect(rComp.forcedWaitAutoSteps).toBeGreaterThan(0)
  })

  it('自発的WAITは1×50msで止まり結果が一致する', () => {
    const fine = createLearnerSession({
      seed: 202,
      learnerSide: 'black',
      opponent: 'max_flip',
      thinkDelayMs: 0,
    })
    const comp = createLearnerSession({
      seed: 202,
      learnerSide: 'black',
      opponent: 'max_flip',
      thinkDelayMs: 0,
    })
    expect(canPlace(fine)).toBe(true)
    const rF = stepLearner(fine, WAIT_ACTION, { compressForcedWait: false })
    const rC = stepLearner(comp, WAIT_ACTION, { compressForcedWait: true })
    expect(isVoluntary(rF)).toBe(true)
    expect(isVoluntary(rC)).toBe(true)
    expect(rC.forcedWaitAutoSteps).toBe(0)
    expect(rC.internalSteps).toBe(1)
    expect(decisionSnapshot(fine)).toEqual(decisionSnapshot(comp))
  })

  it('判断待ち中の圧縮と細かい実行が一致する', () => {
    const fine = createLearnerSession({
      seed: 303,
      learnerSide: 'white',
      opponent: 'random',
      thinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
    })
    const comp = createLearnerSession({
      seed: 303,
      learnerSide: 'white',
      opponent: 'random',
      thinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
    })
    expect(canPlace(comp)).toBe(false)

    const rComp = stepLearner(comp, WAIT_ACTION, { compressForcedWait: true })
    let rewardFine = 0
    rewardFine += catchUpFine(fine, comp.env.getStepCount())

    expect(decisionSnapshot(fine)).toEqual(decisionSnapshot(comp))
    expect(rewardFine).toBeCloseTo(rComp.reward, 10)
    expect(canPlace(comp)).toBe(true)
  })

  it('複数判断を圧縮／細かく進めて盤面と結果が一致する', () => {
    const seed = 707
    const fine = createLearnerSession({
      seed,
      learnerSide: 'black',
      opponent: 'max_flip',
      thinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
    })
    const comp = createLearnerSession({
      seed,
      learnerSide: 'black',
      opponent: 'max_flip',
      thinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
    })

    let rewardFine = 0
    let rewardComp = 0
    for (let i = 0; i < 15; i += 1) {
      if (comp.env.isTerminated()) break

      if (!canPlace(comp)) {
        const r = stepLearner(comp, WAIT_ACTION, { compressForcedWait: true })
        rewardComp += r.reward
        rewardFine += catchUpFine(fine, comp.env.getStepCount())
      } else {
        const place = comp.env
          .getActionMask('black')
          .findIndex((v, i) => v && i < 100)
        const action = place >= 0 ? place : WAIT_ACTION
        // 細かい側も同じ判断点まで先に揃っている前提
        expect(decisionSnapshot(fine)).toEqual(decisionSnapshot(comp))
        const rC = stepLearner(comp, action, { compressForcedWait: true })
        rewardComp += rC.reward
        if (isVoluntary(rC)) {
          rewardFine += stepLearner(fine, action, {
            compressForcedWait: false,
          }).reward
        } else {
          rewardFine += stepLearner(fine, action, {
            compressForcedWait: false,
          }).reward
          rewardFine += catchUpFine(fine, comp.env.getStepCount())
        }
      }
      expect(decisionSnapshot(fine)).toEqual(decisionSnapshot(comp))
    }
    expect(rewardFine).toBeCloseTo(rewardComp, 10)
  })

  it('同時着手競合が起きうる局面でも圧縮一致する', () => {
    const fine = createLearnerSession({
      seed: 21,
      learnerSide: 'black',
      opponent: 'random',
      thinkDelayMs: 0,
    })
    const comp = createLearnerSession({
      seed: 21,
      learnerSide: 'black',
      opponent: 'random',
      thinkDelayMs: 0,
    })
    const place = fine.env
      .getActionMask('black')
      .findIndex((v, i) => v && i < 100)
    expect(place).toBeGreaterThanOrEqual(0)
    const rC = stepLearner(comp, place, { compressForcedWait: true })
    let rewardFine = stepLearner(fine, place, { compressForcedWait: false })
      .reward
    rewardFine += catchUpFine(fine, comp.env.getStepCount())
    expect(decisionSnapshot(fine)).toEqual(decisionSnapshot(comp))
    expect(rewardFine).toBeCloseTo(rC.reward, 10)
  })

  it('終局報酬は一度だけ（圧縮）', () => {
    const session = createLearnerSession({
      seed: 505,
      learnerSide: 'black',
      opponent: 'random',
      thinkDelayMs: 0,
    })
    let terminalCount = 0
    let last = 0
    let guard = 0
    while (!session.env.isTerminated() && guard < 20000) {
      guard += 1
      const mask = session.env.getActionMask('black')
      const place = mask.findIndex((v, i) => v && i < 100)
      const action = place >= 0 ? place : WAIT_ACTION
      const r = stepLearner(session, action, { compressForcedWait: true })
      if (r.terminated) {
        terminalCount += 1
        last = r.reward
      }
    }
    expect(session.env.isTerminated()).toBe(true)
    expect(terminalCount).toBe(1)
    expect([0, 1, -1]).toContain(last)
  })

  it('reset後の初期状態はカウントダウン終了相当のまま', () => {
    const s = createLearnerSession({
      seed: 1,
      learnerSide: 'black',
      opponent: 'random',
    })
    expect(s.env.getMatch().elapsedMs).toBe(0)
    expect(s.env.getMatch().cooldowns).toEqual({ black: 0, white: 0 })
  })
})
