/**
 * 既存CPU（`strategy` / GA育成18体 / random / max_flip）を高速シミュレータに載せる橋渡し。
 *
 * 既存CPUは `PublicMatchState` を受け取る窓口なので、FastPosition から公開状態を組み立てる。
 * 比較相手として使うだけなので、ここは速さより「既存実装と同じ判断をすること」を優先する。
 */
import { getCpuAgent, type CpuAgent, type CpuTypeId } from '../../cpu/index.ts'
import {
  BLACK,
  WHITE,
  cellIndex,
} from '../../cpu/strategy/fastBoard.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import type { Board, Cell, PublicMatchState, Stone } from '../../game/types.ts'
import { decideWithGenes } from '../../ga/geneCpu.ts'
import { coordToAction } from '../../sim/actions.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'
import {
  SIDE_BLACK,
  SIDE_WHITE,
  TS_COOLDOWN,
  TS_PRIORITY,
  TS_TIME,
  type FastAgent,
  type FastMatch,
} from '../sim/fastMatch.ts'

const CELL_LOOKUP = buildCellLookup()

function buildCellLookup(): Int32Array {
  const size = GAME_CONFIG.boardSize
  const table = new Int32Array(size * size)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      table[row * size + col] = cellIndex(row, col)
    }
  }
  return table
}

function createMutableBoard(): Board {
  const size = GAME_CONFIG.boardSize
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null as Cell),
  )
}

/** FastPosition の内容を Board に写す（毎回同じ配列を使い回す） */
export function materializeBoard(match: FastMatch, into: Board): Board {
  const size = GAME_CONFIG.boardSize
  const cells = match.pos.cells
  for (let row = 0; row < size; row += 1) {
    const target = into[row]!
    for (let col = 0; col < size; col += 1) {
      const v = cells[CELL_LOOKUP[row * size + col]]
      target[col] = v === BLACK ? 'black' : v === WHITE ? 'white' : null
    }
  }
  return into
}

export function sideToStone(side: number): Stone {
  return side === SIDE_BLACK ? 'black' : 'white'
}

/** 既存CPUに渡す公開状態。同じオブジェクトを使い回す */
function createPublicStateHolder(): {
  board: Board
  state: PublicMatchState
} {
  const board = createMutableBoard()
  const state: PublicMatchState = {
    board,
    cooldowns: { black: 0, white: 0 },
    elapsedMs: 0,
    remainingMatchMs: GAME_CONFIG.matchDurationMs,
    phase: 'playing',
    simultaneousPriority: 'black',
    endReason: null,
    outcome: null,
  }
  return { board, state }
}

function fillPublicState(
  holder: { board: Board; state: PublicMatchState },
  match: FastMatch,
): PublicMatchState {
  materializeBoard(match, holder.board)
  const ts = match.ts
  holder.state.cooldowns.black = ts[TS_COOLDOWN + SIDE_BLACK]!
  holder.state.cooldowns.white = ts[TS_COOLDOWN + SIDE_WHITE]!
  holder.state.elapsedMs = ts[TS_TIME]!
  holder.state.remainingMatchMs = Math.max(
    0,
    match.config.matchDurationMs - ts[TS_TIME]!,
  )
  holder.state.phase = 'playing'
  holder.state.simultaneousPriority =
    ts[TS_PRIORITY] === SIDE_BLACK ? 'black' : 'white'
  return holder.state
}

/** 既存 CpuAgent をそのまま使う */
export function legacyCpuAgent(id: CpuTypeId): FastAgent {
  return legacyAgentOf(getCpuAgent(id), `legacy:${id}`)
}

/** 名簿に載っていない設定の CpuAgent も測れるようにする */
export function legacyAgentOf(agent: CpuAgent, id: string): FastAgent {
  const holder = createPublicStateHolder()
  return {
    id,
    decide(match, side, rng) {
      const state = fillPublicState(holder, match)
      const decision = agent.decide(state, rng, sideToStone(side))
      if (decision.type === 'move') {
        return coordToAction(decision.row, decision.col)
      }
      return WAIT_ACTION
    },
  }
}

/** GA の遺伝子列をそのまま使う（milestone 以外の任意個体も比較できる） */
export function legacyGeneAgent(id: string, genes: readonly number[]): FastAgent {
  const holder = createPublicStateHolder()
  const geneArray = [...genes]
  return {
    id: `gene:${id}`,
    decide(match, side, rng) {
      const state = fillPublicState(holder, match)
      const { decision } = decideWithGenes(
        geneArray,
        state,
        sideToStone(side),
        rng,
      )
      if (decision.type === 'move') {
        return coordToAction(decision.row, decision.col)
      }
      return WAIT_ACTION
    },
  }
}
