import { getCpuAgent, type CpuTypeId } from '../cpu/index.ts'
import {
  boardSignature,
  createIdleThinkGate,
  tickThinkGate,
  type ThinkGateState,
} from '../cpu/thinkGate.ts'
import {
  createMatch,
  hasLegalMove,
  pauseMatch,
  pickRandomLegalMove,
  resumeMatch,
  stepMatch,
  toPublicMatchState,
} from '../game/index.ts'
import { GAME_CONFIG } from '../game/config.ts'
import type { Rng } from '../game/rng.ts'
import type {
  AppliedMove,
  MatchState,
  MoveRequest,
  Stone,
} from '../game/types.ts'

export type SessionScreen = 'title' | 'countdown' | 'playing' | 'result'

export type SessionSettings = {
  seed: number
  cooldownMs: number
  cpuType: CpuTypeId
}

export type LastMove = {
  row: number
  col: number
  player: Stone
}

const PLAYER_IDLE_SIGNATURE = 'player-idle'
const CPU_IDLE_SIGNATURE = 'cpu-idle'

export type SessionState = {
  screen: SessionScreen
  settings: SessionSettings
  match: MatchState | null
  /** カウントダウン残り（ゲーム内時間）。3・2・1 表示用 */
  countdownRemainingMs: number
  /** CPU 判断待ちの残り。null は未開始 / 対象外 */
  cpuThinkRemainingMs: number | null
  /** 判断待ち開始時の盤面署名。変化で待ち直し */
  cpuThinkSignature: string | null
  /** プレイヤー無操作自動着手までの残り。null は未開始 / 対象外 */
  playerIdleRemainingMs: number | null
  /** CPU 無操作自動着手までの残り。null は未開始 / 対象外 */
  cpuIdleRemainingMs: number | null
  pendingPlayerMove: MoveRequest | null
  lastMove: LastMove | null
}

/**
 * CPU が次に着手を求められるまでのゲーム内ミリ秒。
 *
 * 判断待ちが始まっていればその残り。まだ始まっていなければ、
 * 待ち時間が明けてから判断待ちがまるごと入る。
 */
function msUntilCpuDecision(
  publicState: ReturnType<typeof toPublicMatchState>,
  canCpuAct: boolean,
  gate: ThinkGateState,
): number {
  if (canCpuAct) return gate.remainingMs ?? 0
  return publicState.cooldowns[GAME_CONFIG.cpuStone] + GAME_CONFIG.cpuThinkDelayMs
}

function thinkGateFromSession(session: SessionState): ThinkGateState {
  return {
    remainingMs: session.cpuThinkRemainingMs,
    signature: session.cpuThinkSignature,
  }
}

function withThinkGate(
  session: SessionState,
  gate: ThinkGateState,
): SessionState {
  return {
    ...session,
    cpuThinkRemainingMs: gate.remainingMs,
    cpuThinkSignature: gate.signature,
  }
}

function idleGateFromRemaining(
  remainingMs: number | null,
  signature: string,
): ThinkGateState {
  return {
    remainingMs,
    signature: remainingMs === null ? null : signature,
  }
}

function withIdleGates(
  session: SessionState,
  playerIdle: ThinkGateState,
  cpuIdle: ThinkGateState,
): SessionState {
  return {
    ...session,
    playerIdleRemainingMs: playerIdle.remainingMs,
    cpuIdleRemainingMs: cpuIdle.remainingMs,
  }
}

export function createTitleSession(
  settings?: Partial<SessionSettings>,
): SessionState {
  return {
    screen: 'title',
    settings: {
      seed: settings?.seed ?? 1,
      cooldownMs: settings?.cooldownMs ?? GAME_CONFIG.cooldownMs,
      cpuType: settings?.cpuType ?? 'beta',
    },
    match: null,
    countdownRemainingMs: 0,
    cpuThinkRemainingMs: null,
    cpuThinkSignature: null,
    playerIdleRemainingMs: null,
    cpuIdleRemainingMs: null,
    pendingPlayerMove: null,
    lastMove: null,
  }
}

export function startCountdown(
  settings: SessionSettings,
): SessionState {
  return {
    screen: 'countdown',
    settings,
    match: createMatch({
      seed: settings.seed,
      cooldownMs: settings.cooldownMs,
    }),
    countdownRemainingMs: GAME_CONFIG.countdownMs,
    cpuThinkRemainingMs: null,
    cpuThinkSignature: null,
    playerIdleRemainingMs: null,
    cpuIdleRemainingMs: null,
    pendingPlayerMove: null,
    lastMove: null,
  }
}

export function rematchSameSettings(session: SessionState): SessionState {
  return startCountdown({
    ...session.settings,
    seed: session.settings.seed + 1,
  })
}

export function queuePlayerMove(
  session: SessionState,
  move: MoveRequest,
): SessionState {
  if (session.screen !== 'playing' || !session.match) return session
  if (session.match.phase !== 'playing') return session
  // 1ステップ1件。既にあれば捨てる（予約しない）
  if (session.pendingPlayerMove) return session
  return { ...session, pendingPlayerMove: move }
}

export function pauseSession(session: SessionState): SessionState {
  if (!session.match || session.match.phase !== 'playing') return session
  return {
    ...session,
    match: pauseMatch(session.match),
    pendingPlayerMove: null,
  }
}

export function resumeSession(session: SessionState): SessionState {
  if (!session.match || session.match.phase !== 'paused') return session
  return {
    ...session,
    match: resumeMatch(session.match),
    pendingPlayerMove: null,
  }
}

export function abortPausedSession(session: SessionState): SessionState {
  if (session.screen !== 'playing' || !session.match) return session
  if (session.match.phase !== 'paused') return session
  return createTitleSession(session.settings)
}

function clearActionGates(session: SessionState): SessionState {
  const idle = createIdleThinkGate()
  return withIdleGates(
    withThinkGate(session, createIdleThinkGate()),
    idle,
    idle,
  )
}

function canAct(
  publicState: ReturnType<typeof toPublicMatchState>,
  stone: Stone,
): boolean {
  return (
    publicState.cooldowns[stone] === 0 &&
    hasLegalMove(publicState.board, stone) &&
    publicState.elapsedMs < GAME_CONFIG.matchDurationMs
  )
}

/**
 * ゲーム内 1 ステップ。実時計は使わない。
 * CPU は未確定のプレイヤー入力を見ずに要求を作る。
 */
export function stepSession(
  session: SessionState,
  rng: Rng,
): { session: SessionState; applied: AppliedMove[] } {
  if (session.screen === 'title' || session.screen === 'result') {
    return { session, applied: [] }
  }

  if (session.screen === 'countdown') {
    const remaining = session.countdownRemainingMs - GAME_CONFIG.stepMs
    if (remaining <= 0) {
      return {
        session: {
          ...session,
          screen: 'playing',
          countdownRemainingMs: 0,
          pendingPlayerMove: null,
        },
        applied: [],
      }
    }
    return {
      session: { ...session, countdownRemainingMs: remaining },
      applied: [],
    }
  }

  // playing
  if (!session.match) return { session, applied: [] }

  if (session.match.phase === 'paused') {
    return {
      session: { ...session, pendingPlayerMove: null },
      applied: [],
    }
  }

  if (session.match.phase === 'finished') {
    return {
      session: {
        ...clearActionGates(session),
        screen: 'result',
        pendingPlayerMove: null,
      },
      applied: [],
    }
  }

  const cpuStone = GAME_CONFIG.cpuStone
  const playerStone = GAME_CONFIG.playerStone
  const publicState = toPublicMatchState(session.match)
  const canCpuAct = canAct(publicState, cpuStone)
  const canPlayerAct = canAct(publicState, playerStone)

  let nextSession = session
  let cpuRequest: MoveRequest | undefined

  const thinkTick = tickThinkGate(thinkGateFromSession(nextSession), {
    canAct: canCpuAct,
    signature: boardSignature(session.match.board),
    delayMs: GAME_CONFIG.cpuThinkDelayMs,
    stepMs: GAME_CONFIG.stepMs,
  })
  nextSession = withThinkGate(nextSession, thinkTick.gate)

  if (thinkTick.ready) {
    const agent = getCpuAgent(nextSession.settings.cpuType)
    const decision = agent.decide(publicState, rng, cpuStone)
    if (decision.type === 'move') {
      cpuRequest = { row: decision.row, col: decision.col }
    }
  } else {
    // 手番が来る前のステップは下読みに使わせる。着手は返らない
    const agent = getCpuAgent(nextSession.settings.cpuType)
    agent.ponder?.(
      publicState,
      cpuStone,
      msUntilCpuDecision(publicState, canCpuAct, thinkTick.gate),
    )
  }

  const playerIdleTick = tickThinkGate(
    idleGateFromRemaining(
      nextSession.playerIdleRemainingMs,
      PLAYER_IDLE_SIGNATURE,
    ),
    {
      canAct: canPlayerAct,
      signature: PLAYER_IDLE_SIGNATURE,
      delayMs: GAME_CONFIG.idleAutoMoveMs,
      stepMs: GAME_CONFIG.stepMs,
    },
  )
  const cpuIdleTick = tickThinkGate(
    idleGateFromRemaining(nextSession.cpuIdleRemainingMs, CPU_IDLE_SIGNATURE),
    {
      canAct: canCpuAct,
      signature: CPU_IDLE_SIGNATURE,
      delayMs: GAME_CONFIG.idleAutoMoveMs,
      stepMs: GAME_CONFIG.stepMs,
    },
  )
  nextSession = withIdleGates(
    nextSession,
    playerIdleTick.gate,
    cpuIdleTick.gate,
  )

  let playerRequest = nextSession.pendingPlayerMove ?? undefined
  nextSession = { ...nextSession, pendingPlayerMove: null }

  if (!playerRequest && playerIdleTick.ready) {
    playerRequest = pickRandomLegalMove(
      publicState.board,
      playerStone,
      rng,
    )
  }

  if (!cpuRequest && cpuIdleTick.ready) {
    cpuRequest = pickRandomLegalMove(publicState.board, cpuStone, rng)
  }

  const result = stepMatch(nextSession.match!, {
    black: playerRequest,
    white: cpuRequest,
  })

  let lastMove = nextSession.lastMove
  if (result.applied.length > 0) {
    const latest = result.applied[result.applied.length - 1]!
    lastMove = {
      row: latest.row,
      col: latest.col,
      player: latest.player,
    }
  }

  nextSession = {
    ...nextSession,
    match: result.state,
    lastMove,
  }

  const playerPlaced = result.applied.some(
    (move) => move.player === playerStone,
  )
  const cpuPlaced = result.applied.some((move) => move.player === cpuStone)
  if (playerPlaced || cpuPlaced) {
    nextSession = withIdleGates(
      nextSession,
      playerPlaced
        ? createIdleThinkGate()
        : idleGateFromRemaining(
            nextSession.playerIdleRemainingMs,
            PLAYER_IDLE_SIGNATURE,
          ),
      cpuPlaced
        ? createIdleThinkGate()
        : idleGateFromRemaining(
            nextSession.cpuIdleRemainingMs,
            CPU_IDLE_SIGNATURE,
          ),
    )
  }

  if (result.state.phase === 'finished') {
    nextSession = {
      ...clearActionGates(nextSession),
      screen: 'result',
      pendingPlayerMove: null,
    }
  }

  return { session: nextSession, applied: result.applied }
}

/** テスト用: 指定ミリ秒ぶんセッションを進める */
export function advanceSession(
  session: SessionState,
  rng: Rng,
  ms: number,
): SessionState {
  const steps = Math.floor(ms / GAME_CONFIG.stepMs)
  let current = session
  for (let i = 0; i < steps; i += 1) {
    current = stepSession(current, rng).session
    if (current.screen === 'result') break
  }
  return current
}
