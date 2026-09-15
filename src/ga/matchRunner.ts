import { createHash } from 'node:crypto'
import { getCpuAgent, type CpuAgent, type CpuTypeId } from '../cpu/index.ts'
import {
  advanceMatch,
  createMatch,
  createRng,
  hasLegalMove,
  stepMatch,
  toPublicMatchState,
} from '../game/index.ts'
import { GAME_CONFIG } from '../game/config.ts'
import type { MatchState, Stone } from '../game/types.ts'
import {
  boardSignature,
  createIdleThinkGate,
  tickThinkGate,
  type ThinkGateState,
} from '../cpu/thinkGate.ts'
import { pickRandomLegalMove } from '../game/randomLegal.ts'
import { WAIT_ACTION } from '../sim/constants.ts'
import { coordToAction } from '../sim/actions.ts'
import { decideWithGenes, type GeneDecisionCache } from './geneCpu.ts'
import { deriveSeed } from './rng.ts'

const BLACK_IDLE_SIG = 'ga-idle-black'
const WHITE_IDLE_SIG = 'ga-idle-white'

function applyIdleIfWaiting(
  canPlaceFlag: boolean,
  idleReady: boolean,
  geneAction: number,
  board: MatchState['board'],
  stone: Stone,
  rng: ReturnType<typeof createRng>,
): number {
  if (geneAction !== WAIT_ACTION) return geneAction
  if (!canPlaceFlag || !idleReady) return WAIT_ACTION
  const pick = pickRandomLegalMove(board, stone, rng)
  if (!pick) return WAIT_ACTION
  return coordToAction(pick.row, pick.col)
}

export type OpponentSpec =
  | { kind: 'gene'; id: string; genes: number[] }
  | { kind: 'builtin'; id: CpuTypeId }
  /** 登録済みIDを持たない検証用エージェント（強さ比較などに使う） */
  | { kind: 'agent'; id: string; agent: CpuAgent }

export type GaMatchResult = {
  matchId: string
  seed: number
  blackId: string
  whiteId: string
  outcome: 'black_win' | 'white_win' | 'draw'
  endReason: string | null
  stoneDiffForBlack: number
  moveHash: string
  elapsedMs: number
  abnormal: boolean
}

function canPlace(state: MatchState, stone: Stone): boolean {
  return state.cooldowns[stone] === 0 && hasLegalMove(state.board, stone)
}

function chooseAction(
  spec: OpponentSpec,
  stone: Stone,
  publicState: ReturnType<typeof toPublicMatchState>,
  rng: ReturnType<typeof createRng>,
  thinkReadyFlag: boolean,
  cacheRef: { current: GeneDecisionCache | null },
  signature: string,
): number {
  const able =
    publicState.cooldowns[stone] === 0 &&
    hasLegalMove(publicState.board, stone)
  if (!able || !thinkReadyFlag) {
    cacheRef.current = null
    return WAIT_ACTION
  }

  if (spec.kind === 'builtin' || spec.kind === 'agent') {
    cacheRef.current = null
    const agent = spec.kind === 'agent' ? spec.agent : getCpuAgent(spec.id)
    const d = agent.decide(publicState, rng, stone)
    if (d.type === 'move') return coordToAction(d.row, d.col)
    return WAIT_ACTION
  }
  const { decision, cache } = decideWithGenes(
    spec.genes,
    publicState,
    stone,
    rng,
    cacheRef.current,
    signature,
  )
  cacheRef.current = cache
  return decision.action
}

/** ready で自発WAITした場合、次 tick ですぐ ready になるようゲートを残す */
function afterVoluntaryWait(
  gate: ThinkGateState,
  canPlaceFlag: boolean,
  wasReady: boolean,
  action: number,
  signature: string,
): ThinkGateState {
  if (canPlaceFlag && wasReady && action === WAIT_ACTION) {
    return { remainingMs: 0, signature }
  }
  return gate
}

/**
 * 双方が着手不能（クールタイム等）のとき、次の判断点まで時間だけ進める。
 * 判断待ち中・自発WAITは圧縮しない。
 */
function fastForwardBothUnable(state: MatchState): MatchState {
  const b = state.cooldowns.black
  const w = state.cooldowns.white
  const remain = Math.max(0, GAME_CONFIG.matchDurationMs - state.elapsedMs)
  // 双方CD=0なのに着手不能 → 合法手なし。終了判定のため1ステップだけ
  if (b <= 0 && w <= 0) {
    return stepMatch(state).state
  }
  let jump = remain
  if (b > 0) jump = Math.min(jump, b)
  if (w > 0) jump = Math.min(jump, w)
  jump = Math.floor(jump / GAME_CONFIG.stepMs) * GAME_CONFIG.stepMs
  if (jump < GAME_CONFIG.stepMs) jump = GAME_CONFIG.stepMs
  return advanceMatch(state, jump)
}

/**
 * 遺伝子CPU同士（または固定CPU）の1試合。
 * ゲーム内時間のみ進行。双方 thinkDelay=500, cooldown=700。
 * 各側の同点選択乱数は分離する。
 */
export function runGaMatch(options: {
  matchId: string
  seed: number
  black: OpponentSpec & { labelId: string }
  white: OpponentSpec & { labelId: string }
  decisionSeed: number
}): GaMatchResult {
  const match = createMatch({
    seed: options.seed,
    cooldownMs: GAME_CONFIG.cooldownMs,
  })
  let state = match
  const blackRng = createRng(deriveSeed(options.decisionSeed, 1))
  const whiteRng = createRng(deriveSeed(options.decisionSeed, 2))
  let blackGate = createIdleThinkGate()
  let whiteGate = createIdleThinkGate()
  let blackIdle = createIdleThinkGate()
  let whiteIdle = createIdleThinkGate()
  const blackCache = { current: null as GeneDecisionCache | null }
  const whiteCache = { current: null as GeneDecisionCache | null }
  const moveParts: string[] = []
  let steps = 0
  const maxSteps =
    Math.ceil(GAME_CONFIG.matchDurationMs / GAME_CONFIG.stepMs) + 100

  while (state.phase === 'playing' && steps < maxSteps) {
    const blackCan = canPlace(state, 'black')
    const whiteCan = canPlace(state, 'white')

    // 双方着手不能: 評価関数を呼ばず時間だけ進める（結果は step 連続と同等）
    if (!blackCan && !whiteCan) {
      const before = state.elapsedMs
      state = fastForwardBothUnable(state)
      const advanced = Math.max(
        GAME_CONFIG.stepMs,
        state.elapsedMs - before,
      )
      steps += Math.ceil(advanced / GAME_CONFIG.stepMs)
      blackGate = createIdleThinkGate()
      whiteGate = createIdleThinkGate()
      blackIdle = createIdleThinkGate()
      whiteIdle = createIdleThinkGate()
      blackCache.current = null
      whiteCache.current = null
      continue
    }

    const publicState = toPublicMatchState(state)
    const sig = boardSignature(state.board)

    // 判断待ちの残りを覗き、双方とも未readyならまとめて進める（省略ではなく等価な連続step）
    const peekBlack = tickThinkGate(blackGate, {
      canAct: blackCan,
      signature: sig,
      delayMs: GAME_CONFIG.cpuThinkDelayMs,
      stepMs: GAME_CONFIG.stepMs,
    })
    const peekWhite = tickThinkGate(whiteGate, {
      canAct: whiteCan,
      signature: sig,
      delayMs: GAME_CONFIG.cpuThinkDelayMs,
      stepMs: GAME_CONFIG.stepMs,
    })

    const peekBlackIdle = tickThinkGate(blackIdle, {
      canAct: blackCan,
      signature: BLACK_IDLE_SIG,
      delayMs: GAME_CONFIG.idleAutoMoveMs,
      stepMs: GAME_CONFIG.stepMs,
    })
    const peekWhiteIdle = tickThinkGate(whiteIdle, {
      canAct: whiteCan,
      signature: WHITE_IDLE_SIG,
      delayMs: GAME_CONFIG.idleAutoMoveMs,
      stepMs: GAME_CONFIG.stepMs,
    })

    if (
      !peekBlack.ready &&
      !peekWhite.ready &&
      !peekBlackIdle.ready &&
      !peekWhiteIdle.ready
    ) {
      const remB = peekBlack.gate.remainingMs
      const remW = peekWhite.gate.remainingMs
      const remIdleB = peekBlackIdle.gate.remainingMs
      const remIdleW = peekWhiteIdle.gate.remainingMs
      let jumpMs: number = GAME_CONFIG.stepMs
      const rems = [remB, remW, remIdleB, remIdleW].filter(
        (v): v is number => v !== null,
      )
      if (rems.length > 0) jumpMs = Math.min(...rems)
      if (state.cooldowns.black > 0) {
        jumpMs = Math.min(jumpMs, state.cooldowns.black)
      }
      if (state.cooldowns.white > 0) {
        jumpMs = Math.min(jumpMs, state.cooldowns.white)
      }
      jumpMs = Math.max(
        GAME_CONFIG.stepMs,
        Math.floor(jumpMs / GAME_CONFIG.stepMs) * GAME_CONFIG.stepMs,
      )
      const stepsJump = Math.floor(jumpMs / GAME_CONFIG.stepMs)
      for (let i = 0; i < stepsJump; i += 1) {
        const sigNow = boardSignature(state.board)
        const canB = canPlace(state, 'black')
        const canW = canPlace(state, 'white')
        const tb = tickThinkGate(blackGate, {
          canAct: canB,
          signature: sigNow,
          delayMs: GAME_CONFIG.cpuThinkDelayMs,
          stepMs: GAME_CONFIG.stepMs,
        })
        const tw = tickThinkGate(whiteGate, {
          canAct: canW,
          signature: sigNow,
          delayMs: GAME_CONFIG.cpuThinkDelayMs,
          stepMs: GAME_CONFIG.stepMs,
        })
        const ib = tickThinkGate(blackIdle, {
          canAct: canB,
          signature: BLACK_IDLE_SIG,
          delayMs: GAME_CONFIG.idleAutoMoveMs,
          stepMs: GAME_CONFIG.stepMs,
        })
        const iw = tickThinkGate(whiteIdle, {
          canAct: canW,
          signature: WHITE_IDLE_SIG,
          delayMs: GAME_CONFIG.idleAutoMoveMs,
          stepMs: GAME_CONFIG.stepMs,
        })
        blackGate = tb.gate
        whiteGate = tw.gate
        blackIdle = ib.gate
        whiteIdle = iw.gate
        state = stepMatch(state).state
        steps += 1
        if (state.phase !== 'playing') break
        if (tb.ready || tw.ready || ib.ready || iw.ready) break
      }
      continue
    }

    blackGate = peekBlack.gate
    whiteGate = peekWhite.gate
    blackIdle = peekBlackIdle.gate
    whiteIdle = peekWhiteIdle.gate
    const bt = peekBlack
    const wt = peekWhite

    let blackAction = chooseAction(
      options.black,
      'black',
      publicState,
      blackRng,
      bt.ready,
      blackCache,
      sig,
    )
    let whiteAction = chooseAction(
      options.white,
      'white',
      publicState,
      whiteRng,
      wt.ready,
      whiteCache,
      sig,
    )
    blackAction = applyIdleIfWaiting(
      blackCan,
      peekBlackIdle.ready,
      blackAction,
      state.board,
      'black',
      blackRng,
    )
    whiteAction = applyIdleIfWaiting(
      whiteCan,
      peekWhiteIdle.ready,
      whiteAction,
      state.board,
      'white',
      whiteRng,
    )

    blackGate = afterVoluntaryWait(
      blackGate,
      blackCan,
      bt.ready,
      blackAction,
      sig,
    )
    whiteGate = afterVoluntaryWait(
      whiteGate,
      whiteCan,
      wt.ready,
      whiteAction,
      sig,
    )

    if (blackAction !== WAIT_ACTION) moveParts.push(`b${blackAction}`)
    if (whiteAction !== WAIT_ACTION) moveParts.push(`w${whiteAction}`)

    const result = stepMatch(state, {
      black:
        blackAction === WAIT_ACTION
          ? undefined
          : {
              row: Math.floor(blackAction / 10),
              col: blackAction % 10,
            },
      white:
        whiteAction === WAIT_ACTION
          ? undefined
          : {
              row: Math.floor(whiteAction / 10),
              col: whiteAction % 10,
            },
    })
    state = result.state
    steps += 1
    if (result.applied.some((m) => m.player === 'black')) {
      blackIdle = createIdleThinkGate()
    }
    if (result.applied.some((m) => m.player === 'white')) {
      whiteIdle = createIdleThinkGate()
    }
  }

  const counts = { black: 0, white: 0, empty: 0 }
  for (const row of state.board) {
    for (const cell of row) {
      if (cell === 'black') counts.black += 1
      else if (cell === 'white') counts.white += 1
      else counts.empty += 1
    }
  }

  const moveHash = createHash('sha256')
    .update(moveParts.join(','))
    .digest('hex')
    .slice(0, 16)

  return {
    matchId: options.matchId,
    seed: options.seed,
    blackId: options.black.labelId,
    whiteId: options.white.labelId,
    outcome: state.outcome ?? 'draw',
    endReason: state.endReason,
    stoneDiffForBlack: counts.black - counts.white,
    moveHash,
    elapsedMs: state.elapsedMs,
    abnormal: state.phase !== 'finished',
  }
}

export function scoreForSide(
  result: GaMatchResult,
  side: Stone,
): {
  points: number
  win: boolean
  draw: boolean
  loss: boolean
  stoneDiff: number
} {
  if (result.abnormal) {
    throw new Error(`abnormal match ${result.matchId}`)
  }
  const win =
    (side === 'black' && result.outcome === 'black_win') ||
    (side === 'white' && result.outcome === 'white_win')
  const draw = result.outcome === 'draw'
  const loss = !win && !draw
  const stoneDiff =
    side === 'black' ? result.stoneDiffForBlack : -result.stoneDiffForBlack
  return {
    points: win ? 1 : draw ? 0.5 : 0,
    win,
    draw,
    loss,
    stoneDiff,
  }
}

export function makeMatchId(parts: {
  generation: number
  phase: 'primary' | 'extra' | 'validate' | 'holdout'
  indId: string
  oppId: string
  side: Stone
  slot: number
}): string {
  return `g${parts.generation}-${parts.phase}-${parts.indId}-vs-${parts.oppId}-${parts.side}-s${parts.slot}`
}

export function matchSeeds(
  masterSeed: number,
  generation: number,
  indKey: string,
  oppKey: string,
  side: Stone,
  slot: number,
): { gameSeed: number; decisionSeed: number } {
  const gameSeed = deriveSeed(
    masterSeed,
    generation,
    hashStr(indKey),
    hashStr(oppKey),
    side === 'black' ? 1 : 2,
    slot,
    0x11,
  )
  const decisionSeed = deriveSeed(gameSeed, 0x22)
  return { gameSeed, decisionSeed }
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
