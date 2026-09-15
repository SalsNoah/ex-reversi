import { describe, expect, it } from 'vitest'
import {
  advanceMatch,
  countStones,
  createEmptyBoard,
  createMatch,
  createRng,
  GAME_CONFIG,
  listLegalMoves,
  stepMatch,
  toPublicMatchState,
} from './index.ts'
import type { Board, MatchState, MoveRequest, Stone } from './index.ts'

function withBoard(state: MatchState, board: Board): MatchState {
  return { ...state, board }
}

/** 黒だけが (0,0) に置ける。空きはそこだけ。 */
function boardBlackOnlyMove(): Board {
  const board = createEmptyBoard()
  for (let r = 0; r < 10; r += 1) {
    for (let c = 0; c < 10; c += 1) {
      board[r]![c] = 'black'
    }
  }
  board[0]![0] = null
  board[0]![1] = 'white'
  return board
}

describe('終了判定', () => {
  it('片方だけ合法手がない場合は終了しない', () => {
    let state = createMatch({ seed: 30 })
    const board = boardBlackOnlyMove()
    state = withBoard(state, board)

    expect(listLegalMoves(state.board, 'black').length).toBeGreaterThan(0)
    expect(listLegalMoves(state.board, 'white').length).toBe(0)

    state = stepMatch(state).state
    expect(state.phase).toBe('playing')
  })

  it('双方に合法手がない場合は終了する', () => {
    let state = createMatch({ seed: 31 })
    // 黒だけの石と空き → 相手がいないので双方合法手なし
    const board = createEmptyBoard()
    board[0]![0] = 'black'
    board[0]![1] = 'black'
    board[1]![0] = 'black'
    state = withBoard(state, board)

    expect(listLegalMoves(state.board, 'black').length).toBe(0)
    expect(listLegalMoves(state.board, 'white').length).toBe(0)

    state = stepMatch(state).state
    expect(state.phase).toBe('finished')
    expect(state.endReason).toBe('no_legal_moves')
    expect(state.outcome).toBe('black_win')
  })

  it('時間切れ・勝ち・負け・引き分けを判定できる', () => {
    let timed = createMatch({ seed: 32 })
    timed = advanceMatch(timed, GAME_CONFIG.matchDurationMs)
    expect(timed.phase).toBe('finished')
    expect(timed.endReason).toBe('time_up')
    expect(timed.outcome).toBe('draw')

    let blackWin = createMatch({ seed: 33 })
    const bb = createEmptyBoard()
    bb[0]![0] = 'black'
    bb[0]![1] = 'black'
    bb[0]![2] = 'black'
    bb[9]![9] = 'white'
    // 離れており合法手なし
    expect(listLegalMoves(bb, 'black').length).toBe(0)
    expect(listLegalMoves(bb, 'white').length).toBe(0)
    blackWin = withBoard(blackWin, bb)
    blackWin = stepMatch(blackWin).state
    expect(blackWin.phase).toBe('finished')
    expect(blackWin.outcome).toBe('black_win')

    let whiteWin = createMatch({ seed: 34 })
    const wb = createEmptyBoard()
    wb[0]![0] = 'white'
    wb[0]![1] = 'white'
    wb[0]![2] = 'white'
    wb[9]![9] = 'black'
    whiteWin = withBoard(whiteWin, wb)
    whiteWin = stepMatch(whiteWin).state
    expect(whiteWin.outcome).toBe('white_win')

    let draw = createMatch({ seed: 35 })
    const db = createEmptyBoard()
    db[0]![0] = 'black'
    db[0]![1] = 'black'
    db[9]![8] = 'white'
    db[9]![9] = 'white'
    draw = withBoard(draw, db)
    draw = stepMatch(draw).state
    expect(draw.outcome).toBe('draw')
  })

  it('終了後の入力で状態が変わらない', () => {
    let state = createMatch({ seed: 36 })
    state = advanceMatch(state, GAME_CONFIG.matchDurationMs)
    expect(state.phase).toBe('finished')

    const snapshot = {
      board: state.board.map((r) => r.slice()),
      elapsedMs: state.elapsedMs,
      cooldowns: { ...state.cooldowns },
      outcome: state.outcome,
    }

    const moves = listLegalMoves(state.board, 'black')
    const input = moves[0] ?? { row: 0, col: 0 }
    const after = stepMatch(state, { black: input, white: input })
    expect(after.state.board).toEqual(snapshot.board)
    expect(after.state.elapsedMs).toBe(snapshot.elapsedMs)
    expect(after.state.cooldowns).toEqual(snapshot.cooldowns)
    expect(after.state.outcome).toBe(snapshot.outcome)
    expect(after.applied).toHaveLength(0)
  })
})

describe('公開状態', () => {
  it('CPU向け公開状態に盤面・待ち時間・残り試合時間が含まれる', () => {
    const state = createMatch({ seed: 40 })
    const pub = toPublicMatchState(state)
    expect(pub.board).toEqual(state.board)
    expect(pub.cooldowns).toEqual(state.cooldowns)
    expect(pub.remainingMatchMs).toBe(GAME_CONFIG.matchDurationMs)
    expect(pub.elapsedMs).toBe(0)
    pub.board[3]![3] = null
    expect(state.board[3]![3]).toBe('black')
  })
})

describe('不正着手と試合状態', () => {
  it('不正着手では盤面と待ち時間が変わらない', () => {
    const state = createMatch({ seed: 41 })
    const before = {
      board: state.board.map((r) => r.slice()),
      cooldowns: { ...state.cooldowns },
    }
    const result = stepMatch(state, { black: { row: 0, col: 0 } })
    expect(result.applied).toHaveLength(0)
    expect(result.rejected[0]?.reason).toBe('illegal')
    // 時間ステップ分のクールダウン減少のみ（元々0）
    expect(result.state.board).toEqual(before.board)
    expect(result.state.cooldowns.black).toBe(0)
    expect(result.state.cooldowns.white).toBe(0)
  })
})

describe('ランダム仮想対戦', () => {
  function playRandom(seed: number): MatchState {
    const rng = createRng(seed)
    let state = createMatch({ seed })

    while (state.phase === 'playing') {
      const input: { black?: MoveRequest; white?: MoveRequest } = {}

      for (const stone of ['black', 'white'] as Stone[]) {
        if (state.cooldowns[stone] > 0) continue
        const moves = listLegalMoves(state.board, stone)
        if (moves.length === 0) continue
        const pick = moves[rng.nextInt(0, moves.length)]!
        input[stone] = pick
      }

      state = stepMatch(state, input).state
    }

    return state
  }

  it('複数シードで最後まで矛盾なく終了する', () => {
    const seeds = [1, 2, 3, 7, 11, 42, 99, 12345]
    for (const seed of seeds) {
      const state = playRandom(seed)
      expect(state.phase).toBe('finished')
      expect(state.endReason).not.toBeNull()
      expect(state.outcome).not.toBeNull()

      const counts = countStones(state.board)
      expect(counts.black + counts.white + counts.empty).toBe(
        GAME_CONFIG.boardSize * GAME_CONFIG.boardSize,
      )
      expect(counts.black + counts.white).toBeGreaterThan(0)

      if (state.endReason === 'board_full') {
        expect(counts.empty).toBe(0)
      }
      if (state.endReason === 'no_legal_moves') {
        expect(listLegalMoves(state.board, 'black')).toHaveLength(0)
        expect(listLegalMoves(state.board, 'white')).toHaveLength(0)
      }
      if (state.endReason === 'time_up') {
        expect(state.elapsedMs).toBeGreaterThanOrEqual(
          GAME_CONFIG.matchDurationMs,
        )
      }

      if (state.outcome === 'black_win') {
        expect(counts.black).toBeGreaterThan(counts.white)
      }
      if (state.outcome === 'white_win') {
        expect(counts.white).toBeGreaterThan(counts.black)
      }
      if (state.outcome === 'draw') {
        expect(counts.black).toBe(counts.white)
      }

      const again = playRandom(seed)
      expect(again.outcome).toBe(state.outcome)
      expect(again.endReason).toBe(state.endReason)
      expect(again.board).toEqual(state.board)
    }
  })
})
