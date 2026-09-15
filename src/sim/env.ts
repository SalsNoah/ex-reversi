import {
  boardSignature,
  createIdleThinkGate,
  tickThinkGate,
  type ThinkGateState,
} from '../cpu/thinkGate.ts'
import {
  createMatch,
  getStoneCounts,
  hasLegalMove,
  stepMatch,
} from '../game/index.ts'
import { GAME_CONFIG } from '../game/config.ts'
import type {
  MatchState,
  MoveRequest,
  Outcome,
  RejectedMove,
  Stone,
} from '../game/types.ts'
import {
  actionToCoord,
  actionToMoveRequest,
  buildActionMask,
  isWaitAction,
} from './actions.ts'
import { DEFAULT_MAX_STEPS, TRAINING_SPEC_VERSION } from './constants.ts'
import { getSideObservation } from './observation.ts'
import type {
  ActionMask,
  EnvConfig,
  EnvStepResult,
  SideObservation,
  StepRequestRecord,
} from './types.ts'

function rewardFor(side: Stone, outcome: Outcome | null): number {
  if (!outcome) return 0
  if (outcome === 'draw') return 0
  if (outcome === 'black_win') return side === 'black' ? 1 : -1
  return side === 'white' ? 1 : -1
}

function canAct(match: MatchState, stone: Stone): boolean {
  return (
    match.phase === 'playing' &&
    match.cooldowns[stone] === 0 &&
    hasLegalMove(match.board, stone)
  )
}

export type TrainingEnv = {
  readonly config: EnvConfig
  readonly specVersion: string
  getMatch(): MatchState
  getObservation(side: Stone): SideObservation
  getActionMask(side: Stone): ActionMask
  getThinkGate(side: Stone): ThinkGateState
  step(blackAction: number, whiteAction: number): EnvStepResult
  isTerminated(): boolean
  isTruncated(): boolean
  getRewards(): { black: number; white: number }
  getStoneCounts(): ReturnType<typeof getStoneCounts>
  getStepCount(): number
}

/**
 * 画面なし学習／自動対戦用環境。
 * 開始状態はブラウザのカウントダウン終了直後と一致（createMatch 直後）。
 */
export function createTrainingEnv(config: EnvConfig): TrainingEnv {
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
  let match = createMatch({
    seed: config.seed,
    cooldownMs: config.cooldownMs,
  })
  let blackGate = createIdleThinkGate()
  let whiteGate = createIdleThinkGate()
  let stepCount = 0
  let truncated = false
  let rewardEmitted = false
  let lastRewards = { black: 0, white: 0 }

  function thinkDelay(side: Stone): number {
    return side === 'black'
      ? config.blackThinkDelayMs
      : config.whiteThinkDelayMs
  }

  function gateOf(side: Stone): ThinkGateState {
    return side === 'black' ? blackGate : whiteGate
  }

  function snapshotObs(): {
    black: SideObservation
    white: SideObservation
  } {
    return {
      black: getSideObservation(
        match,
        'black',
        blackGate,
        config.blackThinkDelayMs,
      ),
      white: getSideObservation(
        match,
        'white',
        whiteGate,
        config.whiteThinkDelayMs,
      ),
    }
  }

  function snapshotMasks(ready: {
    black: boolean
    white: boolean
  }): { black: ActionMask; white: ActionMask } {
    return {
      black: buildActionMask(match, 'black', ready.black),
      white: buildActionMask(match, 'white', ready.white),
    }
  }

  function emitTerminalRewards(): { black: number; white: number } {
    if (rewardEmitted || match.phase !== 'finished') {
      return { black: 0, white: 0 }
    }
    rewardEmitted = true
    lastRewards = {
      black: rewardFor('black', match.outcome),
      white: rewardFor('white', match.outcome),
    }
    return lastRewards
  }

  function classifyConflict(
    bothRequested: boolean,
    rejected: RejectedMove[],
  ): { conflict: boolean; side?: Stone } {
    if (!bothRequested) return { conflict: false }
    // 同時着手で後手が illegal / occupied / skipped_after_end になったもの
    for (const r of rejected) {
      if (
        r.reason === 'illegal' ||
        r.reason === 'occupied' ||
        r.reason === 'skipped_after_end'
      ) {
        return { conflict: true, side: r.player }
      }
    }
    return { conflict: false }
  }

  const env: TrainingEnv = {
    config,
    specVersion: TRAINING_SPEC_VERSION,

    getMatch() {
      return match
    },

    getObservation(side) {
      return getSideObservation(match, side, gateOf(side), thinkDelay(side))
    },

    getActionMask(side) {
      return buildActionMask(match, side, peekReady(side))
    },

    getThinkGate(side) {
      return { ...gateOf(side) }
    },

    step(blackAction, whiteAction) {
      if (match.phase === 'finished' || truncated) {
        return {
          observations: snapshotObs(),
          masks: snapshotMasks({ black: false, white: false }),
          rewards: { black: 0, white: 0 },
          terminated: match.phase === 'finished',
          truncated,
          endReason: match.endReason,
          outcome: match.outcome,
          appliedCount: { black: 0, white: 0 },
          rejected: [],
          requestRecords: [],
        }
      }

      const signature = boardSignature(match.board)

      const blackTick = tickThinkGate(blackGate, {
        canAct: canAct(match, 'black'),
        signature,
        delayMs: config.blackThinkDelayMs,
        stepMs: GAME_CONFIG.stepMs,
      })
      const whiteTick = tickThinkGate(whiteGate, {
        canAct: canAct(match, 'white'),
        signature,
        delayMs: config.whiteThinkDelayMs,
        stepMs: GAME_CONFIG.stepMs,
      })
      blackGate = blackTick.gate
      whiteGate = whiteTick.gate

      // マスク外の着手も既存ルールへ渡し、不正なら盤面・CDを変えない
      const blackReq = isWaitAction(blackAction)
        ? undefined
        : actionToMoveRequest(blackAction)
      const whiteReq = isWaitAction(whiteAction)
        ? undefined
        : actionToMoveRequest(whiteAction)

      const bothRequested = Boolean(blackReq) && Boolean(whiteReq)
      const elapsedBefore = match.elapsedMs
      const priorityBefore = match.simultaneousPriority

      const result = stepMatch(match, {
        black: blackReq,
        white: whiteReq,
      })
      match = result.state
      stepCount += 1

      if (stepCount >= maxSteps && match.phase !== 'finished') {
        truncated = true
      }

      const conflictInfo = classifyConflict(bothRequested, result.rejected)
      const appliedSides = new Set(result.applied.map((a) => a.player))

      const records: StepRequestRecord[] = []
      for (const side of ['black', 'white'] as const) {
        const action = side === 'black' ? blackAction : whiteAction
        const req: MoveRequest | undefined =
          side === 'black' ? blackReq : whiteReq
        if (!req && isWaitAction(action)) {
          records.push({
            elapsedMsBefore: elapsedBefore,
            side,
            action,
            row: null,
            col: null,
            applied: false,
            rejectReason: null,
            simultaneousConflict: false,
          })
          continue
        }
        if (!req) {
          const coord = actionToCoord(action)
          records.push({
            elapsedMsBefore: elapsedBefore,
            side,
            action,
            row: coord?.row ?? null,
            col: coord?.col ?? null,
            applied: false,
            rejectReason: 'illegal',
            simultaneousConflict: false,
          })
          continue
        }
        const rejected = result.rejected.find((r) => r.player === side)
        const applied = appliedSides.has(side)
        const isConflict =
          conflictInfo.conflict &&
          conflictInfo.side === side &&
          Boolean(rejected)
        records.push({
          elapsedMsBefore: elapsedBefore,
          side,
          action,
          row: req.row,
          col: req.col,
          applied,
          rejectReason: rejected?.reason ?? null,
          simultaneousConflict: isConflict,
        })
      }

      // 同時着手で後手が不成立のとき、優先交代は stepMatch 側で処理済み。
      // conflict 判定の補助に priorityBefore を使う必要は記録のみ。
      void priorityBefore

      const rewards =
        match.phase === 'finished'
          ? emitTerminalRewards()
          : { black: 0, white: 0 }

      // 次ステップ用マスク（tick 前状態 = 現ゲート）
      const masks = {
        black: buildActionMask(
          match,
          'black',
          peekReadyAfterState('black'),
        ),
        white: buildActionMask(
          match,
          'white',
          peekReadyAfterState('white'),
        ),
      }

      return {
        observations: snapshotObs(),
        masks,
        rewards,
        terminated: match.phase === 'finished',
        truncated,
        endReason: match.endReason,
        outcome: match.outcome,
        appliedCount: {
          black: result.applied.filter((a) => a.player === 'black').length,
          white: result.applied.filter((a) => a.player === 'white').length,
        },
        rejected: result.rejected,
        requestRecords: records,
      }
    },

    isTerminated() {
      return match.phase === 'finished'
    },

    isTruncated() {
      return truncated
    },

    getRewards() {
      if (match.phase !== 'finished') {
        return { black: 0, white: 0 }
      }
      if (!rewardEmitted) {
        return emitTerminalRewards()
      }
      return { ...lastRewards }
    },

    getStoneCounts() {
      return getStoneCounts(match)
    },

    getStepCount() {
      return stepCount
    },
  }

  /**
   * step 直前の「この tick で ready になるか」を予測。
   * getActionMask が step と独立に呼ばれるときに使う。
   */
  function peekReady(side: Stone): boolean {
    const delay = thinkDelay(side)
    const act = canAct(match, side)
    if (!act) return false
    if (delay <= 0) return true
    const preview = tickThinkGate(gateOf(side), {
      canAct: act,
      signature: boardSignature(match.board),
      delayMs: delay,
      stepMs: GAME_CONFIG.stepMs,
    })
    return preview.ready
  }

  /** step 後・次の step の tick 前に置けるか（delay0 以外は通常 false） */
  function peekReadyAfterState(side: Stone): boolean {
    return peekReady(side)
  }

  return env
}

export function createEnvFromPartial(
  partial: Partial<EnvConfig> & Pick<EnvConfig, 'seed'>,
): TrainingEnv {
  return createTrainingEnv({
    seed: partial.seed,
    cooldownMs: partial.cooldownMs ?? GAME_CONFIG.cooldownMs,
    blackThinkDelayMs:
      partial.blackThinkDelayMs ?? GAME_CONFIG.cpuThinkDelayMs,
    whiteThinkDelayMs:
      partial.whiteThinkDelayMs ?? GAME_CONFIG.cpuThinkDelayMs,
    maxSteps: partial.maxSteps,
  })
}
