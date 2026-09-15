import { GAME_CONFIG } from '../game/config.ts'
import { oppositeStone } from '../game/rng.ts'
import type { MatchState, Stone } from '../game/types.ts'
import type { ThinkGateState } from '../cpu/thinkGate.ts'
import { TRAINING_SPEC_VERSION } from './constants.ts'
import type {
  NormalizedObservationVector,
  SideObservation,
} from './types.ts'

/**
 * 指定側から見た観測。
 * simultaneousPriority・乱数内部・相手の未確定入力・相手の判断待ちは含めない。
 */
export function getSideObservation(
  match: MatchState,
  side: Stone,
  thinkGate: ThinkGateState,
  thinkDelayMs: number,
): SideObservation {
  const opponent = oppositeStone(side)
  const board: number[] = []
  for (let row = 0; row < GAME_CONFIG.boardSize; row += 1) {
    for (let col = 0; col < GAME_CONFIG.boardSize; col += 1) {
      const cell = match.board[row]![col]!
      if (cell === side) board.push(1)
      else if (cell === opponent) board.push(-1)
      else board.push(0)
    }
  }

  return {
    specVersion: TRAINING_SPEC_VERSION,
    side,
    board,
    myCooldownMs: match.cooldowns[side],
    opponentCooldownMs: match.cooldowns[opponent],
    remainingMatchMs: Math.max(
      0,
      GAME_CONFIG.matchDurationMs - match.elapsedMs,
    ),
    myThinkRemainingMs: thinkGate.remainingMs,
    phase: match.phase,
    cooldownMs: match.cooldownMs,
    thinkDelayMs,
  }
}

/**
 * 学習用の平坦ベクトル。
 * 順: board[100], myCooldown/cooldownMs, oppCooldown/cooldownMs,
 * remainingMatch/matchDuration, thinkRemaining/max(thinkDelay,1)（非待ちは 0）
 * いずれもおおよそ [-1,1] または [0,1]。
 */
export function toNormalizedVector(
  obs: SideObservation,
): NormalizedObservationVector {
  const cd = Math.max(1, obs.cooldownMs)
  const thinkDen = Math.max(1, obs.thinkDelayMs)
  const thinkN =
    obs.myThinkRemainingMs === null
      ? 0
      : obs.myThinkRemainingMs / thinkDen

  return {
    values: [
      ...obs.board,
      obs.myCooldownMs / cd,
      obs.opponentCooldownMs / cd,
      obs.remainingMatchMs / GAME_CONFIG.matchDurationMs,
      thinkN,
    ],
  }
}

/** 観測に非公開キーが含まれないことの検査用 */
export const FORBIDDEN_OBSERVATION_KEYS = [
  'simultaneousPriority',
  'seed',
  'rng',
  'pending',
  'opponentThink',
  'opponentAction',
] as const
