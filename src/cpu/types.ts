import type { Coord, PublicMatchState, Stone } from '../game/types.ts'
import type { Rng } from '../game/rng.ts'
import type { GaMilestoneId } from './gaMilestones.ts'

/** CPU の決定。差し替え可能な最小窓口。 */
export type CpuDecision =
  | { type: 'move'; row: number; col: number }
  | { type: 'wait' }

export type CpuTypeId =
  | 'random'
  | 'max_flip'
  | 'ann'
  | 'alpha'
  | 'strategy'
  | 'ga_best'
  | 'wait'
  | GaMilestoneId


export type CpuAgent = {
  id: CpuTypeId
  /** 画面表示用（強化学習などと誤解されない名称） */
  label: string
  /**
   * 公開状態と担当石から着手または待機を返す。
   * 未確定の相手入力は publicState に含まれない前提。
   */
  decide: (
    publicState: PublicMatchState,
    rng: Rng,
    stone: Stone,
  ) => CpuDecision
  /**
   * 手番が来る前の下読み（任意）。着手は返さず、ゲームの状態も変えない。
   * `msUntilDecision` は次に decide を呼ばれるまでのゲーム内ミリ秒。
   * 実装しない CPU は、この呼び出しを持たなくてよい。
   */
  ponder?: (
    publicState: PublicMatchState,
    stone: Stone,
    msUntilDecision: number,
  ) => void
}

export type { Coord }
