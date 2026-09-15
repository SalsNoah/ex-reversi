/** 試作用の仮設定（docs/game-spec.md 2章）。散在させずここだけを参照する。 */
export const GAME_CONFIG = {
  boardSize: 10,
  /** 中央4×4の開始行・列（含む） */
  centerMin: 3,
  /** 中央4×4の終了行・列（含む） */
  centerMax: 6,
  stepMs: 50,
  /** 着手後待ち時間（ミリ秒）。画面からは変更しない */
  cooldownMs: 700,
  matchDurationMs: 180_000,
  /** 開始カウントダウン全体（3・2・1 を各1秒） */
  countdownMs: 3000,
  /** CPU が着手可能になってからの判断待ち（ゲーム内時間） */
  cpuThinkDelayMs: 500,
  /** 着手可能なのに置かないときの自動着手。プレイヤーとCPUで同じ値を、別タイマーで測る */
  idleAutoMoveMs: 3000,
  playerStone: 'black' as const,
  cpuStone: 'white' as const,
  /** 画面対戦のライフ上限。日付が変わるとこの数まで戻る */
  livesMax: 5,
} as const

export type GameConfig = typeof GAME_CONFIG
