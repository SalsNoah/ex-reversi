import { describe, expect, it } from 'vitest'
import { GAME_CONFIG } from '../game/config.ts'
import {
  applyAbort,
  applyMatchOutcome,
  canStartMatch,
  createMemoryStore,
  defaultLives,
  isPlayerDefeat,
  loadLives,
  localDateKey,
  LIVES_STORAGE_KEY,
  parseLives,
  recordAbort,
  recordMatchOutcome,
  restoreLives,
  shouldConsumeLifeOnAbort,
  shouldRecordMatchOutcome,
} from './lives.ts'

describe('ライフ', () => {
  it('初期は上限の5', () => {
    expect(GAME_CONFIG.livesMax).toBe(5)
    expect(defaultLives('2026-09-15')).toEqual({
      remaining: 5,
      date: '2026-09-15',
    })
    expect(canStartMatch(defaultLives('2026-09-15'))).toBe(true)
  })

  it('端末ローカルの暦日を YYYY-MM-DD にする', () => {
    expect(localDateKey(new Date(2026, 8, 15, 23, 59, 59))).toBe('2026-09-15')
    expect(localDateKey(new Date(2026, 8, 16, 0, 0, 0))).toBe('2026-09-16')
  })

  it('負けると1つ減る。勝ち・引き分けでは減らさない', () => {
    const start = { remaining: 5, date: '2026-09-15' }
    expect(applyMatchOutcome(start, 'white_win', '2026-09-15')).toEqual({
      remaining: 4,
      date: '2026-09-15',
    })
    expect(applyMatchOutcome(start, 'black_win', '2026-09-15')).toEqual(start)
    expect(applyMatchOutcome(start, 'draw', '2026-09-15')).toEqual(start)
    expect(applyMatchOutcome(start, null, '2026-09-15')).toEqual(start)
  })

  it('中断すると1つ減る', () => {
    const start = { remaining: 5, date: '2026-09-15' }
    expect(applyAbort(start, '2026-09-15')).toEqual({
      remaining: 4,
      date: '2026-09-15',
    })
    expect(applyAbort({ remaining: 0, date: '2026-09-15' }, '2026-09-15')).toEqual(
      { remaining: 0, date: '2026-09-15' },
    )
    expect(applyAbort({ remaining: 0, date: '2026-09-14' }, '2026-09-15')).toEqual(
      { remaining: 4, date: '2026-09-15' },
    )
  })

  it('プレイヤー敗北の判定は黒が負ける場合だけ', () => {
    expect(isPlayerDefeat('white_win')).toBe(true)
    expect(isPlayerDefeat('black_win')).toBe(false)
    expect(isPlayerDefeat('draw')).toBe(false)
    expect(isPlayerDefeat(null)).toBe(false)
  })

  it('残り0ではこれ以上減らさず開始できない', () => {
    const empty = { remaining: 0, date: '2026-09-15' }
    expect(applyMatchOutcome(empty, 'white_win', '2026-09-15')).toEqual(empty)
    expect(canStartMatch(empty)).toBe(false)
  })

  it('日付が変わると上限まで戻してから負けを適用する', () => {
    const emptyYesterday = { remaining: 0, date: '2026-09-14' }
    expect(restoreLives(emptyYesterday, '2026-09-15')).toEqual({
      remaining: 5,
      date: '2026-09-15',
    })
    expect(applyMatchOutcome(emptyYesterday, 'white_win', '2026-09-15')).toEqual(
      {
        remaining: 4,
        date: '2026-09-15',
      },
    )
    expect(applyMatchOutcome(emptyYesterday, 'black_win', '2026-09-15')).toEqual(
      {
        remaining: 5,
        date: '2026-09-15',
      },
    )
  })

  it('壊れた保存は初期化する', () => {
    expect(parseLives(null, '2026-09-15').remaining).toBe(5)
    expect(parseLives('not-json', '2026-09-15').remaining).toBe(5)
    expect(parseLives('{"remaining":99,"date":"2026-09-15"}', '2026-09-15')).toEqual(
      { remaining: 5, date: '2026-09-15' },
    )
    expect(parseLives('{"remaining":1.5,"date":"2026-09-15"}', '2026-09-15').remaining).toBe(
      5,
    )
    expect(parseLives('{"remaining":2,"date":"bad"}', '2026-09-15').remaining).toBe(
      5,
    )
  })

  it('結果画面へ入ったときだけ記録する', () => {
    expect(shouldRecordMatchOutcome('playing', 'result')).toBe(true)
    expect(shouldRecordMatchOutcome('countdown', 'result')).toBe(true)
    expect(shouldRecordMatchOutcome('result', 'result')).toBe(false)
    expect(shouldRecordMatchOutcome('playing', 'playing')).toBe(false)
    expect(shouldRecordMatchOutcome('title', 'countdown')).toBe(false)
  })

  it('一時停止からの中断で開始画面へ戻ったときだけライフを減らす', () => {
    expect(shouldConsumeLifeOnAbort('playing', 'title')).toBe(true)
    expect(shouldConsumeLifeOnAbort('playing', 'playing')).toBe(false)
    expect(shouldConsumeLifeOnAbort('result', 'title')).toBe(false)
    expect(shouldConsumeLifeOnAbort('countdown', 'title')).toBe(false)
  })

  it('記憶ストアへ読み書きし、日付が変わると復活する', () => {
    const store = createMemoryStore({
      [LIVES_STORAGE_KEY]: JSON.stringify({
        remaining: 1,
        date: '2026-09-14',
      }),
    })
    expect(loadLives(store, '2026-09-15')).toEqual({
      remaining: 5,
      date: '2026-09-15',
    })
    expect(JSON.parse(store.getItem(LIVES_STORAGE_KEY)!)).toEqual({
      remaining: 5,
      date: '2026-09-15',
    })

    const afterLoss = recordMatchOutcome(store, 'white_win', '2026-09-15')
    expect(afterLoss.remaining).toBe(4)
    expect(recordMatchOutcome(store, 'draw', '2026-09-15').remaining).toBe(4)
    expect(recordMatchOutcome(store, 'black_win', '2026-09-15').remaining).toBe(4)
    expect(recordMatchOutcome(store, 'white_win', '2026-09-15').remaining).toBe(3)
    expect(recordAbort(store, '2026-09-15').remaining).toBe(2)
  })
})
