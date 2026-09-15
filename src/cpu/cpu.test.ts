import { describe, expect, it } from 'vitest'
import {
  collectFlips,
  createEmptyBoard,
  createMatch,
  createRng,
  listLegalMoves,
  toPublicMatchState,
} from '../game/index.ts'
import { gaBestCpu, maxFlipCpu, randomCpu, waitCpu, CPU_OPTIONS, getCpuAgent, GA_MILESTONES } from './index.ts'
import { GA_BEST_GENES, GA_BEST_META } from './gaBestGenes.ts'


describe('簡易CPU', () => {
  it('ランダム型は合法手から選ぶ', () => {
    const match = createMatch({ seed: 7 })
    const pub = toPublicMatchState(match)
    const legal = listLegalMoves(pub.board, 'white')
    expect(legal.length).toBeGreaterThan(0)

    const rng = createRng(7)
    const decision = randomCpu.decide(pub, rng, 'white')
    expect(decision.type).toBe('move')
    if (decision.type === 'move') {
      expect(
        legal.some((m) => m.row === decision.row && m.col === decision.col),
      ).toBe(true)
    }
  })

  it('即時反転数優先型は最大反転の手を選ぶ', () => {
    const board = createEmptyBoard()
    // (5,5) で2枚、(2,2) で1枚返せる白の手を用意
    board[5]![4] = 'black'
    board[5]![3] = 'black'
    board[5]![2] = 'white'
    board[2]![3] = 'black'
    board[2]![4] = 'white'

    const match = { ...createMatch({ seed: 1 }), board }
    const pub = toPublicMatchState(match)
    const moves = listLegalMoves(pub.board, 'white')
    const scored = moves.map((m) => ({
      ...m,
      flips: collectFlips(pub.board, m.row, m.col, 'white').length,
    }))
    const max = Math.max(...scored.map((s) => s.flips))
    expect(max).toBeGreaterThan(0)

    const decision = maxFlipCpu.decide(pub, createRng(3), 'white')
    expect(decision.type).toBe('move')
    if (decision.type === 'move') {
      const flips = collectFlips(
        pub.board,
        decision.row,
        decision.col,
        'white',
      ).length
      expect(flips).toBe(max)
    }
  })

  it('合法手がないときは待機する', () => {
    const board = createEmptyBoard()
    board[0]![0] = 'black'
    const match = { ...createMatch({ seed: 2 }), board }
    const decision = randomCpu.decide(
      toPublicMatchState(match),
      createRng(2),
      'white',
    )
    expect(decision).toEqual({ type: 'wait' })
  })

  it('待機型は常に待機し画面選択肢には出ない', () => {
    const match = createMatch({ seed: 2 })
    expect(
      waitCpu.decide(toPublicMatchState(match), createRng(1), 'white'),
    ).toEqual({ type: 'wait' })
    expect(CPU_OPTIONS.some((option) => option.id === 'wait')).toBe(false)
  })

  it('GA育成代表は埋め込み遺伝子で着手またはWAITを返す', () => {
    expect(GA_BEST_GENES).toHaveLength(36)
    expect(GA_BEST_META.generation).toBeGreaterThanOrEqual(20)
    const match = createMatch({ seed: 11 })
    const pub = toPublicMatchState(match)
    const legal = listLegalMoves(pub.board, 'white')
    const d1 = gaBestCpu.decide(pub, createRng(11), 'white')
    const d2 = gaBestCpu.decide(pub, createRng(11), 'white')
    expect(d1).toEqual(d2)
    if (d1.type === 'move') {
      expect(
        legal.some((m) => m.row === d1.row && m.col === d1.col),
      ).toBe(true)
    }
  })

  it('15世代から5世代ごとのGAマイルストーンを選べる', () => {
    expect(GA_MILESTONES.map((m) => m.generation)).toEqual([
      15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
    ])
    expect(GA_BEST_META.generation).toBe(90)
    expect(GA_BEST_META.sourceId).toBe('elite-g90-b0aih8')
    for (const m of GA_MILESTONES) {
      expect(CPU_OPTIONS.some((o) => o.id === m.id)).toBe(true)
    }
    const g100 = getCpuAgent('ga_g100')
    const match = createMatch({ seed: 11 })
    const pub = toPublicMatchState(match)
    const d = g100.decide(pub, createRng(11), 'white')
    if (d.type === 'move') {
      const legal = listLegalMoves(pub.board, 'white')
      expect(legal.some((m) => m.row === d.row && m.col === d.col)).toBe(true)
    }
  })
})
