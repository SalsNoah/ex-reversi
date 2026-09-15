/**
 * 確定石（二度と返らない石）の判定。オセロ戦略の中心概念。
 *
 * 判定は「安全側」に寄せた十分条件を使う。ここで確定と判定した石は
 * 本当に返らないが、実際には確定でも判定漏れする石はありうる。
 * 評価値がぶれないよう、過大評価だけを避ける。
 *
 * 葉ごとに呼ぶ関数なので、確保・関数呼び出し・走査量を抑えている。
 */
import {
  BLACK,
  EMPTY,
  EMPTY_HEAD,
  N,
  W,
  cellIndex,
  type FastPosition,
} from './fastBoard.ts'

/** 上下左右 4 辺（それぞれ角から角までの 10 マス） */
const EDGE_LINES = buildEdgeLines()

function buildEdgeLines(): Int32Array[] {
  const top = new Int32Array(N)
  const bottom = new Int32Array(N)
  const left = new Int32Array(N)
  const right = new Int32Array(N)
  for (let k = 0; k < N; k += 1) {
    top[k] = cellIndex(0, k)
    bottom[k] = cellIndex(N - 1, k)
    left[k] = cellIndex(k, 0)
    right[k] = cellIndex(k, N - 1)
  }
  return [top, bottom, left, right]
}

const interior = buildInterior()
const INTERIOR = interior.index
const INTERIOR_ROW = interior.row
const INTERIOR_COL = interior.col

function buildInterior(): {
  index: Int32Array
  row: Int32Array
  col: Int32Array
} {
  const size = (N - 2) * (N - 2)
  const index = new Int32Array(size)
  const row = new Int32Array(size)
  const col = new Int32Array(size)
  let k = 0
  for (let r = 1; r < N - 1; r += 1) {
    for (let c = 1; c < N - 1; c += 1) {
      index[k] = cellIndex(r, c)
      row[k] = r
      col[k] = c
      k += 1
    }
  }
  return { index, row, col }
}

const stableFlags = new Uint8Array(W * W)
const rowEmpty = new Int32Array(N)
const colEmpty = new Int32Array(N)
const diagDownEmpty = new Int32Array(2 * N - 1)
const diagUpEmpty = new Int32Array(2 * N - 1)

/** 内部確定石まで数える上限。序盤は辺だけで十分なので探索を軽くする */
export const INTERIOR_STABILITY_EMPTY_LIMIT = 44
const MAX_INTERIOR_PASSES = 4
/** 辺に確定石が 1 つもなくても、ここまで詰まっていれば線が埋まって確定しうる */
const FULL_LINE_EMPTY_LIMIT = 14

export type StableCounts = {
  black: number
  white: number
}

const counts: StableCounts = { black: 0, white: 0 }
let stableBlack = 0
let stableWhite = 0

/**
 * 確定石を数える。戻り値は呼び出しごとに使い回す共有オブジェクト。
 * 返り値を保持せず、その場で読み取ること。
 */
export function countStable(pos: FastPosition): StableCounts {
  const cells = pos.cells
  stableFlags.fill(0)
  stableBlack = 0
  stableWhite = 0

  for (let e = 0; e < 4; e += 1) markEdgeLine(cells, EDGE_LINES[e])

  const anchored = stableBlack + stableWhite > 0
  if (
    pos.emptyCount <= INTERIOR_STABILITY_EMPTY_LIMIT &&
    (anchored || pos.emptyCount <= FULL_LINE_EMPTY_LIMIT)
  ) {
    markInterior(pos)
  }

  counts.black = stableBlack
  counts.white = stableWhite
  return counts
}

function mark(cells: Uint8Array, index: number): void {
  if (stableFlags[index] === 1) return
  stableFlags[index] = 1
  if (cells[index] === BLACK) stableBlack += 1
  else stableWhite += 1
}

/**
 * 辺のマスは縦・斜めが必ず盤外で閉じるので、辺方向だけ見れば確定かが決まる。
 * 「辺が全部埋まっている」か「占有された角から同色が続いている」なら確定。
 */
function markEdgeLine(cells: Uint8Array, line: Int32Array): void {
  let full = true
  for (let k = 0; k < N; k += 1) {
    if (cells[line[k]] === EMPTY) {
      full = false
      break
    }
  }

  if (full) {
    for (let k = 0; k < N; k += 1) mark(cells, line[k])
    return
  }

  const head = cells[line[0]]
  if (head !== EMPTY) {
    for (let k = 0; k < N && cells[line[k]] === head; k += 1) {
      mark(cells, line[k])
    }
  }

  const tail = cells[line[N - 1]]
  if (tail !== EMPTY) {
    for (let k = N - 1; k >= 0 && cells[line[k]] === tail; k -= 1) {
      mark(cells, line[k])
    }
  }
}

/**
 * 内部の石は 4 軸すべてで安全なら確定。
 * 各軸は「その線に空きがない」か「同色の確定石が隣にある」で安全と見なす。
 */
function markInterior(pos: FastPosition): void {
  const cells = pos.cells
  rowEmpty.fill(0)
  colEmpty.fill(0)
  diagDownEmpty.fill(0)
  diagUpEmpty.fill(0)

  const next = pos.emptyNext
  for (let i = next[EMPTY_HEAD]; i !== EMPTY_HEAD; i = next[i]) {
    const row = ((i / W) | 0) - 1
    const col = (i % W) - 1
    rowEmpty[row] += 1
    colEmpty[col] += 1
    diagDownEmpty[row - col + N - 1] += 1
    diagUpEmpty[row + col] += 1
  }

  const size = INTERIOR.length
  for (let pass = 0; pass < MAX_INTERIOR_PASSES; pass += 1) {
    let changed = false
    for (let k = 0; k < size; k += 1) {
      const index = INTERIOR[k]
      if (stableFlags[index] === 1) continue
      const color = cells[index]
      if (color === EMPTY) continue
      const row = INTERIOR_ROW[k]
      const col = INTERIOR_COL[k]

      if (rowEmpty[row] !== 0) {
        const f = index + 1
        const b = index - 1
        if (
          !(cells[f] === color && stableFlags[f] === 1) &&
          !(cells[b] === color && stableFlags[b] === 1)
        ) {
          continue
        }
      }
      if (colEmpty[col] !== 0) {
        const f = index + W
        const b = index - W
        if (
          !(cells[f] === color && stableFlags[f] === 1) &&
          !(cells[b] === color && stableFlags[b] === 1)
        ) {
          continue
        }
      }
      if (diagDownEmpty[row - col + N - 1] !== 0) {
        const f = index + W + 1
        const b = index - W - 1
        if (
          !(cells[f] === color && stableFlags[f] === 1) &&
          !(cells[b] === color && stableFlags[b] === 1)
        ) {
          continue
        }
      }
      if (diagUpEmpty[row + col] !== 0) {
        const f = index + W - 1
        const b = index - W + 1
        if (
          !(cells[f] === color && stableFlags[f] === 1) &&
          !(cells[b] === color && stableFlags[b] === 1)
        ) {
          continue
        }
      }

      stableFlags[index] = 1
      if (color === BLACK) stableBlack += 1
      else stableWhite += 1
      changed = true
    }
    if (!changed) return
  }
}

/** テスト用: 直近の countStable が確定と判定したマス */
export function lastStableFlags(): Uint8Array {
  return stableFlags
}
