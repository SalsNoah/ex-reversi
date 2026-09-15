import { getCpuAgent } from '../cpu/index.ts'
import { createRng, toPublicMatchState } from '../game/index.ts'
import { WAIT_ACTION } from './constants.ts'
import { coordToAction } from './actions.ts'
import { createTrainingEnv } from './env.ts'
import type { CpuMatchConfig, CpuMatchResult, StepRequestRecord } from './types.ts'

/**
 * CPU 同士の1試合。双方の行動は同一盤面（未確定入力なし）から生成し、
 * 黒→白の順で乱数を消費してから step する。
 */
export function runCpuMatch(config: CpuMatchConfig): CpuMatchResult {
  const wallStart = performance.now()
  const env = createTrainingEnv(config)
  const rng = createRng(config.seed)
  const blackAgent = getCpuAgent(config.agents.black)
  const whiteAgent = getCpuAgent(config.agents.white)

  let successfulMoves = { black: 0, white: 0 }
  let simultaneousConflicts = 0
  let otherIllegalRequests = 0
  const allRecords: StepRequestRecord[] = []

  while (!env.isTerminated() && !env.isTruncated()) {
    // マスクは次 tick 込み。decide も同じ ready 条件で。
    const blackMask = env.getActionMask('black')
    const whiteMask = env.getActionMask('white')

    let blackAction = WAIT_ACTION
    let whiteAction = WAIT_ACTION

    // 双方とも同一の公開状態（相手の未確定入力なし）から判断する
    const publicForDecide = toPublicMatchState(env.getMatch())

    if (blackMask.some((v, i) => v && i !== WAIT_ACTION)) {
      const decision = blackAgent.decide(publicForDecide, rng, 'black')
      if (decision.type === 'move') {
        blackAction = coordToAction(decision.row, decision.col)
      }
    }

    if (whiteMask.some((v, i) => v && i !== WAIT_ACTION)) {
      const decision = whiteAgent.decide(publicForDecide, rng, 'white')
      if (decision.type === 'move') {
        whiteAction = coordToAction(decision.row, decision.col)
      }
    }

    const step = env.step(blackAction, whiteAction)
    successfulMoves = {
      black: successfulMoves.black + step.appliedCount.black,
      white: successfulMoves.white + step.appliedCount.white,
    }

    for (const rec of step.requestRecords) {
      if (config.recordRequests) allRecords.push(rec)
      if (rec.simultaneousConflict) simultaneousConflicts += 1
      else if (
        !rec.applied &&
        rec.rejectReason !== null &&
        rec.action !== WAIT_ACTION
      ) {
        otherIllegalRequests += 1
      }
    }
  }

  const wallMs = performance.now() - wallStart
  const counts = env.getStoneCounts()
  const finalMatch = env.getMatch()

  return {
    config,
    seed: config.seed,
    outcome: finalMatch.outcome,
    endReason: finalMatch.endReason,
    truncated: env.isTruncated(),
    stoneCounts: counts,
    successfulMoves,
    elapsedMs: finalMatch.elapsedMs,
    stepCount: env.getStepCount(),
    simultaneousConflicts,
    otherIllegalRequests,
    wallMs,
    requestRecords: config.recordRequests ? allRecords : null,
  }
}
