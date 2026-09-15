import { describe, expect, it } from 'vitest'

/**
 * 実時間ループの復帰ギャップ処理は useGameSession 内にある。
 * ここでは「大きな rawDt をまとめ進めしない」方針を数値で固定する。
 */
describe('実時間ループの復帰', () => {
  it('250ms超のギャップはゲーム内時間に加算しない', () => {
    const STEP = 50
    const absorb = (rawDt: number): number =>
      rawDt > 250 ? 0 : Math.max(0, rawDt)

    expect(absorb(16)).toBe(16)
    expect(absorb(50)).toBe(50)
    expect(absorb(251)).toBe(0)
    expect(absorb(5000)).toBe(0)

    // 通常フレームでは約1ステップ相当までしか溜まらない
    let acc = 0
    acc += absorb(16)
    expect(Math.floor(acc / STEP)).toBe(0)
    acc += absorb(40)
    expect(Math.floor(acc / STEP)).toBe(1)
  })
})
