export type Stone = 'black' | 'white'

export type Cell = Stone | null

/** board[row][col] */
export type Board = Cell[][]

export type Coord = {
  row: number
  col: number
}

export type MatchPhase = 'playing' | 'paused' | 'finished'

export type EndReason = 'board_full' | 'no_legal_moves' | 'time_up'

export type Outcome = 'black_win' | 'white_win' | 'draw'

export type StoneCounts = {
  black: number
  white: number
  empty: number
}

export type Cooldowns = {
  black: number
  white: number
}

export type MoveRequest = {
  row: number
  col: number
}

export type StepInput = {
  black?: MoveRequest
  white?: MoveRequest
}

export type AppliedMove = {
  player: Stone
  row: number
  col: number
  flipped: Coord[]
}

export type RejectedMove = {
  player: Stone
  row: number
  col: number
  reason:
    | 'cooldown'
    | 'illegal'
    | 'out_of_bounds'
    | 'occupied'
    | 'finished'
    | 'paused'
    | 'skipped_after_end'
}

export type MatchState = {
  board: Board
  /** 試合開始からの経過ミリ秒（ゲーム内時間） */
  elapsedMs: number
  cooldowns: Cooldowns
  /** この試合の着手後待ち時間 */
  cooldownMs: number
  /** 次の同時着手で先に処理する側 */
  simultaneousPriority: Stone
  phase: MatchPhase
  endReason: EndReason | null
  outcome: Outcome | null
  seed: number
}

/** CPU に渡してよい公開情報 */
export type PublicMatchState = {
  board: Board
  cooldowns: Cooldowns
  elapsedMs: number
  remainingMatchMs: number
  phase: MatchPhase
  simultaneousPriority: Stone
  endReason: EndReason | null
  outcome: Outcome | null
}

export type StepResult = {
  state: MatchState
  applied: AppliedMove[]
  rejected: RejectedMove[]
}
