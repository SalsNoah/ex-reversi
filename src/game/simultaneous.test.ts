import { describe, expect, it } from 'vitest'
import {
  createEmptyBoard,
  createMatch,
  createRng,
  initialSimultaneousPriority,
  listLegalMoves,
  stepMatch,
} from './index.ts'
import type { Board, MatchState } from './index.ts'

/** 試合がすぐ終わらないよう、双方に残る石を追加する */
function withExtraLife(board: Board): Board {
  // 右下に独立した白黒（すぐには終わらない石数）
  board[8]![8] = 'black'
  board[8]![9] = 'white'
  board[9]![8] = 'white'
  board[9]![9] = 'black'
  return board
}

describe('同時着手', () => {
  it('双方が同じマスを要求した場合、優先側だけが置ける', () => {
    let state = createMatch({ seed: 10 })
    const board = withExtraLife(createEmptyBoard())
    board[5]![4] = 'white'
    board[5]![3] = 'black'
    state = { ...state, board, simultaneousPriority: 'black' }

    const result = stepMatch(state, {
      black: { row: 5, col: 5 },
      white: { row: 5, col: 5 },
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0]?.player).toBe('black')
    expect(result.state.board[5]![5]).toBe('black')
    expect(result.state.phase).toBe('playing')
    expect(
      result.rejected.some(
        (r) =>
          r.player === 'white' &&
          (r.reason === 'occupied' || r.reason === 'illegal'),
      ),
    ).toBe(true)
  })

  it('後から処理される側は更新後の盤面で合法性を再判定する', () => {
    let state = createMatch({ seed: 11 })
    const board = withExtraLife(createEmptyBoard())
    board[5]![4] = 'white'
    board[5]![3] = 'black'
    board[4]![5] = 'white'
    board[3]![5] = 'black'
    state = { ...state, board, simultaneousPriority: 'black' }

    const result = stepMatch(state, {
      black: { row: 5, col: 5 },
      white: { row: 5, col: 5 },
    })
    expect(result.applied[0]?.player).toBe('black')
    expect(result.rejected.some((r) => r.player === 'white')).toBe(true)
  })

  it('双方の要求が有効なら順番に両方成立する', () => {
    let state = createMatch({ seed: 12 })
    const board = withExtraLife(createEmptyBoard())
    board[5]![4] = 'white'
    board[5]![3] = 'black'
    board[2]![3] = 'black'
    board[2]![4] = 'white'
    state = { ...state, board, simultaneousPriority: 'black' }

    const result = stepMatch(state, {
      black: { row: 5, col: 5 },
      white: { row: 2, col: 2 },
    })
    expect(result.applied).toHaveLength(2)
    expect(result.state.board[5]![5]).toBe('black')
    expect(result.state.board[2]![2]).toBe('white')
    expect(result.state.cooldowns.black).toBeGreaterThan(0)
    expect(result.state.cooldowns.white).toBeGreaterThan(0)
  })

  it('不成立の側は待ち時間を消費しない', () => {
    let state = createMatch({ seed: 13 })
    const board = withExtraLife(createEmptyBoard())
    board[5]![4] = 'white'
    board[5]![3] = 'black'
    state = {
      ...state,
      board,
      simultaneousPriority: 'black',
      cooldowns: { black: 0, white: 0 },
    }

    const result = stepMatch(state, {
      black: { row: 5, col: 5 },
      white: { row: 5, col: 5 },
    })
    expect(result.state.cooldowns.black).toBeGreaterThan(0)
    expect(result.state.cooldowns.white).toBe(0)
  })

  it('同時着手の優先側が仕様どおり交代する', () => {
    const seed = 42
    const expectedFirst = initialSimultaneousPriority(seed)
    let state = createMatch({ seed })
    expect(state.simultaneousPriority).toBe(expectedFirst)

    const board = withExtraLife(createEmptyBoard())
    board[5]![4] = 'white'
    board[5]![3] = 'black'
    board[2]![3] = 'black'
    board[2]![4] = 'white'
    // 黒が続けて置けるよう追加の白を用意
    board[6]![5] = 'white'
    board[7]![5] = 'black'
    state = { ...state, board }

    const afterBoth = stepMatch(state, {
      black: { row: 5, col: 5 },
      white: { row: 2, col: 2 },
    }).state
    expect(afterBoth.simultaneousPriority).toBe(
      expectedFirst === 'black' ? 'white' : 'black',
    )

    const blackMoves = listLegalMoves(afterBoth.board, 'black')
    expect(blackMoves.length).toBeGreaterThan(0)
    const onlyOne = stepMatch(
      { ...afterBoth, cooldowns: { black: 0, white: 0 } },
      { black: blackMoves[0] },
    ).state
    expect(onlyOne.simultaneousPriority).toBe(afterBoth.simultaneousPriority)
  })

  it('試合シードから最初の優先側が決まる', () => {
    const a = createMatch({ seed: 0 }).simultaneousPriority
    const b = createMatch({ seed: 0 }).simultaneousPriority
    expect(a).toBe(b)
    expect(a).toBe(initialSimultaneousPriority(0))

    const rng = createRng(99)
    let black = 0
    for (let i = 0; i < 40; i += 1) {
      const s = rng.nextInt(0, 1_000_000)
      if (initialSimultaneousPriority(s) === 'black') black += 1
    }
    expect(black).toBeGreaterThan(5)
    expect(black).toBeLessThan(35)
  })
})

describe('同時着手: 終了直後の残り要求', () => {
  it('最後のマスへの着手で終了した場合、残りの要求を実行しない', () => {
    const board = createEmptyBoard()
    for (let r = 0; r < 10; r += 1) {
      for (let c = 0; c < 10; c += 1) {
        board[r]![c] = (r + c) % 2 === 0 ? 'black' : 'white'
      }
    }
    board[5]![5] = null
    board[5]![4] = 'white'
    board[5]![3] = 'black'

    const state: MatchState = {
      ...createMatch({ seed: 20 }),
      board,
      simultaneousPriority: 'black',
      cooldowns: { black: 0, white: 0 },
    }

    const result = stepMatch(state, {
      black: { row: 5, col: 5 },
      white: { row: 5, col: 5 },
    })

    expect(result.state.phase).toBe('finished')
    expect(result.state.endReason).toBe('board_full')
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0]?.player).toBe('black')
    expect(
      result.rejected.some(
        (r) => r.player === 'white' && r.reason === 'skipped_after_end',
      ),
    ).toBe(true)
  })
})
