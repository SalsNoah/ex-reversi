import { getCpuAgent, type CpuTypeId } from '../cpu/index.ts'
import { createRng, toPublicMatchState, type Rng } from '../game/index.ts'
import { GAME_CONFIG } from '../game/config.ts'
import type { Stone } from '../game/types.ts'
import { WAIT_ACTION } from './constants.ts'
import { coordToAction } from './actions.ts'
import { createTrainingEnv, type TrainingEnv } from './env.ts'
import { toNormalizedVector } from './observation.ts'

export type LearnerSide = Stone
export type OpponentId = CpuTypeId

/** 学習環境ステップの意味の版（盤面ルール・観測形式とは別） */
export const LEARNER_STEP_SPEC_VERSION = '1.1.0-compress-forced-wait'

export type LearnerSession = {
  env: TrainingEnv
  learnerSide: LearnerSide
  opponent: OpponentId
  rng: Rng
  matchSeed: number
}

export type LearnerStepOptions = {
  /**
   * true: 学習側が WAIT のみの間、Node 内で 50ms を連続処理してから返す。
   * false: 従来どおり 1×50ms のみ。
   */
  compressForcedWait: boolean
}

export type LearnerPackedState = {
  observation: number[]
  actionMask: boolean[]
  terminated: boolean
  truncated: boolean
  info: Record<string, unknown>
}

export type LearnerStepResult = LearnerPackedState & {
  reward: number
  internalSteps: number
  advancedMs: number
  forcedWaitAutoSteps: number
  decisionPointReached: boolean
}

function isWaitOnlyMask(mask: boolean[]): boolean {
  const canPlace = mask.some((v, i) => v && i !== WAIT_ACTION)
  return !canPlace && mask[WAIT_ACTION] === true
}

function canPlaceMask(mask: boolean[]): boolean {
  return mask.some((v, i) => v && i !== WAIT_ACTION)
}

export function chooseOpponentAction(
  env: TrainingEnv,
  opponent: OpponentId,
  side: Stone,
  rng: Rng,
): number {
  const mask = env.getActionMask(side)
  if (!canPlaceMask(mask)) return WAIT_ACTION
  const agent = getCpuAgent(opponent)
  const publicState = toPublicMatchState(env.getMatch())
  const decision = agent.decide(publicState, rng, side)
  if (decision.type === 'move') {
    return coordToAction(decision.row, decision.col)
  }
  return WAIT_ACTION
}

export function createLearnerSession(options: {
  seed: number
  learnerSide: LearnerSide
  opponent: OpponentId
  cooldownMs?: number
  thinkDelayMs?: number
}): LearnerSession {
  const cooldownMs = options.cooldownMs ?? GAME_CONFIG.cooldownMs
  const thinkDelayMs = options.thinkDelayMs ?? GAME_CONFIG.cpuThinkDelayMs
  const env = createTrainingEnv({
    seed: options.seed,
    cooldownMs,
    blackThinkDelayMs: thinkDelayMs,
    whiteThinkDelayMs: thinkDelayMs,
  })
  return {
    env,
    learnerSide: options.learnerSide,
    opponent: options.opponent,
    rng: createRng(options.seed),
    matchSeed: options.seed,
  }
}

export function packLearnerState(session: LearnerSession): LearnerPackedState {
  const { env, learnerSide } = session
  const obs = toNormalizedVector(env.getObservation(learnerSide)).values
  const actionMask = env.getActionMask(learnerSide)
  const match = env.getMatch()
  const counts = env.getStoneCounts()
  return {
    observation: obs,
    actionMask,
    terminated: env.isTerminated(),
    truncated: env.isTruncated(),
    info: {
      side: learnerSide,
      opponent: session.opponent,
      seed: session.matchSeed,
      elapsedMs: match.elapsedMs,
      stepCount: env.getStepCount(),
      phase: match.phase,
      endReason: match.endReason,
      outcome: match.outcome,
      stoneCounts: counts,
      myCooldownMs: match.cooldowns[learnerSide],
      specVersion: env.specVersion,
      learnerStepSpecVersion: LEARNER_STEP_SPEC_VERSION,
      cooldownMs: env.config.cooldownMs,
      thinkDelayMs:
        learnerSide === 'black'
          ? env.config.blackThinkDelayMs
          : env.config.whiteThinkDelayMs,
    },
  }
}

function applyOneInternalStep(
  session: LearnerSession,
  learnerAction: number,
): {
  reward: number
  applied: boolean
  rejectReason: string | null
  simultaneousConflict: boolean
  canPlaceBefore: boolean
  voluntaryWait: boolean
  opponentAction: number
} {
  const { env, learnerSide, opponent, rng } = session
  const opponentSide: Stone = learnerSide === 'black' ? 'white' : 'black'
  const learnerMaskBefore = env.getActionMask(learnerSide)
  const canPlaceBefore = canPlaceMask(learnerMaskBefore)
  const opponentAction = chooseOpponentAction(env, opponent, opponentSide, rng)

  const blackAction =
    learnerSide === 'black' ? learnerAction : opponentAction
  const whiteAction =
    learnerSide === 'white' ? learnerAction : opponentAction

  const result = env.step(blackAction, whiteAction)
  const reward =
    learnerSide === 'black' ? result.rewards.black : result.rewards.white
  const learnerRec = result.requestRecords.find((r) => r.side === learnerSide)

  return {
    reward,
    applied: learnerRec?.applied === true,
    rejectReason: learnerRec?.rejectReason ?? null,
    simultaneousConflict: learnerRec?.simultaneousConflict === true,
    canPlaceBefore,
    voluntaryWait: canPlaceBefore && learnerAction === WAIT_ACTION,
    opponentAction,
  }
}

/**
 * 学習側の1行動を処理する。
 * compressForcedWait 時は、WAITのみの区間を Node 内で連続処理する。
 */
export function stepLearner(
  session: LearnerSession,
  learnerAction: number,
  options: LearnerStepOptions,
): LearnerStepResult {
  if (session.env.isTerminated() || session.env.isTruncated()) {
    throw new Error('episode_ended')
  }
  if (
    !Number.isInteger(learnerAction) ||
    learnerAction < 0 ||
    learnerAction > 100
  ) {
    throw new Error('invalid_action')
  }

  let rewardSum = 0
  let internalSteps = 0
  let forcedWaitAutoSteps = 0

  const first = applyOneInternalStep(session, learnerAction)
  rewardSum += first.reward
  internalSteps += 1

  const firstWasVoluntaryWait = first.voluntaryWait

  // 自発的 WAIT: 50ms だけ進めて、まだ着手可能でも直ちに返す（自動進行しない）
  if (firstWasVoluntaryWait) {
    const packed = packLearnerState(session)
    return {
      ...packed,
      reward: rewardSum,
      internalSteps,
      advancedMs: internalSteps * GAME_CONFIG.stepMs,
      forcedWaitAutoSteps,
      decisionPointReached: true,
      info: {
        ...packed.info,
        applied: first.applied,
        rejectReason: first.rejectReason,
        simultaneousConflict: first.simultaneousConflict,
        learnerAction,
        opponentAction: first.opponentAction,
        canPlaceBefore: first.canPlaceBefore,
        voluntaryWait: true,
        moveSuccess: first.applied,
        compressForcedWait: options.compressForcedWait,
      },
    }
  }

  if (options.compressForcedWait) {
    while (
      !session.env.isTerminated() &&
      !session.env.isTruncated() &&
      isWaitOnlyMask(session.env.getActionMask(session.learnerSide))
    ) {
      const auto = applyOneInternalStep(session, WAIT_ACTION)
      rewardSum += auto.reward
      internalSteps += 1
      forcedWaitAutoSteps += 1
    }
  }

  const packed = packLearnerState(session)
  const decisionPointReached =
    session.env.isTerminated() ||
    session.env.isTruncated() ||
    canPlaceMask(packed.actionMask) ||
    !options.compressForcedWait

  return {
    ...packed,
    reward: rewardSum,
    internalSteps,
    advancedMs: internalSteps * GAME_CONFIG.stepMs,
    forcedWaitAutoSteps,
    decisionPointReached,
    info: {
      ...packed.info,
      applied: first.applied,
      rejectReason: first.rejectReason,
      simultaneousConflict: first.simultaneousConflict,
      learnerAction,
      opponentAction: first.opponentAction,
      canPlaceBefore: first.canPlaceBefore,
      voluntaryWait: false,
      moveSuccess: first.applied,
      compressForcedWait: options.compressForcedWait,
      internalSteps,
      advancedMs: internalSteps * GAME_CONFIG.stepMs,
      forcedWaitAutoSteps,
    },
  }
}

/** 判断可能時点のスナップショット（一致テスト用） */
export function decisionSnapshot(session: LearnerSession) {
  const match = session.env.getMatch()
  return {
    board: match.board.map((row) => [...row]),
    elapsedMs: match.elapsedMs,
    cooldowns: { ...match.cooldowns },
    think: {
      black: session.env.getThinkGate('black'),
      white: session.env.getThinkGate('white'),
    },
    observation: toNormalizedVector(
      session.env.getObservation(session.learnerSide),
    ).values,
    actionMask: session.env.getActionMask(session.learnerSide),
    phase: match.phase,
    endReason: match.endReason,
    outcome: match.outcome,
    stepCount: session.env.getStepCount(),
  }
}
