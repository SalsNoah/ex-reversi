import { describe, expect, it } from 'vitest'
import {
  advanceMatch,
  createMatch,
  GAME_CONFIG,
  listLegalMoves,
  pauseMatch,
  resumeMatch,
  stepMatch,
} from './index.ts'

function firstLegal(
  state: ReturnType<typeof createMatch>,
  stone: 'black' | 'white',
) {
  const moves = listLegalMoves(state.board, stone)
  expect(moves.length).toBeGreaterThan(0)
  return moves[0]!
}

describe('時間: 待ち時間', () => {
  it('着手成功後は自分だけ待ち時間が発生する', () => {
    let state = createMatch({ seed: 2 })
    const move = firstLegal(state, 'black')
    const result = stepMatch(state, { black: move })
    state = result.state
    expect(result.applied).toHaveLength(1)
    expect(state.cooldowns.black).toBe(GAME_CONFIG.cooldownMs - GAME_CONFIG.stepMs)
    expect(state.cooldowns.white).toBe(0)
  })

  it('待ち時間終了前は置けず、終了時から置ける', () => {
    let state = createMatch({ seed: 3 })
    const first = firstLegal(state, 'black')
    state = stepMatch(state, { black: first }).state

    const during = firstLegal(state, 'black')
    const rejected = stepMatch(state, { black: during })
    expect(rejected.applied).toHaveLength(0)
    expect(rejected.rejected.some((r) => r.reason === 'cooldown')).toBe(true)
    // 待ち時間は消費されない（このステップの自然減少のみ）
    expect(rejected.state.cooldowns.black).toBe(
      state.cooldowns.black - GAME_CONFIG.stepMs,
    )

    state = advanceMatch(state, GAME_CONFIG.cooldownMs)
    expect(state.cooldowns.black).toBe(0)

    const again = firstLegal(state, 'black')
    const ok = stepMatch(state, { black: again })
    expect(ok.applied).toHaveLength(1)
  })

  it('相手が着手しなくても、自分の待ち時間が終われば再び置ける', () => {
    let state = createMatch({ seed: 4 })
    state = stepMatch(state, { black: firstLegal(state, 'black') }).state
    state = advanceMatch(state, GAME_CONFIG.cooldownMs)
    const second = stepMatch(state, { black: firstLegal(state, 'black') })
    expect(second.applied).toHaveLength(1)
    expect(second.applied[0]?.player).toBe('black')
  })

  it('長く待っても2回分の着手権は貯まらない', () => {
    let state = createMatch({ seed: 5 })
    state = stepMatch(state, { black: firstLegal(state, 'black') }).state
    state = advanceMatch(state, GAME_CONFIG.cooldownMs * 5)
    expect(state.cooldowns.black).toBe(0)

    // 1回置ける
    state = stepMatch(state, { black: firstLegal(state, 'black') }).state
    expect(state.cooldowns.black).toBeGreaterThan(0)

    // 同ステップに2回目の要求は受け付けない（1人1件）→ 次ステップでもCD中
    const extra = stepMatch(state, { black: firstLegal(state, 'black') })
    expect(extra.applied).toHaveLength(0)
    expect(extra.rejected.some((r) => r.reason === 'cooldown')).toBe(true)
  })

  it('双方の待ち時間が残っているだけでは試合終了にならない', () => {
    let state = createMatch({ seed: 6 })
    state = stepMatch(state, {
      black: firstLegal(state, 'black'),
      white: firstLegal(state, 'white'),
    }).state
    expect(state.cooldowns.black).toBeGreaterThan(0)
    expect(state.cooldowns.white).toBeGreaterThan(0)
    expect(state.phase).toBe('playing')
    state = advanceMatch(state, 1000)
    expect(state.phase).toBe('playing')
  })

  it('一時停止中はすべてのゲーム内時間が進まない', () => {
    let state = createMatch({ seed: 7 })
    state = stepMatch(state, { black: firstLegal(state, 'black') }).state
    const elapsed = state.elapsedMs
    const cd = { ...state.cooldowns }

    state = pauseMatch(state)
    state = stepMatch(state, { white: firstLegal(state, 'white') }).state
    state = stepMatch(state).state
    state = stepMatch(state).state

    expect(state.elapsedMs).toBe(elapsed)
    expect(state.cooldowns).toEqual(cd)
    expect(state.phase).toBe('paused')

    state = resumeMatch(state)
    expect(state.phase).toBe('playing')
    // 再開直後に停止前入力は実行されない（この step に入力なし）
    const after = stepMatch(state)
    expect(after.applied).toHaveLength(0)
    expect(after.state.elapsedMs).toBe(elapsed + GAME_CONFIG.stepMs)
  })
})
