/**
 * アン — 時間イベント型 MCTS をブラウザの CPU として動かす。
 *
 * 通常のオセロAIと違い、手番ではなく「次に発生する意思決定イベント」を探索する。
 * ノードは盤面と時間状態（双方のクールタイム・残り試合時間・同時着手の優先側）を持ち、
 * 相手が先に動けるのか自分が続けて動けるのかを区別して評価する。
 *
 * 学習モデル（Policy / Value Network）はまだ静的評価 MCTS を上回っていないため、
 * ここでは実測で強さが確かめられている静的評価版を載せる。詳細は `docs/ai-experiments.md`。
 */
import { GAME_CONFIG } from '../../game/config.ts'
import type { Rng } from '../../game/rng.ts'
import { createRng } from '../../game/rng.ts'
import type { PublicMatchState, Stone } from '../../game/types.ts'
import { heuristicPolicy, heuristicValue } from '../../ai/mcts/heuristics.ts'
import { Mcts } from '../../ai/mcts/mcts.ts'
import {
  OUT_CAN_ACT,
  PHASE_PLAYING,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_COOLDOWN,
  TS_IDLE_REM,
  TS_LAST_CHANGE,
  TS_PHASE,
  TS_PRIORITY,
  TS_THINK_REM,
  TS_THINK_VER,
  TS_TIME,
  TS_VERSION,
  advanceToDecision,
  createFastMatch,
  type FastMatch,
} from '../../ai/sim/fastMatch.ts'
import { loadBoard } from '../strategy/fastBoard.ts'
import { actionToCoord } from '../../sim/actions.ts'
import type { CpuAgent, CpuDecision } from '../types.ts'

/** ゲート未計測を表す値（fastMatch と同じ） */
const GATE_NULL = -1

/**
 * 探索量。既存の最強 CPU（戦略AI）に 60 局で得点率 65.0%（p=0.025）を出した値。
 * 1024 では 45.0% で互角どまり、4096 は 1 手 140ms 超で画面が止まるため 2048 を選んだ。
 * 探索は盤面が変わったときの 1 回だけなので、判断待ち（500ms）の間に済む。
 */
export const ANN_SIMULATIONS = 2048

/**
 * 待機を選んだあと、盤面が変わらなくても探索をやり直すゲーム内間隔。
 * 待機の価値は相手のクールタイムが減るほど変わるので、放置はしない。
 */
const RESEARCH_INTERVAL_MS = 300

/**
 * 公開状態を高速シミュレータの局面へ写す。
 *
 * 自分の判断待ちは「今まさに満了した」状態で渡す。
 * そうしないと探索が 500ms 先の局面から始まってしまう。
 * 一方で盤面が変われば 500ms 待たされるので、`thinkDelayMs` 自体は残す。
 */
export function loadPublicState(
  match: FastMatch,
  state: PublicMatchState,
  side: number,
): void {
  loadBoard(match.pos, state.board)
  const ts = match.ts
  ts.fill(0)
  ts[TS_TIME] = state.elapsedMs
  ts[TS_COOLDOWN + SIDE_BLACK] = Math.max(0, state.cooldowns.black)
  ts[TS_COOLDOWN + SIDE_WHITE] = Math.max(0, state.cooldowns.white)
  ts[TS_VERSION] = 1
  // 残り stepMs にしておくと、最初の 1 ステップでゲートが開く
  ts[TS_THINK_REM + side] = match.config.stepMs
  ts[TS_THINK_VER + side] = ts[TS_VERSION]!
  const other = side === SIDE_BLACK ? SIDE_WHITE : SIDE_BLACK
  ts[TS_THINK_REM + other] = GATE_NULL
  ts[TS_THINK_VER + other] = GATE_NULL
  // 無操作タイマーは公開されないので未計測扱い
  ts[TS_IDLE_REM + SIDE_BLACK] = GATE_NULL
  ts[TS_IDLE_REM + SIDE_WHITE] = GATE_NULL
  ts[TS_LAST_CHANGE] = state.elapsedMs
  ts[TS_PRIORITY] = state.simultaneousPriority === 'black' ? SIDE_BLACK : SIDE_WHITE
  ts[TS_PHASE] = PHASE_PLAYING
  match.out.fill(0)
}

type Cached = {
  hashA: number
  hashB: number
  stone: Stone
  atMs: number
  decision: CpuDecision
}

export type AnnOptions = {
  simulations?: number
  /**
   * 相手の判断待ち。人間が相手なら 0（ゲージが回復した瞬間に打てる）。
   * CPU 同士で測るときは相手も 500ms を持つので、その値を入れる。
   */
  opponentThinkDelayMs?: number
}

export function createAnnCpu(options: AnnOptions | number = {}): CpuAgent {
  const opts = typeof options === 'number' ? { simulations: options } : options
  const simulations = opts.simulations ?? ANN_SIMULATIONS
  const opponentThinkDelayMs = opts.opponentThinkDelayMs ?? 0
  // 探索木の配列は数 MB あるので 1 度だけ確保して使い回す
  const match = createFastMatch({ seed: 1 })
  const mcts = new Mcts({
    config: { simulations, allowWait: true },
    policy: heuristicPolicy,
    value: heuristicValue,
  })
  let cache: Cached | null = null

  /**
   * 探索して結果を覚える。
   * session は 50ms ごとに decide / ponder を呼ぶので、盤面が同じなら覚えた手を返す。
   */
  function think(state: PublicMatchState, stone: Stone): CpuDecision {
    const side = stone === 'black' ? SIDE_BLACK : SIDE_WHITE
    // 自分は 500ms の判断待ちを負う。相手が人間ならその待ちはない
    match.config.thinkDelayMs[side] = GAME_CONFIG.cpuThinkDelayMs
    match.config.thinkDelayMs[side === SIDE_BLACK ? SIDE_WHITE : SIDE_BLACK] =
      opponentThinkDelayMs
    loadPublicState(match, state, side)
    const { hashA, hashB } = match.pos

    if (
      cache &&
      cache.hashA === hashA &&
      cache.hashB === hashB &&
      cache.stone === stone &&
      // 待機を選んだときだけ時間経過で作り直す（着手は盤面が変わるまで有効）
      (cache.decision.type === 'move' || state.elapsedMs - cache.atMs < RESEARCH_INTERVAL_MS)
    ) {
      return cache.decision
    }

    advanceToDecision(match)
    // 先に相手だけが動ける時点だと自分の手が出ない。その待機は覚えずに捨てる
    // （覚えると、実際に打てる場面で待機を返してしまう）
    if (match.ts[TS_PHASE] !== PHASE_PLAYING || match.out[OUT_CAN_ACT + side] !== 1) {
      return { type: 'wait' }
    }

    // 同じ局面なら同じ手になるよう、乱数は盤面から決める（下読みの回数に依存させない）
    const coord = actionToCoord(mcts.search(match, side, createRng(hashA ^ (side + 1))))
    const decision: CpuDecision = coord
      ? { type: 'move', row: coord.row, col: coord.col }
      : { type: 'wait' }
    cache = { hashA, hashB, stone, atMs: state.elapsedMs, decision }
    return decision
  }

  return {
    id: 'ann',
    label: 'アン（時間読みAI）',
    decide(state: PublicMatchState, _rng: Rng, stone: Stone): CpuDecision {
      return think(state, stone)
    },
    // 判断待ちの間に探索を済ませておく。decide のときは覚えた手をすぐ返せる
    ponder(state: PublicMatchState, stone: Stone): void {
      think(state, stone)
    },
  }
}

export const annCpu = createAnnCpu()
