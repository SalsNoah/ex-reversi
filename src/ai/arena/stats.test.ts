import { describe, expect, it } from 'vitest'
import {
  binomialTestTwoSided,
  eloFromScoreRate,
  fitBradleyTerryElo,
  llrGsprt,
  scoreRateFromElo,
  sprtDecision,
  wilsonInterval,
} from './stats.ts'

describe('Elo と得点率の往復', () => {
  it('0.5 は 0 Elo', () => {
    expect(eloFromScoreRate(0.5)).toBeCloseTo(0, 10)
    expect(scoreRateFromElo(0)).toBeCloseTo(0.5, 10)
  })

  it('往復しても値が戻る', () => {
    for (const p of [0.55, 0.6, 0.75, 0.9, 0.25]) {
      expect(scoreRateFromElo(eloFromScoreRate(p))).toBeCloseTo(p, 10)
    }
  })

  it('得点率が高いほど Elo も高い', () => {
    expect(eloFromScoreRate(0.6)).toBeGreaterThan(eloFromScoreRate(0.55))
    expect(eloFromScoreRate(0.45)).toBeLessThan(0)
  })
})

describe('Wilson 信頼区間', () => {
  it('試合数が増えると狭くなる', () => {
    const few = wilsonInterval(6, 10)
    const many = wilsonInterval(600, 1000)
    expect(few.high - few.low).toBeGreaterThan(many.high - many.low)
  })

  it('区間は得点率を含む', () => {
    const iv = wilsonInterval(55, 100)
    expect(iv.low).toBeLessThan(0.55)
    expect(iv.high).toBeGreaterThan(0.55)
  })

  it('0 勝でも 0〜1 に収まる', () => {
    const iv = wilsonInterval(0, 20)
    expect(iv.low).toBeGreaterThanOrEqual(0)
    expect(iv.high).toBeLessThanOrEqual(1)
    expect(iv.high).toBeGreaterThan(0)
  })
})

describe('二項検定', () => {
  it('五分なら有意でない', () => {
    expect(binomialTestTwoSided(50, 50)).toBeGreaterThan(0.9)
  })

  it('大差なら有意になる', () => {
    expect(binomialTestTwoSided(70, 30)).toBeLessThan(0.001)
  })

  it('同じ勝率でも試合数が多いほど p 値が小さい', () => {
    const small = binomialTestTwoSided(12, 8)
    const large = binomialTestTwoSided(120, 80)
    expect(large).toBeLessThan(small)
  })

  it('既知の値と一致する（10戦9勝の両側検定）', () => {
    // 2 * (C(10,9)+C(10,10))/2^10 = 2 * 11/1024
    expect(binomialTestTwoSided(9, 1)).toBeCloseTo((2 * 11) / 1024, 10)
  })

  it('試合がなければ 1', () => {
    expect(binomialTestTwoSided(0, 0)).toBe(1)
  })
})

describe('GSPRT', () => {
  const bounds = { elo0: 0, elo1: 20, alpha: 0.05, beta: 0.05 }

  it('勝ち越しで LLR が増える', () => {
    const even = llrGsprt(100, 0, 100, bounds)
    const winning = llrGsprt(130, 0, 70, bounds)
    expect(winning).toBeGreaterThan(even)
  })

  it('負け越しなら棄却側へ倒れる', () => {
    const decision = sprtDecision(30, 0, 120, bounds)
    expect(decision.verdict).toBe('reject')
  })

  it('大きく勝ち越せば採用になる', () => {
    const decision = sprtDecision(140, 0, 60, bounds)
    expect(decision.verdict).toBe('accept')
  })

  it('五分のままなら結論を出さない', () => {
    const decision = sprtDecision(20, 0, 20, bounds)
    expect(decision.verdict).toBe('continue')
  })
})

describe('Bradley–Terry の Elo 当てはめ', () => {
  it('強い順に並ぶ', () => {
    const elo = fitBradleyTerryElo([
      { aId: 'strong', bId: 'mid', aWins: 70, bWins: 30, draws: 0 },
      { aId: 'mid', bId: 'weak', aWins: 70, bWins: 30, draws: 0 },
      { aId: 'strong', bId: 'weak', aWins: 90, bWins: 10, draws: 0 },
    ])
    expect(elo.get('strong')!).toBeGreaterThan(elo.get('mid')!)
    expect(elo.get('mid')!).toBeGreaterThan(elo.get('weak')!)
  })

  it('総互角なら全員同じ', () => {
    const elo = fitBradleyTerryElo([
      { aId: 'a', bId: 'b', aWins: 50, bWins: 50, draws: 0 },
      { aId: 'b', bId: 'c', aWins: 50, bWins: 50, draws: 0 },
      { aId: 'a', bId: 'c', aWins: 50, bWins: 50, draws: 0 },
    ])
    expect(elo.get('a')!).toBeCloseTo(elo.get('b')!, 3)
    expect(elo.get('b')!).toBeCloseTo(elo.get('c')!, 3)
  })

  it('2者の Elo 差が勝率から求めた値に近い', () => {
    const elo = fitBradleyTerryElo([
      { aId: 'a', bId: 'b', aWins: 750, bWins: 250, draws: 0 },
    ])
    const diff = elo.get('a')! - elo.get('b')!
    expect(diff).toBeCloseTo(eloFromScoreRate(0.75), 0)
  })

  it('anchor を指定すると基準が揃う', () => {
    const elo = fitBradleyTerryElo(
      [{ aId: 'a', bId: 'b', aWins: 70, bWins: 30, draws: 0 }],
      { anchorId: 'b', anchorElo: 1500 },
    )
    expect(elo.get('b')!).toBeCloseTo(1500, 6)
    expect(elo.get('a')!).toBeGreaterThan(1500)
  })
})
