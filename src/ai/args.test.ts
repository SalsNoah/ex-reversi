/**
 * `--games=900` を取りこぼして既定の 600 局 × 5 世代で 1 時間走らせた事故の再発防止。
 */
import { describe, expect, it } from 'vitest'
import { assertAllFlagsUsed, flag, num, parseArgs, str } from './args.ts'

describe('CLI の引数解析', () => {
  it('--key=value を読む', () => {
    const args = parseArgs(['--games=900', '--selfplay-sims=96'])
    expect(num(args, 'games', 600)).toBe(900)
    expect(num(args, 'selfplay-sims', 1)).toBe(96)
  })

  it('--key value も読む', () => {
    const args = parseArgs(['--games', '900', '--tag', 'run2'])
    expect(num(args, 'games', 600)).toBe(900)
    expect(str(args, 'tag', 'manual')).toBe('run2')
  })

  it('値のないフラグは真になる', () => {
    const args = parseArgs(['--sprt', '--prune'])
    expect(flag(args, 'sprt')).toBe(true)
    expect(flag(args, 'prune')).toBe(true)
    expect(flag(args, 'missing')).toBe(false)
  })

  it('負の数を値として読む', () => {
    const args = parseArgs(['--lr=-0.5'])
    expect(num(args, 'lr', 0)).toBe(-0.5)
  })

  it('位置引数とフラグを混ぜられる', () => {
    const args = parseArgs(['heur@256', 'legacy_strategy', '--games=40'])
    expect(args.positional).toEqual(['heur@256', 'legacy_strategy'])
    expect(num(args, 'games', 1)).toBe(40)
  })

  it('数値でない値は例外にする', () => {
    const args = parseArgs(['--games=abc'])
    expect(() => num(args, 'games', 600)).toThrow('--games must be a number')
  })

  it('読まれなかったフラグがあれば止める', () => {
    const args = parseArgs(['--games=900', '--gamez=900'])
    num(args, 'games', 600)
    expect(() => assertAllFlagsUsed(args)).toThrow('--gamez')
  })

  it('全部読んでいれば通る', () => {
    const args = parseArgs(['--games=900', '--sprt'])
    num(args, 'games', 600)
    flag(args, 'sprt')
    expect(() => assertAllFlagsUsed(args)).not.toThrow()
  })
})
