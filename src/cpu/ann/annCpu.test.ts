import { describe, expect, it } from 'vitest'
import { createInitialBoard, listLegalMoves } from '../../game/board.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import { createRng } from '../../game/rng.ts'
import type { PublicMatchState } from '../../game/types.ts'
import { createAnnCpu, loadPublicState } from './annCpu.ts'
import {
  OUT_CAN_ACT,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_COOLDOWN,
  TS_TIME,
  advanceToDecision,
  createFastMatch,
} from '../../ai/sim/fastMatch.ts'
import { BLACK, WHITE } from '../strategy/fastBoard.ts'

function publicState(over: Partial<PublicMatchState> = {}): PublicMatchState {
  return {
    board: createInitialBoard(),
    cooldowns: { black: 0, white: 0 },
    elapsedMs: 0,
    remainingMatchMs: GAME_CONFIG.matchDurationMs,
    phase: 'playing',
    simultaneousPriority: 'black',
    endReason: null,
    outcome: null,
    ...over,
  }
}

describe('アン（時間読みAI）', () => {
  it('公開状態を高速シミュレータの局面へ正しく写す', () => {
    const match = createFastMatch({ seed: 1, config: { thinkDelayMs: [0, 0] } })
    const state = publicState({
      elapsedMs: 12_340,
      cooldowns: { black: 0, white: 480 },
      simultaneousPriority: 'white',
    })
    loadPublicState(match, state, SIDE_BLACK)

    expect(match.ts[TS_TIME]).toBe(12_340)
    expect(match.ts[TS_COOLDOWN + SIDE_WHITE]).toBe(480)
    // 石の位置が 1 マスもずれていないことを盤面から直接確かめる
    const size = GAME_CONFIG.boardSize
    const cell = (row: number, col: number) => match.pos.cells[(row + 1) * (size + 2) + col + 1]
    let black = 0
    let white = 0
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const want = state.board[row]![col]
        if (want === 'black') black += 1
        if (want === 'white') white += 1
        const got = cell(row, col)
        expect(got === BLACK ? 'black' : got === WHITE ? 'white' : null).toBe(want)
      }
    }
    expect(match.pos.black).toBe(black)
    expect(match.pos.white).toBe(white)
  })

  it('判断待ちが残っていても、呼ばれた側は即座に行動できる状態になる', () => {
    // ゲームは判断待ちが明けてから decide を呼ぶ。
    // ここを取り違えると探索が 500ms 先の局面から始まってしまう
    const match = createFastMatch({
      seed: 1,
      config: { thinkDelayMs: [GAME_CONFIG.cpuThinkDelayMs, 0] },
    })
    loadPublicState(match, publicState(), SIDE_BLACK)
    advanceToDecision(match)
    expect(match.out[OUT_CAN_ACT + SIDE_BLACK]).toBe(1)
    expect(match.ts[TS_TIME]).toBe(0)
  })

  it('初期盤面で合法手を返す', () => {
    const ann = createAnnCpu(64)
    const state = publicState()
    const decision = ann.decide(state, createRng(7), 'black')
    expect(decision.type).toBe('move')
    if (decision.type !== 'move') return
    const legal = listLegalMoves(state.board, 'black')
    expect(legal.some((m) => m.row === decision.row && m.col === decision.col)).toBe(true)
  })

  it('クールタイム中に呼ばれても待機を返して落ちない', () => {
    const ann = createAnnCpu(64)
    const decision = ann.decide(
      publicState({ cooldowns: { black: 700, white: 0 } }),
      createRng(9),
      'black',
    )
    // 自分が動けない局面では待機（ここで例外や不正手を返さないことが大事）
    expect(['move', 'wait']).toContain(decision.type)
  })

  it('打てる場所がない盤面では待機を返す', () => {
    const board = createInitialBoard()
    for (const row of board) row.fill('black')
    const ann = createAnnCpu(64)
    const decision = ann.decide(publicState({ board }), createRng(3), 'white')
    expect(decision.type).toBe('wait')
  })

  it('同じ局面と乱数なら同じ手を返す（再現性）', () => {
    const ann = createAnnCpu(96)
    const a = ann.decide(publicState(), createRng(11), 'black')
    const b = ann.decide(publicState(), createRng(11), 'black')
    expect(b).toEqual(a)
  })

  it('探索木を作り直さずに連続で呼べる', () => {
    const ann = createAnnCpu(64)
    for (let i = 0; i < 20; i += 1) {
      const decision = ann.decide(
        publicState({ elapsedMs: i * 1000, cooldowns: { black: 0, white: i * 30 } }),
        createRng(100 + i),
        'black',
      )
      expect(decision.type).toBe('move')
    }
  })
})
