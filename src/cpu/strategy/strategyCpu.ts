/**
 * 戦略CPUの窓口。公開状態だけを受け取り、着手または待機を返す。
 *
 * 待機は選ばない。仕様 2.3.2 の無操作 3 秒でランダム着手にされるため、
 * 自発的に待つ利得より、必ず自分で選んだ手を置く方が安定して強い。
 */
import { GAME_CONFIG } from '../../game/config.ts'
import type { Rng } from '../../game/rng.ts'
import type { PublicMatchState, Stone } from '../../game/types.ts'
import type { CpuAgent, CpuDecision, CpuTypeId } from '../types.ts'
import {
  colorOf,
  createFastPosition,
  loadBoard,
  type FastPosition,
} from './fastBoard.ts'
import {
  DEFAULT_WEIGHTS,
  applyWeights,
  type WeightTables,
} from './evaluate.ts'
import {
  createPaceTracker,
  currentPace,
  notePlayedMove,
  observePace,
  type PaceEstimate,
} from './pace.ts'
import {
  createPonderSession,
  moveToCoord,
  resetPonderSession,
  searchBestMove,
  stepPonder,
  type PonderSession,
  type SearchSchedule,
} from './search.ts'

export type StrategyLevel = {
  /** 反復深化の上限 */
  maxDepth: number
  /** 1 手あたりの展開ノード上限。実時計を使わないので再現する */
  nodeBudget: number
  /** 手番前の 1 ステップで読むノード数。0 なら下読みしない */
  ponderStepNodes: number
  /** 相手の着手間隔の初期想定（ミリ秒）。自分と同じなら通常の交互読み */
  opponentIntervalMs: number
  /** 手番復帰から着手までの相手の想定反応（ミリ秒） */
  opponentReactionMs: number
  /** 相手の着手間隔を対局中の観測で更新する。false なら上の想定を固定で使う */
  adaptPace: boolean
  /** 評価の重み。調整や各項の効き方を測るときだけ差し替える */
  weights: WeightTables
  /**
   * 相手の着手ペースの推定から重みを選ぶ。省略すると `weights` を常に使う。
   *
   * 相手が自分より速いと、相手は「打つ手がなくて損な手を打たされる」状況に陥らない。
   * 着手可能数を削って相手を追い込む読みはこの仕組みに乗っているので、
   * 速い相手には効かない（docs/strategy-ai.md）。速さに応じて評価を変えるための窓口。
   *
   * `measured` が false の間は観測前（試合の最初の 2 手）。試合の切れ目はここで分かる。
   */
  weightsForPace?: (pace: PaceEstimate) => WeightTables
}

/**
 * 画面に載せる最強設定。
 *
 * 読む量は「ブラウザの 1 ステップを止めすぎない」ことから決めている。
 * 探索はセッションの 50ms ステップ内で同期実行されるため、
 * 1 回を大きくすると入力の取りこぼしではなく入力遅延として体感に出る。
 * そこで手番が来るまでのステップにも少しずつ配り（`ponderStepNodes`）、
 * 着手のステップだけを重くしないようにしている。
 *
 * 相手の着手間隔は対局中に測る（`pace.ts`）。決め打ちにすると、
 * 速い相手を遅いと見れば連打で潰され、遅い相手を速いと見れば守りすぎる。
 * どちらの取り違えも実測で負け越しが出た（docs/strategy-ai.md）。
 * 初期値は自分と同じ 1200ms で、相手の着手を 2 手ぶん見た時点で実測に切り替わる。
 */
export const MASTER_LEVEL: StrategyLevel = {
  maxDepth: 64,
  nodeBudget: 14_000,
  ponderStepNodes: 3_000,
  opponentIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
  opponentReactionMs: GAME_CONFIG.cpuThinkDelayMs,
  adaptPace: true,
  weights: DEFAULT_WEIGHTS,
}

let sharedPosition: FastPosition | null = null

function position(): FastPosition {
  if (!sharedPosition) sharedPosition = createFastPosition()
  return sharedPosition
}

export type StrategyDecisionInfo = {
  decision: CpuDecision
  score: number
  depth: number
  nodes: number
  aborted: boolean
}

/**
 * `msAhead` ミリ秒あとに着手するつもりで日程を組む。
 *
 * 着手時は 0。手番前の下読みでは「着手を求められるまでの残り」を渡す。
 * こうすると下読みと着手で同じ日程になり、読んだ結果をそのまま使える。
 */
function scheduleAt(
  publicState: PublicMatchState,
  stone: Stone,
  opponentIntervalMs: number,
  opponentReactionMs: number,
  msAhead: number,
): SearchSchedule {
  const opponentStone: Stone = stone === 'black' ? 'white' : 'black'
  const oppCooldown = Math.max(
    0,
    publicState.cooldowns[opponentStone] - msAhead,
  )
  return {
    selfNextMs: 0,
    oppNextMs: oppCooldown + opponentReactionMs,
    selfIntervalMs: GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs,
    oppIntervalMs: opponentIntervalMs,
    selfReactionMs: GAME_CONFIG.cpuThinkDelayMs,
    oppReactionMs: opponentReactionMs,
    matchRemainingMs: Math.max(0, publicState.remainingMatchMs - msAhead),
  }
}

export function decideStrategyMove(
  publicState: PublicMatchState,
  rng: Rng,
  stone: Stone,
  level: StrategyLevel,
  session?: PonderSession,
): StrategyDecisionInfo {
  const idle: StrategyDecisionInfo = {
    decision: { type: 'wait' },
    score: 0,
    depth: 0,
    nodes: 0,
    aborted: false,
  }
  if (publicState.phase !== 'playing') return idle
  if (publicState.cooldowns[stone] > 0) return idle

  const pos = position()
  loadBoard(pos, publicState.board)
  applyWeights(level.weights)

  const result = searchBestMove(
    pos,
    colorOf(stone),
    scheduleAt(
      publicState,
      stone,
      level.opponentIntervalMs,
      level.opponentReactionMs,
      0,
    ),
    { maxDepth: level.maxDepth, nodeBudget: level.nodeBudget },
    session,
  )

  if (result.bestMoves.length === 0) return idle

  const picked =
    result.bestMoves.length === 1
      ? result.bestMoves[0]
      : result.bestMoves[rng.nextInt(0, result.bestMoves.length)]
  const coord = moveToCoord(picked)

  return {
    decision: { type: 'move', row: coord.row, col: coord.col },
    score: result.score,
    depth: result.depth,
    nodes: result.nodes,
    aborted: result.aborted,
  }
}

/**
 * 手番が来る前に 1 ステップ分だけ読み進める。着手は返さない。
 *
 * `msUntilDecision` は次に着手を求められるまでのゲーム内ミリ秒。
 * そのときの日程で読むので、盤面が変わらなければ続きをそのまま使える。
 */
export function ponderStrategyMove(
  publicState: PublicMatchState,
  stone: Stone,
  level: StrategyLevel,
  msUntilDecision: number,
  session: PonderSession,
): void {
  if (level.ponderStepNodes <= 0) return
  if (publicState.phase !== 'playing') return

  const pos = position()
  loadBoard(pos, publicState.board)
  applyWeights(level.weights)

  stepPonder(
    pos,
    colorOf(stone),
    scheduleAt(
      publicState,
      stone,
      level.opponentIntervalMs,
      level.opponentReactionMs,
      msUntilDecision,
    ),
    { maxDepth: level.maxDepth, stepNodeBudget: level.ponderStepNodes },
    session,
  )
}

export function createStrategyCpu(options: {
  id: CpuTypeId
  label: string
  level?: Partial<StrategyLevel>
}): CpuAgent {
  const level: StrategyLevel = { ...MASTER_LEVEL, ...options.level }
  const tracker = createPaceTracker()
  const session = createPonderSession()

  const levelWith = (pace: PaceEstimate): StrategyLevel => {
    const weights = level.weightsForPace?.(pace) ?? level.weights
    if (!level.adaptPace) {
      return weights === level.weights ? level : { ...level, weights }
    }
    return {
      ...level,
      opponentIntervalMs: pace.intervalMs,
      opponentReactionMs: pace.reactionMs,
      weights,
    }
  }

  return {
    id: options.id,
    label: options.label,
    decide(publicState, rng, stone): CpuDecision {
      if (publicState.phase !== 'playing') return { type: 'wait' }

      // 下読みと同じ推定で読む。ここで推定を更新してしまうと、
      // 手番前に読んだ分と手番モデルが食い違い、持ち越しが使えない。
      // 減衰平均なので 1 観測ぶん古くても値はほとんど変わらない。
      const pace = currentPace(
        tracker,
        level.opponentIntervalMs,
        level.opponentReactionMs,
      )
      const decision = decideStrategyMove(
        publicState,
        rng,
        stone,
        levelWith(pace),
        session,
      ).decision
      // 着手したら盤面が変わる。持ち越しは次の局面には使えない
      resetPonderSession(session)

      if (level.adaptPace) {
        observePace(
          tracker,
          publicState.board,
          publicState.elapsedMs,
          level.opponentIntervalMs,
          level.opponentReactionMs,
        )
      }
      if (decision.type === 'move') {
        notePlayedMove(tracker, decision.row, decision.col)
      }
      return decision
    },
    ponder(publicState, stone, msUntilDecision): void {
      const pace = currentPace(
        tracker,
        level.opponentIntervalMs,
        level.opponentReactionMs,
      )
      ponderStrategyMove(
        publicState,
        stone,
        levelWith(pace),
        msUntilDecision,
        session,
      )
    },
  }
}

export const strategyCpu: CpuAgent = createStrategyCpu({
  id: 'strategy',
  label: '戦略AI（最強クラス）',
})
