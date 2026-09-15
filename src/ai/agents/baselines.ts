/**
 * 比較用の下限・貪欲ベースライン。
 *
 * ルール層の `randomCpu` / `maxFlipCpu` と、
 * 手の列挙順・乱数消費回数・同点の選び方まで一致させる（fastMatch.test.ts で照合）。
 */
import {
  DIRS,
  EMPTY,
  generateMoves,
} from '../../cpu/strategy/fastBoard.ts'
import type { Rng } from '../../game/rng.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'
import {
  CELL_TO_ACTION,
  colorOfSide,
  type FastAgent,
  type FastMatch,
} from '../sim/fastMatch.ts'

const moveBuf = new Int32Array(128)
const tieBuf = new Int32Array(128)

/** 反転枚数を数えるだけ（盤面は変えない） */
export function countFlipsAt(
  cells: Uint8Array,
  cell: number,
  color: number,
): number {
  if (cells[cell] !== EMPTY) return 0
  const opp = color ^ 3
  let total = 0
  for (let d = 0; d < 8; d += 1) {
    const dir = DIRS[d]
    let j = cell + dir
    if (cells[j] !== opp) continue
    let run = 0
    do {
      j += dir
      run += 1
    } while (cells[j] === opp)
    if (cells[j] === color) total += run
  }
  return total
}

export const randomAgent: FastAgent = {
  id: 'random',
  decide(match: FastMatch, side: number, rng: Rng): number {
    const n = generateMoves(match.pos, colorOfSide(side), moveBuf, 0)
    if (n === 0) return WAIT_ACTION
    return CELL_TO_ACTION[moveBuf[rng.nextInt(0, n)]]
  },
}

export const maxFlipAgent: FastAgent = {
  id: 'max_flip',
  decide(match: FastMatch, side: number, rng: Rng): number {
    const color = colorOfSide(side)
    const cells = match.pos.cells
    const n = generateMoves(match.pos, color, moveBuf, 0)
    if (n === 0) return WAIT_ACTION

    let bestCount = -1
    let tieCount = 0
    for (let k = 0; k < n; k += 1) {
      const cell = moveBuf[k]
      const flips = countFlipsAt(cells, cell, color)
      if (flips > bestCount) {
        bestCount = flips
        tieCount = 0
        tieBuf[tieCount] = cell
        tieCount += 1
      } else if (flips === bestCount) {
        tieBuf[tieCount] = cell
        tieCount += 1
      }
    }
    return CELL_TO_ACTION[tieBuf[rng.nextInt(0, tieCount)]]
  },
}

/** 常に自発待機する。無操作 3 秒の強制着手だけで進むことの確認用 */
export const waitAgent: FastAgent = {
  id: 'wait',
  decide(): number {
    return WAIT_ACTION
  },
}
