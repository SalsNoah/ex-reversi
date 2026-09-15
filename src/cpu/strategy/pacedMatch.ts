/**
 * 相手の速さを変えて 1 試合を回すハーネス（画面なし）。
 *
 * 50ms ステップを 1 つずつ進めるので、画面と同じ条件になる。
 * `ga/matchRunner` は判断点まで時間を飛ばすので下読みを呼べないが、こちらは呼べる。
 * 無操作 3 秒の自動着手（仕様 2.3.2）も入れてあるので、遅い相手も正しく再現する。
 */
import { GAME_CONFIG } from '../../game/config.ts'
import {
  createMatch,
  createRng,
  hasLegalMove,
  pickRandomLegalMove,
  stepMatch,
  toPublicMatchState,
} from '../../game/index.ts'
import { deriveSeed } from '../../ga/rng.ts'
import {
  boardSignature,
  createIdleThinkGate,
  tickThinkGate,
} from '../thinkGate.ts'
import type { CpuAgent } from '../types.ts'

/** 次に着手を求められるまでのゲーム内ミリ秒（セッションと同じ数え方） */
function untilDecisionMs(
  cooldownMs: number,
  canAct: boolean,
  gate: { remainingMs: number | null },
  delayMs: number,
): number {
  if (canAct) return gate.remainingMs ?? 0
  return cooldownMs + delayMs
}

const BLACK_IDLE_SIG = 'bench-idle-black'
const WHITE_IDLE_SIG = 'bench-idle-white'

export type PacedMatchResult = {
  diffForWhite: number
  abnormal: boolean
  /** 自分で選んで置いた回数（無操作の自動着手を含まない） */
  moves: { black: number; white: number }
  /** 無操作 3 秒でランダムに置かれた回数 */
  idleMoves: { black: number; white: number }
  stones: { black: number; white: number }
  /** 試合時間 180 秒で打ち切られたか（盤が埋まる前に終わった） */
  timeUp: boolean
  emptyAtEnd: number
}

/**
 * 黒（プレイヤー側）の反応の速さを変えて 1 試合。
 *
 * blackThinkDelayMs = 0 なら待ち時間が明けた瞬間に打つ＝人が最速で操作した場合。
 * 500 なら CPU と同じ判断待ちで、GA 同士の対戦と同じ条件になる。
 * 遅い側を測るときのために、無操作 3 秒の自動着手も画面と同じように入れてある。
 *
 * 50ms ステップを 1 つずつ回すので、`ponder` を持つ CPU は
 * 手番前のステップでも読み進められる（画面と同じ条件）。
 */
export function runPacedMatch(options: {
  seed: number
  decisionSeed: number
  black: CpuAgent
  white: CpuAgent
  blackThinkDelayMs: number
  whiteThinkDelayMs?: number
}): PacedMatchResult {
  const whiteThinkDelayMs =
    options.whiteThinkDelayMs ?? GAME_CONFIG.cpuThinkDelayMs
  let state = createMatch({
    seed: options.seed,
    cooldownMs: GAME_CONFIG.cooldownMs,
  })
  const blackRng = createRng(deriveSeed(options.decisionSeed, 1))
  const whiteRng = createRng(deriveSeed(options.decisionSeed, 2))
  let blackGate = createIdleThinkGate()
  let whiteGate = createIdleThinkGate()
  let blackIdle = createIdleThinkGate()
  let whiteIdle = createIdleThinkGate()
  const moves = { black: 0, white: 0 }
  const idleMoves = { black: 0, white: 0 }
  let steps = 0
  const maxSteps =
    Math.ceil(GAME_CONFIG.matchDurationMs / GAME_CONFIG.stepMs) + 100

  while (state.phase === 'playing' && steps < maxSteps) {
    const publicState = toPublicMatchState(state)
    const signature = boardSignature(state.board)
    const blackCanAct =
      state.cooldowns.black === 0 && hasLegalMove(state.board, 'black')
    const whiteCanAct =
      state.cooldowns.white === 0 && hasLegalMove(state.board, 'white')
    const blackTick = tickThinkGate(blackGate, {
      canAct: blackCanAct,
      signature,
      delayMs: options.blackThinkDelayMs,
      stepMs: GAME_CONFIG.stepMs,
    })
    const whiteTick = tickThinkGate(whiteGate, {
      canAct: whiteCanAct,
      signature,
      delayMs: whiteThinkDelayMs,
      stepMs: GAME_CONFIG.stepMs,
    })
    blackGate = blackTick.gate
    whiteGate = whiteTick.gate

    const blackIdleTick = tickThinkGate(blackIdle, {
      canAct: blackCanAct,
      signature: BLACK_IDLE_SIG,
      delayMs: GAME_CONFIG.idleAutoMoveMs,
      stepMs: GAME_CONFIG.stepMs,
    })
    const whiteIdleTick = tickThinkGate(whiteIdle, {
      canAct: whiteCanAct,
      signature: WHITE_IDLE_SIG,
      delayMs: GAME_CONFIG.idleAutoMoveMs,
      stepMs: GAME_CONFIG.stepMs,
    })
    blackIdle = blackIdleTick.gate
    whiteIdle = whiteIdleTick.gate

    let blackMove: { row: number; col: number } | undefined
    if (blackTick.ready) {
      const decision = options.black.decide(publicState, blackRng, 'black')
      if (decision.type === 'move') {
        blackMove = { row: decision.row, col: decision.col }
        moves.black += 1
      }
    } else {
      options.black.ponder?.(
        publicState,
        'black',
        untilDecisionMs(
          state.cooldowns.black,
          blackCanAct,
          blackTick.gate,
          options.blackThinkDelayMs,
        ),
      )
    }
    let whiteMove: { row: number; col: number } | undefined
    if (whiteTick.ready) {
      const decision = options.white.decide(publicState, whiteRng, 'white')
      if (decision.type === 'move') {
        whiteMove = { row: decision.row, col: decision.col }
        moves.white += 1
      }
    } else {
      options.white.ponder?.(
        publicState,
        'white',
        untilDecisionMs(
          state.cooldowns.white,
          whiteCanAct,
          whiteTick.gate,
          whiteThinkDelayMs,
        ),
      )
    }

    // 無操作 3 秒（2.3.2）。その側の通常の着手要求があるときは自動着手しない
    if (!blackMove && blackIdleTick.ready) {
      const pick = pickRandomLegalMove(state.board, 'black', blackRng)
      if (pick) {
        blackMove = pick
        idleMoves.black += 1
      }
    }
    if (!whiteMove && whiteIdleTick.ready) {
      const pick = pickRandomLegalMove(state.board, 'white', whiteRng)
      if (pick) {
        whiteMove = pick
        idleMoves.white += 1
      }
    }

    state = stepMatch(state, { black: blackMove, white: whiteMove }).state
    steps += 1
  }

  let black = 0
  let white = 0
  let empty = 0
  for (const row of state.board) {
    for (const cell of row) {
      if (cell === 'black') black += 1
      else if (cell === 'white') white += 1
      else empty += 1
    }
  }
  return {
    diffForWhite: white - black,
    abnormal: state.phase !== 'finished',
    moves,
    idleMoves,
    stones: { black, white },
    timeUp: state.elapsedMs >= GAME_CONFIG.matchDurationMs,
    emptyAtEnd: empty,
  }
}

