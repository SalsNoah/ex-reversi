import { describe, expect, it } from 'vitest'
import {
  collectFlips,
  countStones,
  createEmptyBoard,
  createInitialBoard,
  createMatch,
  createRng,
  listLegalMoves,
  placeStone,
  toPublicMatchState,
} from '../../game/index.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import type { Board, Stone } from '../../game/types.ts'
import {
  BLACK,
  DIRS,
  EMPTY_HEAD,
  WHITE,
  cellIndex,
  colOf,
  colorOf,
  createFastPosition,
  doMove,
  generateMoves,
  hasMoves,
  loadBoard,
  rowOf,
  undoMove,
} from './fastBoard.ts'
import { countStable, lastStableFlags } from './stability.ts'
import {
  DEFAULT_WEIGHTS,
  WIN_SCORE,
  applyWeights,
  buildWeightTables,
  evaluateLeaf,
  scanLeaf,
  terminalScore,
  type WeightTables,
} from './evaluate.ts'
import {
  createPonderSession,
  nodeBudgetFor,
  ponderBudgetFor,
  searchBestMove,
  type SearchSchedule,
} from './search.ts'
import { createPaceTracker, notePlayedMove, observePace } from './pace.ts'
import {
  MASTER_LEVEL,
  createStrategyCpu,
  decideStrategyMove,
  ponderStrategyMove,
  strategyCpu,
} from './strategyCpu.ts'
import { ALPHA_LEVEL, ALPHA_WEIGHT_SPEC, alphaCpu } from './alphaCpu.ts'
import { BETA_LEVEL, BETA_WEIGHT_SPEC, betaCpu } from './betaCpu.ts'
import { GAMMA_LEVEL } from './gammaCpu.ts'
import { DELTA_LEVEL, DELTA_WEIGHT_SPEC } from './deltaCpu.ts'
import { EPSILON_LEVEL, EPSILON_WEIGHT_SPEC } from './epsilonCpu.ts'
import { DEFAULT_WEIGHT_SPEC } from './evaluate.ts'
import { runPacedMatch } from './pacedMatch.ts'
import { CPU_OPTIONS, getCpuAgent } from '../index.ts'
import {
  advanceSession,
  createTitleSession,
  queuePlayerMove,
  startCountdown,
  stepSession,
} from '../../session/index.ts'

function playout(seed: number, plies: number): Board {
  const rng = createRng(seed)
  let board = createInitialBoard()
  for (let k = 0; k < plies; k += 1) {
    const stone: Stone = k % 2 === 0 ? 'black' : 'white'
    const legal = listLegalMoves(board, stone)
    if (legal.length === 0) continue
    const pick = legal[rng.nextInt(0, legal.length)]
    const placed = placeStone(board, pick.row, pick.col, stone)
    if (!placed.ok) throw new Error('illegal move in playout')
    board = placed.board
  }
  return board
}

function publicStateFor(board: Board, seed = 1) {
  return toPublicMatchState({ ...createMatch({ seed }), board })
}

const SYMMETRIC_SCHEDULE: SearchSchedule = {
  selfNextMs: 0,
  oppNextMs: GAME_CONFIG.cpuThinkDelayMs,
  selfIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
  oppIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
  selfReactionMs: GAME_CONFIG.cpuThinkDelayMs,
  oppReactionMs: GAME_CONFIG.cpuThinkDelayMs,
  matchRemainingMs: GAME_CONFIG.matchDurationMs,
}

/**
 * 枝刈り・置換表・手順付けを一切使わない素の最小最大。
 * 高速化した探索がこれと同じ値を返すことを確かめるための基準。
 */
function referenceMinimax(
  pos: ReturnType<typeof createFastPosition>,
  me: number,
  selfNextMs: number,
  oppNextMs: number,
  depth: number,
): number {
  if (pos.emptyCount === 0) return terminalScore(pos, me)
  const selfTurn = selfNextMs <= oppNextMs
  const now = selfTurn ? selfNextMs : oppNextMs
  if (now >= SYMMETRIC_SCHEDULE.matchRemainingMs) return terminalScore(pos, me)
  if (depth <= 0) return evaluateLeaf(pos, me, selfTurn)

  const side = selfTurn ? me : me ^ 3
  const moves = new Int32Array(96)
  const count = generateMoves(pos, side, moves, 0)
  if (count === 0) {
    if (!hasMoves(pos, side ^ 3)) return terminalScore(pos, me)
    if (selfTurn) {
      return referenceMinimax(
        pos,
        me,
        oppNextMs + SYMMETRIC_SCHEDULE.selfReactionMs,
        oppNextMs,
        depth,
      )
    }
    return referenceMinimax(
      pos,
      me,
      selfNextMs,
      selfNextMs + SYMMETRIC_SCHEDULE.oppReactionMs,
      depth,
    )
  }

  let best = selfTurn ? -Infinity : Infinity
  for (let k = 0; k < count; k += 1) {
    const move = moves[k]
    const flips = doMove(pos, move, side)
    const value = referenceMinimax(
      pos,
      me,
      selfTurn ? selfNextMs + SYMMETRIC_SCHEDULE.selfIntervalMs : selfNextMs,
      selfTurn ? oppNextMs : oppNextMs + SYMMETRIC_SCHEDULE.oppIntervalMs,
      depth - 1,
    )
    undoMove(pos, move, side, flips)
    if (selfTurn) best = Math.max(best, value)
    else best = Math.min(best, value)
  }
  return best
}

describe('戦略AI 探索用盤面', () => {
  it('合法手と反転がルール層と一致する', () => {
    const pos = createFastPosition()
    const buffer = new Int32Array(96)
    let checked = 0

    for (let seed = 1; seed <= 12; seed += 1) {
      for (const plies of [0, 8, 20, 34, 48, 66]) {
        const board = playout(seed * 131, plies)
        loadBoard(pos, board)
        for (const stone of ['black', 'white'] as const) {
          const color = colorOf(stone)
          const expected = listLegalMoves(board, stone)
            .map((m) => `${m.row},${m.col}`)
            .sort()
          const n = generateMoves(pos, color, buffer, 0)
          const actual: string[] = []
          for (let k = 0; k < n; k += 1) {
            actual.push(`${rowOf(buffer[k])},${colOf(buffer[k])}`)
          }
          expect(actual.sort()).toEqual(expected)

          for (let k = 0; k < n; k += 1) {
            const index = buffer[k]
            const row = rowOf(index)
            const col = colOf(index)
            const flips = doMove(pos, index, color)
            expect(flips).toBe(collectFlips(board, row, col, stone).length)
            undoMove(pos, index, color, flips)
            checked += 1
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('隣接石数は着手と取り消しで数え直しと一致する', () => {
    const pos = createFastPosition()
    const board = playout(7373, 26)
    loadBoard(pos, board)
    const buffer = new Int32Array(96)
    const n = generateMoves(pos, WHITE, buffer, 0)
    expect(n).toBeGreaterThan(0)

    const recount = (): number[] => {
      const list: number[] = []
      for (let row = 0; row < 10; row += 1) {
        for (let col = 0; col < 10; col += 1) {
          const index = cellIndex(row, col)
          let count = 0
          for (let d = 0; d < 8; d += 1) {
            const cell = pos.cells[index + DIRS[d]]
            if (cell === BLACK || cell === WHITE) count += 1
          }
          list.push(count)
        }
      }
      return list
    }

    const before = recount()
    expect(
      Array.from({ length: 100 }, (_, k) =>
        pos.adjacent[cellIndex(Math.floor(k / 10), k % 10)],
      ),
    ).toEqual(before)

    for (let k = 0; k < n; k += 1) {
      const flips = doMove(pos, buffer[k], WHITE)
      expect(
        Array.from({ length: 100 }, (_, i) =>
          pos.adjacent[cellIndex(Math.floor(i / 10), i % 10)],
        ),
      ).toEqual(recount())
      undoMove(pos, buffer[k], WHITE, flips)
    }
    expect(
      Array.from({ length: 100 }, (_, k) =>
        pos.adjacent[cellIndex(Math.floor(k / 10), k % 10)],
      ),
    ).toEqual(before)
  })

  it('着手と取り消しで盤面・石数・空きリストが元に戻る', () => {
    const pos = createFastPosition()
    const board = playout(4242, 30)
    loadBoard(pos, board)
    const before = Array.from(pos.cells)
    const beforeCounts = { black: pos.black, white: pos.white }
    const buffer = new Int32Array(96)
    const n = generateMoves(pos, BLACK, buffer, 0)

    for (let k = 0; k < n; k += 1) {
      const flips = doMove(pos, buffer[k], BLACK)
      undoMove(pos, buffer[k], BLACK, flips)
    }

    expect(Array.from(pos.cells)).toEqual(before)
    expect(pos.black).toBe(beforeCounts.black)
    expect(pos.white).toBe(beforeCounts.white)

    let empties = 0
    for (
      let i = pos.emptyNext[EMPTY_HEAD];
      i !== EMPTY_HEAD;
      i = pos.emptyNext[i]
    ) {
      empties += 1
    }
    expect(empties).toBe(pos.emptyCount)
  })
})

describe('戦略AI 確定石', () => {
  it('角から続く同色の辺の石だけを確定と数える', () => {
    const board = createEmptyBoard()
    board[0][0] = 'black'
    board[0][1] = 'black'
    board[0][2] = 'black'
    board[0][3] = 'white'
    const pos = createFastPosition()
    loadBoard(pos, board)
    const counts = countStable(pos)
    const flags = lastStableFlags()

    expect(counts.black).toBe(3)
    expect(counts.white).toBe(0)
    expect(flags[cellIndex(0, 0)]).toBe(1)
    expect(flags[cellIndex(0, 2)]).toBe(1)
    expect(flags[cellIndex(0, 3)]).toBe(0)
  })

  it('角が空いている辺の石は確定にしない', () => {
    const board = createEmptyBoard()
    for (let col = 1; col <= 8; col += 1) board[0][col] = 'black'
    const pos = createFastPosition()
    loadBoard(pos, board)
    expect(countStable(pos).black).toBe(0)
  })

  it('角に触れていない辺の石は、実際は返らなくても確定に数えない', () => {
    // . W B B B B B B W .
    // 内側 6 枚の黒は、両端の空きにどちらの色がいつ来ても二度と返らない。
    // つまりこれは取りこぼしだが、埋めてもアルファの手は 1 つも変わらず
    // 辺の走査だけ重くなったので、近似のままにしてある（docs/strategy-ai.md）
    const board = createEmptyBoard()
    board[0][1] = 'white'
    for (let col = 2; col <= 7; col += 1) board[0][col] = 'black'
    board[0][8] = 'white'
    const pos = createFastPosition()
    loadBoard(pos, board)

    expect(countStable(pos).black).toBe(0)
  })

  it('確定と数えた石は、そこからの合法手ひとつでは返らない', () => {
    const pos = createFastPosition()
    const buffer = new Int32Array(96)

    for (let seed = 1; seed <= 20; seed += 1) {
      for (const plies of [40, 60, 74, 82]) {
        const board = playout(seed * 313, plies)
        loadBoard(pos, board)
        countStable(pos)
        const stable = Array.from(lastStableFlags())

        for (const color of [BLACK, WHITE]) {
          const n = generateMoves(pos, color, buffer, 0)
          for (let k = 0; k < n; k += 1) {
            const index = buffer[k]
            const before = Array.from(pos.cells)
            const flips = doMove(pos, index, color)
            for (let cell = 0; cell < pos.cells.length; cell += 1) {
              if (stable[cell] !== 1) continue
              expect(pos.cells[cell]).toBe(before[cell])
            }
            undoMove(pos, index, color, flips)
          }
        }
      }
    }
  })
})

describe('戦略AI 評価', () => {
  it('確定石がないまま石が尽きかけた側を、石差以上に嫌う', () => {
    // 同じ形のまま白石だけを増やす。角から離れた塊なので確定石はなく、
    // 白 2 枚の側は一手で全滅しうる。石差の項（数十点）では説明できない差が要る
    const boardWithWhite = (count: number): Board => {
      const board = createEmptyBoard()
      for (let row = 2; row <= 7; row += 1) {
        for (let col = 2; col <= 7; col += 1) board[row][col] = 'black'
      }
      let left = count
      for (let row = 4; row <= 5 && left > 0; row += 1) {
        for (let col = 2; col <= 7 && left > 0; col += 1) {
          board[row][col] = 'white'
          left -= 1
        }
      }
      return board
    }

    const pos = createFastPosition()
    loadBoard(pos, boardWithWhite(2))
    expect(countStable(pos).white).toBe(0)
    const nearlyGone = evaluateLeaf(pos, WHITE, true)
    loadBoard(pos, boardWithWhite(12))
    const safe = evaluateLeaf(pos, WHITE, true)

    // 石差の項だけなら数十点差。全滅を嫌う項があれば桁が変わる
    expect(safe - nearlyGone).toBeGreaterThan(3_000)
  })

  it('全滅を嫌い始める境目は差し替えられる', () => {
    // 既定は 6 枚未満。速い相手にはこの境目が遅すぎて間に合わないと分かったので、
    // 境目そのものを測り直せるようにしてある（docs/strategy-ai.md「速い相手への弱点」）
    const board = createEmptyBoard()
    for (let row = 2; row <= 7; row += 1) {
      for (let col = 2; col <= 7; col += 1) board[row][col] = 'black'
    }
    for (let col = 2; col <= 9; col += 1) board[4][col] = 'white'
    const pos = createFastPosition()
    loadBoard(pos, board)
    expect(pos.white).toBe(8)
    expect(countStable(pos).white).toBe(0)

    // 8 枚は既定（6 枚未満）では危険にならない
    applyWeights(DEFAULT_WEIGHTS)
    const byDefault = evaluateLeaf(pos, WHITE, true)
    applyWeights(
      buildWeightTables({ ...DEFAULT_WEIGHT_SPEC, survivalFloor: 14 }),
    )
    const withHigherFloor = evaluateLeaf(pos, WHITE, true)
    applyWeights(DEFAULT_WEIGHTS)

    expect(byDefault - withHigherFloor).toBeGreaterThan(3_000)
  })

  it('相手の 1 手で全部返る形を、同じ石数でも別格に嫌う', () => {
    // 白 3 枚は同じ。違うのは「1 手で 3 枚とも返るか」だけ。
    // 石数を代理指標にした項（survival）ではこの 2 つを区別できない
    const blackBlock = (): Board => {
      const board = createEmptyBoard()
      for (let row = 2; row <= 7; row += 1) {
        for (let col = 2; col <= 7; col += 1) board[row][col] = 'black'
      }
      return board
    }
    // 白 3 枚が一列に並び、右端が黒・左隣が空き。黒がそこへ置けば 3 枚とも返る
    const wipeable = blackBlock()
    wipeable[4][2] = null
    wipeable[4][3] = 'white'
    wipeable[4][4] = 'white'
    wipeable[4][5] = 'white'
    // 白 3 枚がばらけていて、どの 1 手でも全部は返らない
    const scattered = blackBlock()
    scattered[3][3] = 'white'
    scattered[5][5] = 'white'
    scattered[6][3] = 'white'

    const withoutTerm = buildWeightTables({
      ...DEFAULT_WEIGHT_SPEC,
      wipeout: 0,
    })
    const scoreFor = (board: Board, tables: WeightTables): number => {
      const pos = createFastPosition()
      loadBoard(pos, board)
      expect(pos.white).toBe(3)
      expect(countStable(pos).white).toBe(0)
      applyWeights(tables)
      const score = evaluateLeaf(pos, WHITE, true)
      applyWeights(DEFAULT_WEIGHTS)
      return score
    }

    // 1 手で全部返る形は、この項があるぶんだけ大きく下がる
    const wipeableDrop =
      scoreFor(wipeable, withoutTerm) - scoreFor(wipeable, DEFAULT_WEIGHTS)
    expect(wipeableDrop).toBeGreaterThan(9_000)

    // ばらけている方は同じ石数でも下がらない
    const scatteredDrop =
      scoreFor(scattered, withoutTerm) - scoreFor(scattered, DEFAULT_WEIGHTS)
    expect(scatteredDrop).toBe(0)
  })

  it('返される最大枚数は、空きマスを全部試した答えと一致する', () => {
    // 本番は着手可能数・開放度と同じ 1 周で数えていて、数える色については
    // 「打てると分かった時点で打ち切る」をやめている。切り忘れると数が足りなくなる
    const bruteForce = (pos: ReturnType<typeof createFastPosition>): number => {
      const { cells, emptyNext } = pos
      let best = 0
      for (let i = emptyNext[EMPTY_HEAD]; i !== EMPTY_HEAD; i = emptyNext[i]) {
        let total = 0
        for (let d = 0; d < 8; d += 1) {
          const dir = DIRS[d]
          let j = i + dir
          let run = 0
          while (cells[j] === WHITE) {
            run += 1
            j += dir
          }
          if (run !== 0 && cells[j] === BLACK) total += run
        }
        if (total > best) best = total
      }
      return best
    }

    // 合法な進行だけだと白が数枚まで減る形がめったに出ないので、盤を直に作る。
    // 数えるのは盤の形だけを見る計算なので、並びが合法でなくても照合になる
    const rng = createRng(20260915)
    const pos = createFastPosition()
    let checked = 0
    const seenMargins = new Set<number>()
    for (let trial = 0; trial < 400; trial += 1) {
      const board = createEmptyBoard()
      const whites = rng.nextInt(1, 11)
      for (let row = 0; row < 10; row += 1) {
        for (let col = 0; col < 10; col += 1) {
          board[row][col] = rng.nextInt(0, 3) === 0 ? null : 'black'
        }
      }
      for (let k = 0; k < whites; k += 1) {
        board[rng.nextInt(0, 10)][rng.nextInt(0, 10)] = 'white'
      }
      loadBoard(pos, board)
      if (pos.white === 0) continue
      checked += 1
      const flips = scanLeaf(pos).maxWhiteFlips
      expect(flips).toBe(bruteForce(pos))
      seenMargins.add(Math.min(Math.max(pos.white - flips, 0), 3))
    }

    expect(checked).toBeGreaterThan(300)
    // 「どれも危険でないので 0 枚で一致」では照合にならない。全滅する形も出す
    expect([...seenMargins].sort()).toEqual([0, 1, 2, 3])
  })

  it('相手が 2 手続けて打てば全部返る形を、1 手では返らなくても嫌う', () => {
    // 白 4 枚。黒の 1 手ではどれも全部は返らないが、
    // (4,2) → (4,6) と 2 手続ければ 4 枚とも返る
    const board = createEmptyBoard()
    for (let row = 2; row <= 7; row += 1) {
      for (let col = 2; col <= 7; col += 1) board[row][col] = 'black'
    }
    board[4][2] = null
    board[4][3] = 'white'
    board[4][4] = 'white'
    board[4][5] = 'white'
    board[4][6] = null
    board[5][5] = 'white'

    const pos = createFastPosition()
    loadBoard(pos, board)
    expect(pos.white).toBe(4)
    expect(countStable(pos).white).toBe(0)
    // 1 手では全部返らない＝1 手先だけ見る項では区別できない
    expect(scanLeaf(pos).maxWhiteFlips).toBeLessThan(pos.white)

    const scoreWith = (tables: WeightTables): number => {
      applyWeights(tables)
      const score = evaluateLeaf(pos, WHITE, true)
      applyWeights(DEFAULT_WEIGHTS)
      return score
    }
    const without = buildWeightTables({
      ...DEFAULT_WEIGHT_SPEC,
      wipeout2: 0,
    })

    expect(scoreWith(without) - scoreWith(DEFAULT_WEIGHTS)).toBeGreaterThan(
      5_000,
    )

    // 盤は読みの途中で置いて戻すので、評価しても元のままであること
    const before = Array.from(pos.cells)
    scoreWith(DEFAULT_WEIGHTS)
    expect(Array.from(pos.cells)).toEqual(before)
    expect(pos.white).toBe(4)
  })

  it('石が多い側は数えない（葉を重くしないため）', () => {
    // 数えると scanLeaf が打ち切れなくなるので、減っている側だけに限っている
    const board = createInitialBoard()
    const pos = createFastPosition()
    loadBoard(pos, board)
    expect(pos.black).toBe(8)
    expect(scanLeaf(pos).maxBlackFlips).toBeGreaterThan(0)

    const crowded = playout(4242, 40)
    loadBoard(pos, crowded)
    expect(pos.black).toBeGreaterThan(10)
    expect(pos.white).toBeGreaterThan(10)
    const leaf = scanLeaf(pos)
    expect(leaf.maxBlackFlips).toBe(0)
    expect(leaf.maxWhiteFlips).toBe(0)
  })

  it('確定石があるなら石が少なくても全滅としては嫌わない', () => {
    // 白 2 枚はどちらも同じ。片方は角にあり、その石は二度と返らない＝全滅しない
    const base = (): Board => {
      const board = createEmptyBoard()
      for (let row = 2; row <= 7; row += 1) {
        for (let col = 2; col <= 7; col += 1) board[row][col] = 'black'
      }
      board[4][4] = 'white'
      return board
    }
    const anchoredBoard = base()
    anchoredBoard[0][0] = 'white'
    const adriftBoard = base()
    adriftBoard[5][5] = 'white'

    const pos = createFastPosition()
    loadBoard(pos, anchoredBoard)
    expect(countStable(pos).white).toBe(1)
    const anchored = evaluateLeaf(pos, WHITE, true)
    loadBoard(pos, adriftBoard)
    expect(countStable(pos).white).toBe(0)
    const adrift = evaluateLeaf(pos, WHITE, true)

    // 角そのものの評価（角 230・確定石ぶん）だけでは数百点。全滅の危険が消えた差が要る
    expect(anchored - adrift).toBeGreaterThan(2_000)
  })
})

describe('戦略AI 探索', () => {
  it(
    '枝刈りありの評価値が素の最小最大と一致する',
    () => {
      const pos = createFastPosition()
      let compared = 0
      for (const seed of [11, 57, 233]) {
        for (const plies of [18, 44, 70]) {
          const board = playout(seed, plies)
          loadBoard(pos, board)
          if (generateMoves(pos, WHITE, new Int32Array(96), 0) < 2) continue

          for (const depth of [1, 2, 3]) {
            loadBoard(pos, board)
            const expected = referenceMinimax(
              pos,
              WHITE,
              SYMMETRIC_SCHEDULE.selfNextMs,
              SYMMETRIC_SCHEDULE.oppNextMs,
              depth,
            )
            loadBoard(pos, board)
            const actual = searchBestMove(pos, WHITE, SYMMETRIC_SCHEDULE, {
              maxDepth: depth,
              nodeBudget: 50_000_000,
            })
            expect(actual.aborted).toBe(false)
            expect(actual.score).toBe(expected)
            compared += 1
          }
        }
      }
      expect(compared).toBeGreaterThanOrEqual(15)
    },
    60_000,
  )

  it(
    '終盤の深い読みでも素の最小最大と一致する',
    () => {
      const pos = createFastPosition()
      const board = playout(8125, 76)
      loadBoard(pos, board)
      const expected = referenceMinimax(
        pos,
        WHITE,
        SYMMETRIC_SCHEDULE.selfNextMs,
        SYMMETRIC_SCHEDULE.oppNextMs,
        5,
      )
      loadBoard(pos, board)
      const actual = searchBestMove(pos, WHITE, SYMMETRIC_SCHEDULE, {
        maxDepth: 5,
        nodeBudget: 50_000_000,
      })
      expect(actual.aborted).toBe(false)
      expect(actual.score).toBe(expected)
    },
    60_000,
  )

  it('探索してもルール層の盤面を書き換えない', () => {
    const board = playout(909, 36)
    const snapshot = JSON.stringify(board)
    const publicState = publicStateFor(board)
    decideStrategyMove(publicState, createRng(5), 'white', MASTER_LEVEL)
    expect(JSON.stringify(board)).toBe(snapshot)
    expect(JSON.stringify(publicState.board)).toBe(snapshot)
  })

  it('ノード上限は空きマス数だけで決まる', () => {
    expect(nodeBudgetFor(10_000, 60)).toBe(7_000)
    expect(nodeBudgetFor(10_000, 50)).toBe(10_000)
    expect(nodeBudgetFor(10_000, 30)).toBe(13_000)
    expect(nodeBudgetFor(10_000, 10)).toBe(50_000)
  })

  it('残り数手の局面は最後まで読み切って勝ちを確定させる', () => {
    // 空きは (0,0) (0,9) (5,5) の 3 つ。白は角を 2 つ取れる
    const board = createEmptyBoard()
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 10; col += 1) board[row][col] = 'white'
    }
    for (let col = 1; col <= 8; col += 1) board[0][col] = 'black'
    board[1][1] = 'black'
    board[1][8] = 'black'
    board[0][0] = null
    board[0][9] = null
    board[5][5] = null

    expect(listLegalMoves(board, 'white')).toHaveLength(2)

    const pos = createFastPosition()
    loadBoard(pos, board)
    const result = searchBestMove(pos, WHITE, SYMMETRIC_SCHEDULE, {
      maxDepth: 20,
      nodeBudget: 5_000_000,
    })
    expect(result.aborted).toBe(false)
    expect(result.depth).toBeGreaterThanOrEqual(3)
    expect(result.score).toBeGreaterThanOrEqual(WIN_SCORE)
    for (const move of result.bestMoves) {
      expect(['0,0', '0,9']).toContain(`${rowOf(move)},${colOf(move)}`)
    }
  })
})

describe('戦略AI 手番前の下読み', () => {
  const level = { ...MASTER_LEVEL, adaptPace: false }

  /** 判断待ち 500ms ぶん、着手を求められるまで読み進める */
  function ponderUntilDecision(
    publicState: ReturnType<typeof publicStateFor>,
    session: ReturnType<typeof createPonderSession>,
    steps = 10,
  ): void {
    for (let left = steps; left >= 1; left -= 1) {
      ponderStrategyMove(
        publicState,
        'white',
        level,
        left * GAME_CONFIG.stepMs,
        session,
      )
    }
  }

  it(
    '下読みした分だけ深く読めている',
    () => {
      // 1 局面だと同じ深さで止まることもあるので、まとめて比べる
      let plainTotal = 0
      let ponderedTotal = 0
      let ponderedNodes = 0

      for (const plies of [12, 24, 30, 36, 48, 60, 66, 72]) {
        const publicState = publicStateFor(playout(4242, plies))
        if (listLegalMoves(publicState.board, 'white').length < 2) continue

        plainTotal += decideStrategyMove(
          publicState,
          createRng(1),
          'white',
          level,
        ).depth

        const session = createPonderSession()
        ponderUntilDecision(publicState, session)
        const pondered = decideStrategyMove(
          publicState,
          createRng(1),
          'white',
          level,
          session,
        )
        ponderedTotal += pondered.depth
        ponderedNodes += session.nodes
        expect(pondered.decision.type).toBe('move')
      }

      expect(ponderedNodes).toBeGreaterThan(0)
      expect(ponderedTotal).toBeGreaterThan(plainTotal)
    },
    60_000,
  )

  it('下読みを重ねるほど読んだ深さが伸びる', () => {
    const board = playout(4242, 30)
    const publicState = publicStateFor(board)
    const session = createPonderSession()

    ponderStrategyMove(publicState, 'white', level, 500, session)
    const first = session.root?.depth ?? 0
    ponderUntilDecision(publicState, session, 9)
    const later = session.root?.depth ?? 0

    expect(first).toBeGreaterThan(0)
    expect(later).toBeGreaterThan(first)
  })

  it('盤面が変わったら読んだ分を捨てる', () => {
    const board = playout(4242, 30)
    const session = createPonderSession()
    ponderUntilDecision(publicStateFor(board), session)
    const deep = session.root?.depth ?? 0
    expect(deep).toBeGreaterThan(1)

    const moved = listLegalMoves(board, 'black')[0]
    const placed = placeStone(board, moved.row, moved.col, 'black')
    if (!placed.ok) throw new Error('illegal move')

    ponderStrategyMove(publicStateFor(placed.board), 'white', level, 500, session)
    expect(session.root?.depth ?? 0).toBeLessThan(deep)
  })

  it('下読みしてもルール層の盤面を書き換えない', () => {
    const board = playout(909, 36)
    const snapshot = JSON.stringify(board)
    const publicState = publicStateFor(board)
    ponderUntilDecision(publicState, createPonderSession())
    expect(JSON.stringify(board)).toBe(snapshot)
    expect(JSON.stringify(publicState.board)).toBe(snapshot)
  })

  it('下読みを切れば持ち越しは作られない', () => {
    const publicState = publicStateFor(playout(4242, 30))
    const session = createPonderSession()
    ponderStrategyMove(
      publicState,
      'white',
      { ...level, ponderStepNodes: 0 },
      500,
      session,
    )
    expect(session.active).toBe(false)
    expect(session.nodes).toBe(0)
  })

  it('下読みの 1 ステップは着手時より軽い', () => {
    expect(ponderBudgetFor(3_000, 60)).toBe(2_100)
    expect(ponderBudgetFor(3_000, 30)).toBe(3_000)
    // 着手時と違って、終盤でも 1 ステップを重くしない
    expect(ponderBudgetFor(3_000, 10)).toBe(3_000)
    expect(nodeBudgetFor(3_000, 10)).toBe(15_000)
  })
})

/**
 * 相手が oppIntervalMs ごとに、自分が selfIntervalMs ごとに打つ試合を作り、
 * 自分の着手のたびに観測させる（実際のエージェントと同じ呼ばれ方）。
 */
function trackPace(options: {
  oppIntervalMs: number
  selfIntervalMs: number
  observations: number
}) {
  const tracker = createPaceTracker()
  const board = createEmptyBoard()
  const free: Array<{ row: number; col: number }> = []
  for (let row = 0; row < GAME_CONFIG.boardSize; row += 1) {
    for (let col = 0; col < GAME_CONFIG.boardSize; col += 1) {
      free.push({ row, col })
    }
  }
  let taken = 0
  let elapsedMs = 0
  let nextOppMs = options.oppIntervalMs

  let estimate = observePace(tracker, board, elapsedMs, 1200, 500)
  for (let k = 0; k < options.observations; k += 1) {
    elapsedMs += options.selfIntervalMs
    while (nextOppMs <= elapsedMs) {
      const cell = free[taken]
      taken += 1
      board[cell.row][cell.col] = 'black'
      nextOppMs += options.oppIntervalMs
    }
    estimate = observePace(tracker, board, elapsedMs, 1200, 500)

    const own = free[taken]
    taken += 1
    board[own.row][own.col] = 'white'
    notePlayedMove(tracker, own.row, own.col)
  }
  return { tracker, estimate }
}

describe('戦略AI 相手ペースの観測', () => {
  it('観測前は既定の想定を返す', () => {
    const tracker = createPaceTracker()
    const first = observePace(tracker, createInitialBoard(), 0, 1200, 500)
    expect(first).toEqual({ intervalMs: 1200, reactionMs: 500, measured: false })
  })

  it('最速で打つ相手は待ち時間そのものの間隔として測れる', () => {
    const { estimate } = trackPace({
      oppIntervalMs: GAME_CONFIG.cooldownMs,
      selfIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
      observations: 12,
    })
    expect(estimate.measured).toBe(true)
    expect(estimate.intervalMs).toBeLessThanOrEqual(800)
    expect(estimate.reactionMs).toBeLessThanOrEqual(100)
  })

  it('自分と同じ速さの相手は同じ間隔として測れる', () => {
    const paired = GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs
    const { estimate } = trackPace({
      oppIntervalMs: paired,
      selfIntervalMs: paired,
      observations: 12,
    })
    expect(estimate.measured).toBe(true)
    expect(Math.abs(estimate.intervalMs - paired)).toBeLessThanOrEqual(150)
  })

  it('自分の着手を相手の着手として数えない', () => {
    // 相手が一度も打たなければ、何回観測しても推定は出ない
    const { estimate } = trackPace({
      oppIntervalMs: Number.POSITIVE_INFINITY,
      selfIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
      observations: 12,
    })
    expect(estimate.measured).toBe(false)
  })

  it('測ったペースに応じて評価の重みを選べる', () => {
    // 速い相手には別の評価を使いたくなったとき用の窓口。既定では使っていない
    const seen: Array<{ intervalMs: number; measured: boolean }> = []
    const agent = createStrategyCpu({
      id: 'strategy',
      label: 'pace-weights',
      level: {
        ...ALPHA_LEVEL,
        nodeBudget: 600,
        weightsForPace: (pace) => {
          seen.push({ intervalMs: pace.intervalMs, measured: pace.measured })
          return ALPHA_LEVEL.weights
        },
      },
    })
    agent.decide(publicStateFor(createInitialBoard()), createRng(5), 'white')
    // 観測前は初期想定のまま。measured で試合の切れ目が分かる
    expect(seen).toEqual([
      { intervalMs: ALPHA_LEVEL.opponentIntervalMs, measured: false },
    ])
  })

  it('試合が変わったら測り直す', () => {
    const { tracker } = trackPace({
      oppIntervalMs: GAME_CONFIG.cooldownMs,
      selfIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
      observations: 12,
    })
    const restarted = observePace(tracker, createInitialBoard(), 0, 1200, 500)
    expect(restarted).toEqual({
      intervalMs: 1200,
      reactionMs: 500,
      measured: false,
    })
  })
})

describe('戦略AI の指し手', () => {
  it('相手も取れる角は、その場で取る', () => {
    // 双方がその角に打てる局面。取り合いになる角は先に取るのが定石
    const contested: Array<[number, number, number, number]> = [
      [85, 50, 0, 0],
      [153, 50, 0, 0],
      [204, 60, 0, 9],
      [289, 40, 0, 9],
      [476, 60, 9, 0],
    ]

    for (const [seed, plies, row, col] of contested) {
      const board = playout(seed, plies)
      expect(
        listLegalMoves(board, 'white').some(
          (m) => m.row === row && m.col === col,
        ),
      ).toBe(true)
      expect(
        listLegalMoves(board, 'black').some(
          (m) => m.row === row && m.col === col,
        ),
      ).toBe(true)

      const decision = strategyCpu.decide(
        publicStateFor(board),
        createRng(1),
        'white',
      )
      expect(decision).toEqual({ type: 'move', row, col })
    }
  })

  it('角が空いているときに X 打ちを選ばない', () => {
    const board = createInitialBoard()
    const publicState = publicStateFor(board, 77)
    const decision = strategyCpu.decide(publicState, createRng(9), 'white')
    expect(decision.type).toBe('move')
    if (decision.type !== 'move') return
    const xSquares = [
      [1, 1],
      [1, 8],
      [8, 1],
      [8, 8],
    ]
    expect(
      xSquares.some(([r, c]) => r === decision.row && c === decision.col),
    ).toBe(false)
  })

  it(
    '同じ試合の進行と乱数からは必ず同じ手を返す',
    () => {
      // 相手ペースを観測して読み方を変えるので、1 手だけでなく進行ごと繰り返す
      const states = [12, 20, 28, 36, 44]
        .map((plies) =>
          toPublicMatchState({
            ...createMatch({ seed: 2024 }),
            board: playout(2024, plies),
            elapsedMs: plies * 600,
          }),
        )
        .filter((state) => listLegalMoves(state.board, 'white').length > 0)
      expect(states.length).toBeGreaterThan(2)

      const replay = () => {
        const agent = createStrategyCpu({ id: 'strategy', label: '再現確認' })
        return states.map((state) => agent.decide(state, createRng(4), 'white'))
      }
      expect(replay()).toEqual(replay())

      const single = publicStateFor(playout(2024, 44))
      expect(strategyCpu.decide(single, createRng(4), 'white')).toEqual(
        strategyCpu.decide(single, createRng(4), 'white'),
      )
    },
    // 12 回読み直すので、他のテストと同時に走ると既定の 5 秒では足りない
    60_000,
  )

  it('打てるときは必ず合法手を返し、待機しない', () => {
    for (const plies of [0, 15, 33, 58, 80]) {
      const board = playout(5150 + plies, plies)
      const legal = listLegalMoves(board, 'white')
      if (legal.length === 0) continue
      const decision = strategyCpu.decide(
        publicStateFor(board),
        createRng(plies),
        'white',
      )
      expect(decision.type).toBe('move')
      if (decision.type !== 'move') continue
      expect(
        legal.some((m) => m.row === decision.row && m.col === decision.col),
      ).toBe(true)
    }
  })

  it('開始画面に並ぶ', () => {
    expect(CPU_OPTIONS.map((o) => o.id)).toContain('strategy')
    expect(getCpuAgent('strategy')).toBe(strategyCpu)
  })
})

describe('相手の速さを変えた対戦', () => {
  it('打たない相手は無操作 3 秒でランダムに打たされる', () => {
    // 遅い相手を測るときにこれが抜けていると、相手が永久に待てることになって
    // 実際の画面と違う結果が出る（仕様 2.3.2）
    const result = runPacedMatch({
      seed: 7,
      decisionSeed: 77,
      black: getCpuAgent('wait'),
      white: getCpuAgent('max_flip'),
      blackThinkDelayMs: 0,
    })
    expect(result.abnormal).toBe(false)
    expect(result.moves.black).toBe(0)
    expect(result.idleMoves.black).toBeGreaterThan(0)
  })

  it(
    '最速で打つランダム相手には勝つ',
    () => {
      // 相手の着手間隔 700ms に対しアルファは 1200ms。相手の方が 1.7 倍多く打てる。
      // それでも勝てることで、速さそのものへの対応は効いていると言える。
      // 速い「即時反転数優先型」には勝ち切れていない。docs/strategy-ai.md を参照
      let wins = 0
      for (let g = 0; g < 4; g += 1) {
        const result = runPacedMatch({
          seed: 4100 + g,
          decisionSeed: 8200 + g,
          black: getCpuAgent('random'),
          white: getCpuAgent('alpha'),
          blackThinkDelayMs: 0,
        })
        expect(result.abnormal).toBe(false)
        if (result.diffForWhite > 0) wins += 1
      }
      expect(wins).toBe(4)
    },
    120_000,
  )
})

describe('アルファ', () => {
  it('開始画面に残り、23時の設定で固定する', () => {
    expect(CPU_OPTIONS.map((o) => o.id)).toContain('alpha')
    expect(getCpuAgent('alpha')).toBe(alphaCpu)
    expect(createTitleSession().settings.cpuType).not.toBe('alpha')
  })

  it('強さを裏取りできている設定で固定する', () => {
    // 変えるときは実測を docs/strategy-ai.md に残してから、新しい名前で載せる
    expect(ALPHA_LEVEL.nodeBudget).toBe(14_000)
    expect(ALPHA_LEVEL.adaptPace).toBe(true)
    // 手番前の下読みは対戦で負け越したので入れない
    expect(ALPHA_LEVEL.ponderStepNodes).toBe(0)
    // 着手可能数の重みは既定の 1.5 倍（同じ探索量で 49勝11敗）
    for (const phase of ['opening', 'midgame', 'endgame'] as const) {
      expect(ALPHA_WEIGHT_SPEC[phase].mobility).toBeCloseTo(
        DEFAULT_WEIGHT_SPEC[phase].mobility * 1.5,
      )
    }
    // 23時時点では全滅の余裕を見ていない
    expect(ALPHA_WEIGHT_SPEC.wipeout).toBe(0)
    expect(ALPHA_LEVEL.weights.wipeout).toBe(0)
  })

  it('相手の速さで評価を変えない', () => {
    // 相手が速いほど全滅回避の境目を上げる案を試した。最速の max_flip には
    // 56.7%→85.0% と効くが、同じ速さの GA 第100世代に 100%→18.3% と崩れる。
    // 石を減らして相手を手詰まりにする指し方は、相手が強いほど効くため。
    // 差し替えの窓口（weightsForPace）は残してあるが、アルファでは使わない
    expect(ALPHA_LEVEL.weightsForPace).toBeUndefined()
    expect(ALPHA_LEVEL.weights.survivalFloor).toBe(DEFAULT_WEIGHTS.survivalFloor)
  })

  it('打てるときは必ず合法手を返し、待機しない', () => {
    for (const plies of [0, 15, 33, 58, 80]) {
      const board = playout(6100 + plies, plies)
      const legal = listLegalMoves(board, 'white')
      if (legal.length === 0) continue
      const decision = alphaCpu.decide(
        publicStateFor(board),
        createRng(plies),
        'white',
      )
      expect(decision.type).toBe('move')
      if (decision.type !== 'move') continue
      expect(
        legal.some((m) => m.row === decision.row && m.col === decision.col),
      ).toBe(true)
    }
  })

  it(
    '実際の対戦ループで、最速で打つ相手に自力で打ち勝つ',
    () => {
      let session = startCountdown({
        seed: 31,
        cooldownMs: GAME_CONFIG.cooldownMs,
        cpuType: 'strategy',
      })
      const rng = createRng(31)
      const playerRng = createRng(931)
      // プレイヤー役は GA の最強個体。待ち時間が明けた瞬間に打つ（判断待ちなし）ので、
      // 判断待ち 500ms を守る CPU より 1.7 倍多く着手できる
      const player = getCpuAgent('ga_best')
      session = advanceSession(session, rng, GAME_CONFIG.countdownMs)

      let minCpuIdle: number = GAME_CONFIG.idleAutoMoveMs
      let steps = 0
      while (session.screen !== 'result' && steps < 5000) {
        if (session.match!.phase === 'playing') {
          const decision = player.decide(
            toPublicMatchState(session.match!),
            playerRng,
            'black',
          )
          if (decision.type === 'move') {
            session = queuePlayerMove(session, {
              row: decision.row,
              col: decision.col,
            })
          }
        }
        session = stepSession(session, rng).session
        if (session.cpuIdleRemainingMs !== null) {
          minCpuIdle = Math.min(minCpuIdle, session.cpuIdleRemainingMs)
        }
        steps += 1
      }

      expect(session.screen).toBe('result')
      // 無操作 3 秒のランダム着手に回されず、毎回自分で選んだ手を置いている。
      // 判断待ち 500ms のあと、盤面が変わって待ち直した分だけ余裕が減る
      expect(minCpuIdle).toBeGreaterThan(GAME_CONFIG.idleAutoMoveMs / 2)
      const counts = countStones(session.match!.board)
      expect(counts.white).toBeGreaterThan(counts.black)
    },
    120_000,
  )

  it('待ち時間中と合法手なしでは待機する', () => {
    const board = createInitialBoard()
    const cooling = {
      ...publicStateFor(board),
      cooldowns: { black: 0, white: 350 },
    }
    expect(strategyCpu.decide(cooling, createRng(1), 'white')).toEqual({
      type: 'wait',
    })

    const blocked = createEmptyBoard()
    blocked[0][0] = 'black'
    expect(
      strategyCpu.decide(publicStateFor(blocked), createRng(1), 'white'),
    ).toEqual({ type: 'wait' })
  })
})

describe('名前付き個体', () => {
  it('新しい順に並び、先頭が既定の対戦相手になる', () => {
    // 過去の個体は消さず、新しいものから並べる（仕様 2.9）
    const named = ['epsilon', 'delta', 'gamma', 'beta', 'alpha']
    expect(CPU_OPTIONS.slice(0, named.length).map((o) => o.id)).toEqual(named)
    expect(createTitleSession().settings.cpuType).toBe(named[0])
    for (const id of named) {
      expect(getCpuAgent(id as 'epsilon').id).toBe(id)
    }
  })

  it('過去の個体の設定を後から足した項で動かさない', () => {
    // 省略すると開発版の既定が乗るので、名前付き個体は 0 を明示している
    expect(ALPHA_WEIGHT_SPEC.wipeout).toBe(0)
    expect(ALPHA_WEIGHT_SPEC.wipeout2).toBe(0)
    expect(ALPHA_LEVEL.weights.wipeout).toBe(0)
    expect(ALPHA_LEVEL.weights.wipeout2).toBe(0)
    expect(BETA_WEIGHT_SPEC.wipeout2).toBe(0)
    expect(BETA_LEVEL.weights.wipeout2).toBe(0)
    expect(GAMMA_LEVEL.weights.wipeout2).toBe(0)
  })

  it('イプシロンは C 打ちと石数だけがデルタと違う', () => {
    expect(EPSILON_LEVEL.nodeBudget).toBe(DELTA_LEVEL.nodeBudget)
    expect(EPSILON_LEVEL.adaptPace).toBe(DELTA_LEVEL.adaptPace)
    for (const phase of ['opening', 'midgame', 'endgame'] as const) {
      const from = DELTA_WEIGHT_SPEC[phase]
      const to = EPSILON_WEIGHT_SPEC[phase]
      expect(to.cSquare).toBeCloseTo(from.cSquare * 2)
      expect(to.disc).toBeCloseTo(from.disc * 0.5)
      for (const term of [
        'corner',
        'stable',
        'mobility',
        'potential',
        'xSquare',
        'edge',
        'parity',
      ] as const) {
        expect(to[term]).toBeCloseTo(from[term])
      }
    }
  })
})

describe('ベータ', () => {

  it('アルファに足した全滅の余裕を固定する', () => {
    expect(BETA_LEVEL.nodeBudget).toBe(ALPHA_LEVEL.nodeBudget)
    expect(BETA_LEVEL.ponderStepNodes).toBe(0)
    expect(BETA_LEVEL.adaptPace).toBe(true)
    expect(BETA_LEVEL.weightsForPace).toBeUndefined()
    for (const phase of ['opening', 'midgame', 'endgame'] as const) {
      expect(BETA_WEIGHT_SPEC[phase].mobility).toBeCloseTo(
        ALPHA_WEIGHT_SPEC[phase].mobility,
      )
    }
    expect(BETA_WEIGHT_SPEC.wipeout).toBe(1_200)
    expect(BETA_LEVEL.weights.wipeout).toBe(1_200)
  })

  it('アルファより、1手で全滅する形を嫌う', () => {
    // 白 3 枚が一列。黒が左隣へ置けば 3 枚とも返る
    const board = createEmptyBoard()
    for (let row = 2; row <= 7; row += 1) {
      for (let col = 2; col <= 7; col += 1) board[row][col] = 'black'
    }
    board[4][2] = null
    board[4][3] = 'white'
    board[4][4] = 'white'
    board[4][5] = 'white'

    const pos = createFastPosition()
    loadBoard(pos, board)
    expect(pos.white).toBe(3)
    expect(countStable(pos).white).toBe(0)

    applyWeights(ALPHA_LEVEL.weights)
    const alphaScore = evaluateLeaf(pos, WHITE, true)
    applyWeights(BETA_LEVEL.weights)
    const betaScore = evaluateLeaf(pos, WHITE, true)
    applyWeights(DEFAULT_WEIGHTS)

    expect(alphaScore - betaScore).toBeGreaterThan(9_000)
  })

  it('打てるときは必ず合法手を返し、待機しない', () => {
    for (const plies of [0, 15, 33, 58, 80]) {
      const board = playout(6100 + plies, plies)
      const legal = listLegalMoves(board, 'white')
      if (legal.length === 0) continue
      const decision = betaCpu.decide(
        publicStateFor(board),
        createRng(plies),
        'white',
      )
      expect(decision.type).toBe('move')
      if (decision.type !== 'move') continue
      expect(
        legal.some((m) => m.row === decision.row && m.col === decision.col),
      ).toBe(true)
    }
  })
})
