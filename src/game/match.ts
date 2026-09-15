import {
  cloneBoard,
  countStones,
  createInitialBoard,
  hasLegalMove,
  placeStone,
} from './board.ts'
import { GAME_CONFIG } from './config.ts'
import { initialSimultaneousPriority, oppositeStone } from './rng.ts'
import type {
  AppliedMove,
  MatchState,
  Outcome,
  PublicMatchState,
  RejectedMove,
  StepInput,
  StepResult,
  Stone,
} from './types.ts'

export type CreateMatchOptions = {
  seed?: number
  /** 省略時は GAME_CONFIG.cooldownMs */
  cooldownMs?: number
}

export function createMatch(options: CreateMatchOptions = {}): MatchState {
  const seed = options.seed ?? 0
  const cooldownMs = options.cooldownMs ?? GAME_CONFIG.cooldownMs

  return {
    board: createInitialBoard(),
    elapsedMs: 0,
    cooldowns: { black: 0, white: 0 },
    cooldownMs,
    simultaneousPriority: initialSimultaneousPriority(seed),
    phase: 'playing',
    endReason: null,
    outcome: null,
    seed,
  }
}

export function cloneMatchState(state: MatchState): MatchState {
  return {
    board: cloneBoard(state.board),
    elapsedMs: state.elapsedMs,
    cooldowns: { ...state.cooldowns },
    cooldownMs: state.cooldownMs,
    simultaneousPriority: state.simultaneousPriority,
    phase: state.phase,
    endReason: state.endReason,
    outcome: state.outcome,
    seed: state.seed,
  }
}

export function toPublicMatchState(state: MatchState): PublicMatchState {
  return {
    board: cloneBoard(state.board),
    cooldowns: { ...state.cooldowns },
    elapsedMs: state.elapsedMs,
    remainingMatchMs: Math.max(
      0,
      GAME_CONFIG.matchDurationMs - state.elapsedMs,
    ),
    phase: state.phase,
    simultaneousPriority: state.simultaneousPriority,
    endReason: state.endReason,
    outcome: state.outcome,
  }
}

export function pauseMatch(state: MatchState): MatchState {
  if (state.phase !== 'playing') return state
  return { ...cloneMatchState(state), phase: 'paused' }
}

/** 再開時に停止中の時間を進めず、未処理入力も引き継がない（入力は step 引数のみ）。 */
export function resumeMatch(state: MatchState): MatchState {
  if (state.phase !== 'paused') return state
  return { ...cloneMatchState(state), phase: 'playing' }
}

function decideOutcome(state: MatchState): Outcome {
  const { black, white } = countStones(state.board)
  if (black > white) return 'black_win'
  if (white > black) return 'white_win'
  return 'draw'
}

function finishMatch(
  state: MatchState,
  endReason: NonNullable<MatchState['endReason']>,
): MatchState {
  return {
    ...state,
    phase: 'finished',
    endReason,
    outcome: decideOutcome(state),
  }
}

function isBoardFull(state: MatchState): boolean {
  return countStones(state.board).empty === 0
}

function bothHaveNoLegalMoves(state: MatchState): boolean {
  return (
    !hasLegalMove(state.board, 'black') && !hasLegalMove(state.board, 'white')
  )
}

function checkEndAfterBoardChange(state: MatchState): MatchState {
  if (isBoardFull(state)) {
    return finishMatch(state, 'board_full')
  }
  if (bothHaveNoLegalMoves(state)) {
    return finishMatch(state, 'no_legal_moves')
  }
  return state
}

function tryApplyMove(
  state: MatchState,
  player: Stone,
  row: number,
  col: number,
): {
  state: MatchState
  applied: AppliedMove | null
  rejected: RejectedMove | null
} {
  if (state.phase === 'finished') {
    return {
      state,
      applied: null,
      rejected: {
        player,
        row,
        col,
        reason: 'finished',
      },
    }
  }

  if (state.phase === 'paused') {
    return {
      state,
      applied: null,
      rejected: { player, row, col, reason: 'paused' },
    }
  }

  if (state.elapsedMs >= GAME_CONFIG.matchDurationMs) {
    return {
      state,
      applied: null,
      rejected: { player, row, col, reason: 'finished' },
    }
  }

  if (state.cooldowns[player] > 0) {
    return {
      state,
      applied: null,
      rejected: { player, row, col, reason: 'cooldown' },
    }
  }

  const placed = placeStone(state.board, row, col, player)
  if (!placed.ok) {
    return {
      state,
      applied: null,
      rejected: {
        player,
        row,
        col,
        reason: placed.reason,
      },
    }
  }

  const next: MatchState = {
    ...state,
    board: placed.board,
    cooldowns: {
      ...state.cooldowns,
      [player]: state.cooldownMs,
    },
  }

  return {
    state: next,
    applied: {
      player,
      row,
      col,
      flipped: placed.flipped,
    },
    rejected: null,
  }
}

function orderForSimultaneous(
  priority: Stone,
): [Stone, Stone] {
  return priority === 'black' ? ['black', 'white'] : ['white', 'black']
}

/**
 * ゲーム内時間を 1 ステップ（既定 50ms）進める。
 * 実時間は待たない。同じ入力なら決定的。
 */
export function stepMatch(
  state: MatchState,
  input: StepInput = {},
): StepResult {
  const applied: AppliedMove[] = []
  const rejected: RejectedMove[] = []

  if (state.phase === 'finished') {
    for (const player of ['black', 'white'] as const) {
      const req = input[player]
      if (req) {
        rejected.push({
          player,
          row: req.row,
          col: req.col,
          reason: 'finished',
        })
      }
    }
    return { state, applied, rejected }
  }

  if (state.phase === 'paused') {
    for (const player of ['black', 'white'] as const) {
      const req = input[player]
      if (req) {
        rejected.push({
          player,
          row: req.row,
          col: req.col,
          reason: 'paused',
        })
      }
    }
    // 一時停止中はすべてのゲーム内時間が進まない
    return { state, applied, rejected }
  }

  let next = cloneMatchState(state)

  // 時間切れと同時刻以降の着手は受け付けない
  const canAcceptMoves = next.elapsedMs < GAME_CONFIG.matchDurationMs

  const blackReq = input.black
  const whiteReq = input.white
  const bothRequested = Boolean(blackReq) && Boolean(whiteReq)

  if (canAcceptMoves && (blackReq || whiteReq)) {
    if (bothRequested && blackReq && whiteReq) {
      const [first, second] = orderForSimultaneous(next.simultaneousPriority)
      const requests = {
        black: blackReq,
        white: whiteReq,
      } as const

      const firstReq = requests[first]
      const firstResult = tryApplyMove(
        next,
        first,
        firstReq.row,
        firstReq.col,
      )
      next = firstResult.state
      if (firstResult.applied) applied.push(firstResult.applied)
      if (firstResult.rejected) rejected.push(firstResult.rejected)

      next = checkEndAfterBoardChange(next)

      if (next.phase === 'finished') {
        const secondReq = requests[second]
        rejected.push({
          player: second,
          row: secondReq.row,
          col: secondReq.col,
          reason: 'skipped_after_end',
        })
      } else {
        const secondReq = requests[second]
        const secondResult = tryApplyMove(
          next,
          second,
          secondReq.row,
          secondReq.col,
        )
        next = secondResult.state
        if (secondResult.applied) applied.push(secondResult.applied)
        if (secondResult.rejected) rejected.push(secondResult.rejected)
        next = checkEndAfterBoardChange(next)
      }

      // 双方が要求した同時着手のたびに優先側を交代（片方だけなら交代しない）
      next = {
        ...next,
        simultaneousPriority: oppositeStone(state.simultaneousPriority),
      }
    } else {
      const player: Stone = blackReq ? 'black' : 'white'
      const req = blackReq ?? whiteReq
      if (req) {
        const result = tryApplyMove(next, player, req.row, req.col)
        next = result.state
        if (result.applied) applied.push(result.applied)
        if (result.rejected) rejected.push(result.rejected)
        next = checkEndAfterBoardChange(next)
      }
    }
  } else if (!canAcceptMoves) {
    for (const player of ['black', 'white'] as const) {
      const req = input[player]
      if (req) {
        rejected.push({
          player,
          row: req.row,
          col: req.col,
          reason: 'finished',
        })
      }
    }
  }

  // 終了済みなら時間は進めない
  if (next.phase === 'finished') {
    return { state: next, applied, rejected }
  }

  // 固定ステップで時間と待ち時間を進める（回復は 0 で止まり、貯めない）
  const stepMs = GAME_CONFIG.stepMs
  next = {
    ...next,
    elapsedMs: next.elapsedMs + stepMs,
    cooldowns: {
      black: Math.max(0, next.cooldowns.black - stepMs),
      white: Math.max(0, next.cooldowns.white - stepMs),
    },
  }

  if (next.elapsedMs >= GAME_CONFIG.matchDurationMs) {
    next = finishMatch(next, 'time_up')
    return { state: next, applied, rejected }
  }

  next = checkEndAfterBoardChange(next)
  return { state: next, applied, rejected }
}

/** テスト用: 指定ミリ秒ぶん step を繰り返す（入力なし） */
export function advanceMatch(state: MatchState, ms: number): MatchState {
  const steps = Math.floor(ms / GAME_CONFIG.stepMs)
  let current = state
  for (let i = 0; i < steps; i += 1) {
    current = stepMatch(current).state
    if (current.phase === 'finished') break
  }
  return current
}

export function getStoneCounts(state: MatchState) {
  return countStones(state.board)
}
