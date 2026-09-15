import { placeStone, listLegalMoves } from '../game/board.ts'
import type { Board, PublicMatchState, Stone } from '../game/types.ts'
import type { Rng } from '../game/rng.ts'
import {
  attachWaitFeatures,
  computeBoardFeatures,
  phaseProgress,
} from './features.ts'
import { interpolateWeights, scoreFeatures } from './genes.ts'
import { WAIT_ACTION } from '../sim/constants.ts'
import { coordToAction } from '../sim/actions.ts'

export type GeneDecision =
  | { type: 'move'; row: number; col: number; action: number; score: number }
  | { type: 'wait'; action: number; score: number }

export type GeneDecisionCache = {
  signature: string
  stone: Stone
  genes: number[]
  weights: number[]
  moveCands: Array<{ row: number; col: number; score: number }>
  /** WAIT時の盤面特徴0–8（9以降は都度付与） */
  waitBoardFeats: number[]
}

/**
 * 純粋な行動決定（ファイルI/Oなし）。
 * publicState / rng / board を変更しない（仮盤面のみ）。
 * 盤面不変の自発WAIT連続では cache で着手候補スコアを再利用する。
 */
export function decideWithGenes(
  genes: number[],
  publicState: PublicMatchState,
  stone: Stone,
  rng: Rng,
  cache?: GeneDecisionCache | null,
  signature?: string,
): { decision: GeneDecision; cache: GeneDecisionCache | null } {
  if (publicState.phase !== 'playing') {
    return {
      decision: {
        type: 'wait',
        action: WAIT_ACTION,
        score: Number.NEGATIVE_INFINITY,
      },
      cache: null,
    }
  }
  if (publicState.cooldowns[stone] > 0) {
    return {
      decision: {
        type: 'wait',
        action: WAIT_ACTION,
        score: Number.NEGATIVE_INFINITY,
      },
      cache: null,
    }
  }

  const board = publicState.board
  const opp = stone === 'black' ? 'white' : 'black'
  const sig = signature ?? ''

  let moveCands: Array<{ row: number; col: number; score: number }>
  let waitBoardFeats: number[]
  let weights: number[]
  let nextCache: GeneDecisionCache

  const cacheHit =
    cache &&
    cache.signature === sig &&
    cache.stone === stone &&
    cache.genes === genes

  if (cacheHit) {
    moveCands = cache.moveCands
    waitBoardFeats = cache.waitBoardFeats
    weights = cache.weights
    nextCache = cache
  } else {
    const legal = listLegalMoves(board, stone)
    const progress = phaseProgress(board)
    weights = interpolateWeights(genes, progress)
    moveCands = []
    for (const m of legal) {
      const placed = placeStone(board, m.row, m.col, stone)
      if (!placed.ok) continue
      const feats = attachWaitFeatures(
        computeBoardFeatures(placed.board, stone),
        {
          isWait: false,
          opponentCooldownMs: publicState.cooldowns[opp],
          remainingMatchMs: publicState.remainingMatchMs,
        },
      )
      moveCands.push({
        row: m.row,
        col: m.col,
        score: scoreFeatures(feats, weights),
      })
    }
    waitBoardFeats = computeBoardFeatures(board, stone)
    nextCache = {
      signature: sig,
      stone,
      genes,
      weights,
      moveCands,
      waitBoardFeats,
    }
  }

  const waitFeats = attachWaitFeatures(waitBoardFeats, {
    isWait: true,
    opponentCooldownMs: publicState.cooldowns[opp],
    remainingMatchMs: publicState.remainingMatchMs,
  })
  const waitScore = scoreFeatures(waitFeats, weights)

  type Cand =
    | { kind: 'move'; row: number; col: number; score: number }
    | { kind: 'wait'; score: number }
  const cands: Cand[] = moveCands.map((m) => ({
    kind: 'move' as const,
    row: m.row,
    col: m.col,
    score: m.score,
  }))
  cands.push({ kind: 'wait', score: waitScore })

  if (cands.length === 0) {
    return {
      decision: {
        type: 'wait',
        action: WAIT_ACTION,
        score: Number.NEGATIVE_INFINITY,
      },
      cache: null,
    }
  }

  let best = cands[0]!.score
  for (const c of cands) if (c.score > best) best = c.score
  const tied = cands.filter((c) => c.score === best)
  const pick = tied[rng.nextInt(0, tied.length)]!

  if (pick.kind === 'move') {
    return {
      decision: {
        type: 'move',
        row: pick.row,
        col: pick.col,
        action: coordToAction(pick.row, pick.col),
        score: pick.score,
      },
      cache: nextCache,
    }
  }
  return {
    decision: { type: 'wait', action: WAIT_ACTION, score: pick.score },
    cache: nextCache,
  }
}

/** テスト互換: 決定のみ返す */
export function decideWithGenesSimple(
  genes: number[],
  publicState: PublicMatchState,
  stone: Stone,
  rng: Rng,
): GeneDecision {
  return decideWithGenes(genes, publicState, stone, rng).decision
}

/** テスト用: 仮評価が元盤面を壊さないこと */
export function peekBoardUnchanged(board: Board, fn: () => void): boolean {
  const before = JSON.stringify(board)
  fn()
  return JSON.stringify(board) === before
}
