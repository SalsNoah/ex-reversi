import { describe, expect, it } from 'vitest'
import { createMatch, stepMatch, GAME_CONFIG } from '../game/index.ts'
import { cloneMatchState } from '../game/match.ts'
import { createIdleThinkGate } from '../cpu/thinkGate.ts'
import {
  ACTION_SPACE_SIZE,
  WAIT_ACTION,
  buildActionMask,
  createTrainingEnv,
  getSideObservation,
  runCpuMatch,
  toNormalizedVector,
  FORBIDDEN_OBSERVATION_KEYS,
  actionToMoveRequest,
} from './index.ts'

describe('学習環境 / 再現性', () => {
  it('同じ設定・シード・行動列なら同じ結果になる', () => {
    const actions: Array<[number, number]> = []
    const env1 = createTrainingEnv({
      seed: 42,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    while (!env1.isTerminated() && !env1.isTruncated()) {
      const b = env1.getActionMask('black').findIndex((v, i) => v && i < 100)
      const w = env1.getActionMask('white').findIndex((v, i) => v && i < 100)
      const ba = b >= 0 ? b : WAIT_ACTION
      const wa = w >= 0 ? w : WAIT_ACTION
      actions.push([ba, wa])
      env1.step(ba, wa)
    }

    const env2 = createTrainingEnv({
      seed: 42,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    for (const [ba, wa] of actions) {
      env2.step(ba, wa)
    }
    expect(env2.getMatch().board).toEqual(env1.getMatch().board)
    expect(env2.getMatch().elapsedMs).toBe(env1.getMatch().elapsedMs)
    expect(env2.getMatch().cooldowns).toEqual(env1.getMatch().cooldowns)
    expect(env2.getMatch().outcome).toBe(env1.getMatch().outcome)
    expect(env2.getMatch().endReason).toBe(env1.getMatch().endReason)
  })

  it('700msクールタイム境界が正しい', () => {
    const env = createTrainingEnv({
      seed: 7,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    const mask0 = env.getActionMask('black')
    const place = mask0.findIndex((v, i) => v && i < WAIT_ACTION)
    expect(place).toBeGreaterThanOrEqual(0)
    env.step(place, WAIT_ACTION)
    // step 内で着手後に 50ms 進むため、残りは cooldownMs - stepMs
    expect(env.getMatch().cooldowns.black).toBe(700 - GAME_CONFIG.stepMs)

    for (let i = 0; i < 12; i += 1) env.step(WAIT_ACTION, WAIT_ACTION)
    expect(env.getMatch().cooldowns.black).toBe(50)
    const mid = env.getActionMask('black')
    expect(mid.slice(0, 100).every((v) => !v)).toBe(true)
    expect(mid[WAIT_ACTION]).toBe(true)

    env.step(WAIT_ACTION, WAIT_ACTION)
    expect(env.getMatch().cooldowns.black).toBe(0)
  })

  it('判断待ち500msが双方に適用される', () => {
    const env = createTrainingEnv({
      seed: 3,
      cooldownMs: 700,
      blackThinkDelayMs: 500,
      whiteThinkDelayMs: 500,
    })
    const b0 = env.getActionMask('black')
    const w0 = env.getActionMask('white')
    expect(b0.slice(0, 100).every((v) => !v)).toBe(true)
    expect(w0.slice(0, 100).every((v) => !v)).toBe(true)
    expect(b0[WAIT_ACTION]).toBe(true)
    expect(w0[WAIT_ACTION]).toBe(true)

    for (let i = 0; i < 9; i += 1) env.step(WAIT_ACTION, WAIT_ACTION)
    // 9 ステップ後: 残り 50ms → 次 tick で ready（マスクは peek 込み）
    const bReady = env.getActionMask('black')
    const wReady = env.getActionMask('white')
    expect(bReady.some((v, i) => v && i < 100)).toBe(true)
    expect(wReady.some((v, i) => v && i < 100)).toBe(true)
  })

  it('片方がWAITを続けても相手と時間は進む', () => {
    const env = createTrainingEnv({
      seed: 9,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    const whitePlace = env
      .getActionMask('white')
      .findIndex((v, i) => v && i < 100)
    expect(whitePlace).toBeGreaterThanOrEqual(0)
    env.step(WAIT_ACTION, whitePlace)
    expect(env.getMatch().cooldowns.white).toBe(700 - GAME_CONFIG.stepMs)
    expect(env.getMatch().elapsedMs).toBe(GAME_CONFIG.stepMs)

    for (let i = 0; i < 10; i += 1) env.step(WAIT_ACTION, WAIT_ACTION)
    expect(env.getMatch().elapsedMs).toBe(GAME_CONFIG.stepMs * 11)
    expect(env.getMatch().cooldowns.black).toBe(0)
  })

  it('双方WAITでも合法手があれば制限時間で終了する', () => {
    const env = createTrainingEnv({
      seed: 1,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    while (!env.isTerminated() && !env.isTruncated()) {
      env.step(WAIT_ACTION, WAIT_ACTION)
    }
    expect(env.isTruncated()).toBe(false)
    expect(env.getMatch().endReason).toBe('time_up')
    expect(env.getMatch().elapsedMs).toBe(GAME_CONFIG.matchDurationMs)
  })
})

describe('学習環境 / マスク・観測・報酬', () => {
  it('マスクが合法性と時間条件に一致する', () => {
    const env = createTrainingEnv({
      seed: 5,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    const mask = env.getActionMask('black')
    expect(mask).toHaveLength(ACTION_SPACE_SIZE)
    expect(mask[WAIT_ACTION]).toBe(true)
    for (let a = 0; a < 100; a += 1) {
      if (!mask[a]) continue
      const req = actionToMoveRequest(a)!
      const probe = stepMatch(cloneMatchState(env.getMatch()), {
        black: req,
      })
      expect(probe.applied.some((x) => x.player === 'black')).toBe(true)
    }
  })

  it('黒白を切り替えても自分／相手の観測が正しい', () => {
    const match = createMatch({ seed: 11, cooldownMs: 700 })
    const gate = createIdleThinkGate()
    const asBlack = getSideObservation(match, 'black', gate, 500)
    const asWhite = getSideObservation(match, 'white', gate, 500)
    expect(asBlack.board).toHaveLength(100)
    expect(asWhite.board).toHaveLength(100)
    for (let i = 0; i < 100; i += 1) {
      expect(asBlack.board[i] === 0 ? 0 : asBlack.board[i]).toBe(
        asWhite.board[i] === 0 ? 0 : -(asWhite.board[i] ?? 0),
      )
      expect(Math.abs(asBlack.board[i]!)).toBe(Math.abs(asWhite.board[i]!))
      if (asBlack.board[i] !== 0) {
        expect(asBlack.board[i]).toBe(-(asWhite.board[i]!))
      }
    }
    expect(asBlack.myCooldownMs).toBe(asWhite.opponentCooldownMs)
    expect(asBlack.opponentCooldownMs).toBe(asWhite.myCooldownMs)
  })

  it('非公開情報が学習用観測に含まれない', () => {
    const env = createTrainingEnv({
      seed: 2,
      cooldownMs: 700,
      blackThinkDelayMs: 500,
      whiteThinkDelayMs: 500,
    })
    const obs = env.getObservation('black')
    const keys = Object.keys(obs)
    for (const forbidden of FORBIDDEN_OBSERVATION_KEYS) {
      expect(keys).not.toContain(forbidden)
    }
    expect(JSON.stringify(obs).includes('simultaneousPriority')).toBe(false)
    expect(toNormalizedVector(obs).values).toHaveLength(104)
  })

  it('終局報酬が重複して発生しない', () => {
    const env = createTrainingEnv({
      seed: 4,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    let last: { black: number; white: number } | null = null
    while (!env.isTerminated()) {
      last = env.step(WAIT_ACTION, WAIT_ACTION).rewards
    }
    expect(last).not.toBeNull()
    const terminal = last!
    if (env.getMatch().outcome === 'draw') {
      expect(terminal).toEqual({ black: 0, white: 0 })
    } else {
      expect(Math.abs(terminal.black)).toBe(1)
      expect(terminal.white).toBe(-terminal.black)
    }
    const again = env.step(WAIT_ACTION, WAIT_ACTION).rewards
    expect(again).toEqual({ black: 0, white: 0 })
    expect(env.getRewards()).toEqual(terminal)
  })

  it('終局後はマスクがすべて false', () => {
    const env = createTrainingEnv({
      seed: 8,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    while (!env.isTerminated()) env.step(WAIT_ACTION, WAIT_ACTION)
    const mask = buildActionMask(env.getMatch(), 'black', true)
    expect(mask.every((v) => !v)).toBe(true)
  })
})

describe('学習環境 / 同時着手と既存ルール一致', () => {
  it('同時着手の結果が既存 stepMatch と一致する', () => {
    const seed = 21
    const env = createTrainingEnv({
      seed,
      cooldownMs: 700,
      blackThinkDelayMs: 0,
      whiteThinkDelayMs: 0,
    })
    const b = env.getActionMask('black').findIndex((v, i) => v && i < 100)
    const w = env.getActionMask('white').findIndex((v, i) => v && i < 100)
    expect(b).toBeGreaterThanOrEqual(0)
    expect(w).toBeGreaterThanOrEqual(0)

    const direct = stepMatch(createMatch({ seed, cooldownMs: 700 }), {
      black: actionToMoveRequest(b)!,
      white: actionToMoveRequest(w)!,
    })
    env.step(b, w)
    expect(env.getMatch().board).toEqual(direct.state.board)
    expect(env.getMatch().cooldowns).toEqual(direct.state.cooldowns)
    expect(env.getMatch().simultaneousPriority).toBe(
      direct.state.simultaneousPriority,
    )
  })

  it('記録した要求列を共通ルールへ再生すると一致する', () => {
    const result = runCpuMatch({
      seed: 1000,
      cooldownMs: GAME_CONFIG.cooldownMs,
      blackThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
      whiteThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
      agents: { black: 'random', white: 'max_flip' },
      recordRequests: true,
    })
    expect(result.requestRecords).not.toBeNull()
    const records = result.requestRecords!

    let match = createMatch({
      seed: 1000,
      cooldownMs: GAME_CONFIG.cooldownMs,
    })
    for (let i = 0; i < records.length; i += 2) {
      const blackRec = records[i]!
      const whiteRec = records[i + 1]!
      expect(blackRec.side).toBe('black')
      expect(whiteRec.side).toBe('white')
      const input = {
        black:
          blackRec.row !== null && blackRec.col !== null
            ? { row: blackRec.row, col: blackRec.col }
            : undefined,
        white:
          whiteRec.row !== null && whiteRec.col !== null
            ? { row: whiteRec.row, col: whiteRec.col }
            : undefined,
      }
      match = stepMatch(match, input).state
      if (match.phase === 'finished') break
    }

    const again = runCpuMatch({
      seed: 1000,
      cooldownMs: GAME_CONFIG.cooldownMs,
      blackThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
      whiteThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
      agents: { black: 'random', white: 'max_flip' },
    })
    expect(again.outcome).toBe(result.outcome)
    expect(again.endReason).toBe(result.endReason)
    expect(again.stoneCounts).toEqual(result.stoneCounts)
    expect(again.elapsedMs).toBe(result.elapsedMs)
    expect(match.outcome).toBe(result.outcome)
    expect(match.endReason).toBe(result.endReason)
    expect(match.elapsedMs).toBe(result.elapsedMs)
  })
})
