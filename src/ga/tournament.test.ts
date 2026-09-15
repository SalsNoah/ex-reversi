import { describe, expect, it } from 'vitest'
import { playFirstToSeries, playFixedGames } from './tournament.ts'

describe('ga tournament first-to', () => {
  it('10本先取は先に10勝した側で打ち切る', () => {
    let games = 0
    const series = playFirstToSeries({
      firstTo: 10,
      playGame: (gameIndex, aIsBlack) => {
        games += 1
        expect(aIsBlack).toBe(gameIndex % 2 === 0)
        return 'a'
      },
    })
    expect(games).toBe(10)
    expect(series).toEqual({
      aWins: 10,
      bWins: 0,
      draws: 0,
      games: 10,
      winner: 'a',
    })
  })

  it('引き分けは勝ちに数えず続行する', () => {
    const series = playFirstToSeries({
      firstTo: 2,
      playGame: (gameIndex) => {
        if (gameIndex === 0) return 'draw'
        if (gameIndex === 1) return 'b'
        return 'a'
      },
    })
    expect(series.draws).toBe(1)
    expect(series.aWins).toBe(2)
    expect(series.bWins).toBe(1)
    expect(series.games).toBe(4)
    expect(series.winner).toBe('a')
  })
})

describe('ga tournament fixed games', () => {
  it('指定試合数を打ち切らずにすべて戦う', () => {
    const colors: boolean[] = []
    const series = playFixedGames({
      games: 4,
      playGame: (gameIndex, aIsBlack) => {
        colors.push(aIsBlack)
        if (gameIndex === 0) return 'a'
        if (gameIndex === 1) return 'b'
        if (gameIndex === 2) return 'draw'
        return 'a'
      },
    })
    expect(colors).toEqual([true, false, true, false])
    expect(series).toEqual({
      aWins: 2,
      bWins: 1,
      draws: 1,
      games: 4,
      winner: 'a',
    })
  })

  it('同数ならシリーズ引き分け', () => {
    const tied = playFixedGames({
      games: 2,
      playGame: (gameIndex) => (gameIndex === 0 ? 'a' : 'b'),
    })
    expect(tied).toEqual({
      aWins: 1,
      bWins: 1,
      draws: 0,
      games: 2,
      winner: null,
    })
  })
})
