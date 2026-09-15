import type { Rng } from '../game/rng.ts'
import type { PublicMatchState, Stone } from '../game/types.ts'
import type { CpuAgent, CpuDecision } from './types.ts'

/** 常に待機する。無操作タイマーのテスト用。画面の選択肢には出さない。 */
export const waitCpu: CpuAgent = {
  id: 'wait',
  label: '待機型',
  decide(
    _publicState: PublicMatchState,
    _rng: Rng,
    _stone: Stone,
  ): CpuDecision {
    return { type: 'wait' }
  },
}
