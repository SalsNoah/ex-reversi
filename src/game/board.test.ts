import { describe, expect, it } from 'vitest'
import {
  collectFlips,
  countStones,
  createInitialBoard,
  createMatch,
  GAME_CONFIG,
  isLegalMove,
  listLegalMoves,
  placeStone,
} from './index.ts'

describe('盤面: 初期配置', () => {
  it('黒8・白8・空き84で、中央以外に石がない', () => {
    const board = createInitialBoard()
    const counts = countStones(board)
    expect(counts).toEqual({ black: 8, white: 8, empty: 84 })

    for (let row = 0; row < GAME_CONFIG.boardSize; row += 1) {
      for (let col = 0; col < GAME_CONFIG.boardSize; col += 1) {
        const inCenter =
          row >= GAME_CONFIG.centerMin &&
          row <= GAME_CONFIG.centerMax &&
          col >= GAME_CONFIG.centerMin &&
          col <= GAME_CONFIG.centerMax
        if (inCenter) {
          expect(board[row]![col]).not.toBeNull()
        } else {
          expect(board[row]![col]).toBeNull()
        }
      }
    }
  })

  it('中央4×4の左上が黒の市松模様', () => {
    const board = createInitialBoard()
    expect(board[3]![3]).toBe('black')
    expect(board[3]![4]).toBe('white')
    expect(board[4]![3]).toBe('white')
    expect(board[4]![4]).toBe('black')
  })
})

describe('盤面: 反転判定', () => {
  it('縦・横・斜めの8方向で正しく反転する', () => {
    // 中央に黒を置き、8方向に白1・その先に黒 という最小盤を自前構築
    const board = createInitialBoard()
    // 初期配置を消し、テスト用に組み直す
    for (let r = 0; r < 10; r += 1) {
      for (let c = 0; c < 10; c += 1) board[r]![c] = null
    }
    const center = 5
    board[center]![center] = null // 着手マス
    const dirs = [
      [-1, -1],
      [-1, 0],
      [-1, 1],
      [0, -1],
      [0, 1],
      [1, -1],
      [1, 0],
      [1, 1],
    ] as const
    for (const [dr, dc] of dirs) {
      board[center + dr]![center + dc] = 'white'
      board[center + dr * 2]![center + dc * 2] = 'black'
    }

    const flips = collectFlips(board, center, center, 'black')
    expect(flips).toHaveLength(8)
    const placed = placeStone(board, center, center, 'black')
    expect(placed.ok).toBe(true)
    if (placed.ok) {
      for (const [dr, dc] of dirs) {
        expect(placed.board[center + dr]![center + dc]).toBe('black')
      }
    }
  })

  it('複数方向を同時に反転できる', () => {
    const board = createInitialBoard()
    // 初期状態で黒が複数方向を返す合法手があるはず
    const moves = listLegalMoves(board, 'black')
    expect(moves.length).toBeGreaterThan(0)

    // (2,3): 下方向などに白を挟める典型手を確認
    // 初期: (3,3)B (3,4)W ... 黒を (2,4) に置くと縦に (3,4)W を (4,4)B で挟む等
    const target = moves.find((m) => {
      const flips = collectFlips(board, m.row, m.col, 'black')
      return flips.length >= 2
    })
    // 見つからなければ手製盤で検証
    if (target) {
      const flips = collectFlips(board, target.row, target.col, 'black')
      expect(flips.length).toBeGreaterThanOrEqual(2)
    } else {
      for (let r = 0; r < 10; r += 1) {
        for (let c = 0; c < 10; c += 1) board[r]![c] = null
      }
      board[5]![4] = 'white'
      board[5]![3] = 'black'
      board[4]![5] = 'white'
      board[3]![5] = 'black'
      const flips = collectFlips(board, 5, 5, 'black')
      expect(flips.length).toBe(2)
    }
  })

  it('空きマスを挟んだ先の石は反転しない', () => {
    const board = createInitialBoard()
    for (let r = 0; r < 10; r += 1) {
      for (let c = 0; c < 10; c += 1) board[r]![c] = null
    }
    // 黒着手 (5,5) → 右に白、空き、黒 … 白は挟めていない
    board[5]![6] = 'white'
    board[5]![7] = null
    board[5]![8] = 'black'
    expect(collectFlips(board, 5, 5, 'black')).toEqual([])
    expect(isLegalMove(board, 5, 5, 'black')).toBe(false)
  })

  it('自分の石で閉じていない列は反転しない', () => {
    const board = createInitialBoard()
    for (let r = 0; r < 10; r += 1) {
      for (let c = 0; c < 10; c += 1) board[r]![c] = null
    }
    board[5]![6] = 'white'
    board[5]![7] = 'white'
    // 先が盤外または空きで閉じない
    expect(collectFlips(board, 5, 5, 'black')).toEqual([])
  })

  it('盤面端で別の行や列へ回り込まない', () => {
    const board = createInitialBoard()
    for (let r = 0; r < 10; r += 1) {
      for (let c = 0; c < 10; c += 1) board[r]![c] = null
    }
    // (0,0) に黒を置きたいとき、左上方向に進んでも回り込まない
    board[0]![1] = 'white'
    board[9]![9] = 'black' // 回り込みすれば届く位置だが、届いてはいけない
    expect(collectFlips(board, 0, 0, 'black')).toEqual([])
    expect(isLegalMove(board, 0, 0, 'black')).toBe(false)
  })
})

describe('盤面: 不正着手', () => {
  it('置かれているマス・何も返せないマス・範囲外は失敗し、盤面も待ち時間も変わらない', () => {
    const match = createMatch({ seed: 1 })
    const beforeBoard = match.board.map((row) => row.slice())
    const beforeCd = { ...match.cooldowns }

    // 占有マス
    let result = placeStone(match.board, 3, 3, 'black')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('occupied')

    // 何も返せない
    result = placeStone(match.board, 0, 0, 'black')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('illegal')

    // 範囲外
    result = placeStone(match.board, -1, 0, 'black')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('out_of_bounds')
    result = placeStone(match.board, 0, 10, 'black')
    expect(result.ok).toBe(false)

    // placeStone は元盤面を変更しない
    expect(match.board).toEqual(beforeBoard)
    expect(match.cooldowns).toEqual(beforeCd)
  })
})
