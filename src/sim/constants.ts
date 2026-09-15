/** 学習環境・自動対戦の仕様バージョン（docs/training-environment.md と同期） */
export const TRAINING_SPEC_VERSION = '1.0.0'

/** 行動空間サイズ: マス 0〜99 + WAIT(100) */
export const ACTION_SPACE_SIZE = 101
export const WAIT_ACTION = 100

/** 異常ループ防止の安全上限（ゲーム内ステップ数）。正規終了とは別扱い */
export const DEFAULT_MAX_STEPS = 10_000
