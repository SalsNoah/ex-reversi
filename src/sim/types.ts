import type { CpuTypeId } from '../cpu/types.ts'
import type {
  EndReason,
  Outcome,
  RejectedMove,
  Stone,
} from '../game/types.ts'

export type Side = Stone

/** 学習用観測（自分／相手視点。JSON 化可能） */
export type SideObservation = {
  /** 仕様バージョン */
  specVersion: string
  /** 担当側 */
  side: Side
  /**
   * 盤面 100 要素・行優先 index=row*10+col。
   * 1=自分の石、-1=相手の石、0=空き。正規化済み（追加変換不要）。
   */
  board: number[]
  /** 自分の残りクールタイム（ミリ秒、0〜cooldownMs） */
  myCooldownMs: number
  /** 相手の残りクールタイム（ミリ秒） */
  opponentCooldownMs: number
  /** 残り試合時間（ミリ秒） */
  remainingMatchMs: number
  /**
   * 自分の判断待ち残り（ミリ秒）。
   * 判断待ち中でなければ null。
   */
  myThinkRemainingMs: number | null
  /** 試合フェーズ */
  phase: 'playing' | 'paused' | 'finished'
  /** この試合のクールタイム設定（ミリ秒） */
  cooldownMs: number
  /** この側に適用する判断待ち設定（ミリ秒） */
  thinkDelayMs: number
}

/** 正規化ベクトル（学習入力用の平坦化）。docs 参照 */
export type NormalizedObservationVector = {
  /** 長さ 104: board[100] + myCdN + oppCdN + remainN + thinkN */
  values: number[]
}

export type ActionMask = boolean[]

export type EnvConfig = {
  seed: number
  cooldownMs: number
  /** 黒の判断待ち（ミリ秒） */
  blackThinkDelayMs: number
  /** 白の判断待ち（ミリ秒） */
  whiteThinkDelayMs: number
  /** 安全上限ステップ。省略時 DEFAULT_MAX_STEPS */
  maxSteps?: number
}

export type StepRequestRecord = {
  elapsedMsBefore: number
  side: Side
  action: number
  row: number | null
  col: number | null
  applied: boolean
  rejectReason: RejectedMove['reason'] | null
  /** 同時着手の後手側が盤面変化で不成立になったか */
  simultaneousConflict: boolean
}

export type EnvStepResult = {
  observations: { black: SideObservation; white: SideObservation }
  masks: { black: ActionMask; white: ActionMask }
  rewards: { black: number; white: number }
  /** ゲーム本来の終了 */
  terminated: boolean
  /** 安全上限などルール外の中断 */
  truncated: boolean
  endReason: EndReason | null
  outcome: Outcome | null
  appliedCount: { black: number; white: number }
  rejected: RejectedMove[]
  requestRecords: StepRequestRecord[]
}

export type MatchAgents = {
  black: CpuTypeId
  white: CpuTypeId
}

export type CpuMatchConfig = EnvConfig & {
  agents: MatchAgents
  /** 要求列を記録するか */
  recordRequests?: boolean
}

export type CpuMatchResult = {
  config: CpuMatchConfig
  seed: number
  outcome: Outcome | null
  endReason: EndReason | null
  truncated: boolean
  stoneCounts: { black: number; white: number; empty: number }
  successfulMoves: { black: number; white: number }
  /** ゲーム内の対戦時間（終了時の elapsedMs） */
  elapsedMs: number
  stepCount: number
  simultaneousConflicts: number
  otherIllegalRequests: number
  /** 壁時計（ミリ秒） */
  wallMs: number
  requestRecords: StepRequestRecord[] | null
}
