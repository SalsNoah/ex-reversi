/**
 * AI探索・自己対戦専用の高速試合シミュレータ。
 *
 * ルール層（src/game/match.ts）と結果を完全に一致させるが、表現を変えて速くする。
 *
 * - 盤面は探索用 FastPosition（12×12 番兵 + 空きマス双方向リスト）。毎ステップの複製をしない
 * - 判断待ちの照合は 100 文字の盤面署名ではなく「盤面世代カウンタ」。
 *   石は減らないので、盤面が変わる ⇔ 世代が進む。署名比較と等価で O(1)
 * - 誰も動けない区間は 1 ステップずつ回さず、次の意思決定イベント時刻まで解析的に飛ぶ
 *
 * 一致は src/ai/sim/fastMatch.test.ts で runGaMatch と着手列・終局・時刻を突き合わせて確認する。
 *
 * UI・アニメーション・実時計・ファイルI/Oには依存しない。
 */
import {
  BLACK,
  CELL_COUNT,
  DIRS,
  EMPTY,
  PLAYABLE,
  WHITE,
  cellIndex,
  createFastPosition,
  doMove,
  generateMoves,
  hasMoves,
  loadBoard,
  undoMove,
  type FastPosition,
} from '../../cpu/strategy/fastBoard.ts'
import { createInitialBoard } from '../../game/board.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import { createRng, initialSimultaneousPriority, type Rng } from '../../game/index.ts'
import { deriveSeed } from '../../ga/rng.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'

export const SIDE_BLACK = 0
export const SIDE_WHITE = 1

export const PHASE_PLAYING = 0
export const PHASE_FINISHED = 1

export const END_NONE = 0
export const END_BOARD_FULL = 1
export const END_NO_LEGAL_MOVES = 2
export const END_TIME_UP = 3

export const OUTCOME_BLACK_WIN = 0
export const OUTCOME_WHITE_WIN = 1
export const OUTCOME_DRAW = 2

/** 判断待ちゲートが null（未開始）であることを表す番兵 */
const GATE_NULL = -1

/** 無操作タイマーは固定シグネチャなので、盤面世代の代わりに常に一致する値を使う */
const IDLE_VER = -2

const INF = Number.MAX_SAFE_INTEGER

/** 時間状態のスロット。MCTS が 1 回の set() で退避・復元できるようまとめる */
export const TS_TIME = 0
export const TS_COOLDOWN = 1 // +side
export const TS_THINK_REM = 3 // +side
export const TS_THINK_VER = 5 // +side
export const TS_IDLE_REM = 7 // +side
export const TS_VERSION = 9
export const TS_PRIORITY = 10
export const TS_PHASE = 11
export const TS_END_REASON = 12
export const TS_MOVE_COUNT = 13
/**
 * 最後に石が置かれたステップ時刻。ルールには影響しない記録用。
 * 画面で見える情報なので、AI が相手の判断待ちを推定するのに使える。
 */
export const TS_LAST_CHANGE = 14
export const TS_SIZE = 15

/** advanceToDecision が書き出す「今このステップで何ができるか」 */
export const OUT_CAN_ACT = 0 // +side
export const OUT_THINK_READY = 2 // +side
export const OUT_IDLE_READY = 4 // +side
export const OUT_HAS_MOVES = 6 // +side
export const OUT_SIZE = 8

export type FastMatchConfig = {
  cooldownMs: number
  /** 側ごとの判断待ち。0 なら即断（画面のプレイヤー相当） */
  thinkDelayMs: [number, number]
  idleAutoMoveMs: number
  matchDurationMs: number
  stepMs: number
}

export type FastMatch = {
  pos: FastPosition
  /** 時間状態（TS_* で添字） */
  ts: Int32Array
  /** 意思決定点の情報（OUT_* で添字）。保存対象ではない */
  out: Int32Array
  config: FastMatchConfig
  seed: number
}

export const ACTION_TO_CELL = buildActionToCell()
export const CELL_TO_ACTION = buildCellToAction()

function buildActionToCell(): Int32Array {
  const table = new Int32Array(WAIT_ACTION)
  for (let action = 0; action < WAIT_ACTION; action += 1) {
    const row = (action / GAME_CONFIG.boardSize) | 0
    const col = action % GAME_CONFIG.boardSize
    table[action] = cellIndex(row, col)
  }
  return table
}

function buildCellToAction(): Int32Array {
  const table = new Int32Array(CELL_COUNT).fill(-1)
  for (let k = 0; k < PLAYABLE.length; k += 1) {
    const cell = PLAYABLE[k]
    table[cell] = k
  }
  return table
}

export function colorOfSide(side: number): number {
  return side === SIDE_BLACK ? BLACK : WHITE
}

export function defaultFastMatchConfig(): FastMatchConfig {
  return {
    cooldownMs: GAME_CONFIG.cooldownMs,
    thinkDelayMs: [GAME_CONFIG.cpuThinkDelayMs, GAME_CONFIG.cpuThinkDelayMs],
    idleAutoMoveMs: GAME_CONFIG.idleAutoMoveMs,
    matchDurationMs: GAME_CONFIG.matchDurationMs,
    stepMs: GAME_CONFIG.stepMs,
  }
}

/** 開始盤面は 1 試合に 1 回しか作らないので、ルール層の生成結果をそのまま読み込む */
const INITIAL_BOARD = createInitialBoard()

export function createFastMatch(options: {
  seed: number
  config?: Partial<FastMatchConfig>
}): FastMatch {
  const config = { ...defaultFastMatchConfig(), ...options.config }
  const match: FastMatch = {
    pos: createFastPosition(),
    ts: new Int32Array(TS_SIZE),
    out: new Int32Array(OUT_SIZE),
    config,
    seed: options.seed,
  }
  resetFastMatch(match, options.seed)
  return match
}

export function resetFastMatch(match: FastMatch, seed: number): void {
  loadBoard(match.pos, INITIAL_BOARD)
  const ts = match.ts
  ts.fill(0)
  ts[TS_THINK_REM + SIDE_BLACK] = GATE_NULL
  ts[TS_THINK_REM + SIDE_WHITE] = GATE_NULL
  ts[TS_THINK_VER + SIDE_BLACK] = GATE_NULL
  ts[TS_THINK_VER + SIDE_WHITE] = GATE_NULL
  ts[TS_IDLE_REM + SIDE_BLACK] = GATE_NULL
  ts[TS_IDLE_REM + SIDE_WHITE] = GATE_NULL
  ts[TS_PRIORITY] =
    initialSimultaneousPriority(seed) === 'black' ? SIDE_BLACK : SIDE_WHITE
  ts[TS_PHASE] = PHASE_PLAYING
  ts[TS_END_REASON] = END_NONE
  match.seed = seed
  match.out.fill(0)
}

export function isFinished(match: FastMatch): boolean {
  return match.ts[TS_PHASE] === PHASE_FINISHED
}

export function stoneDiffForSide(match: FastMatch, side: number): number {
  const { black, white } = match.pos
  return side === SIDE_BLACK ? black - white : white - black
}

export function outcomeOf(match: FastMatch): number {
  const { black, white } = match.pos
  if (black > white) return OUTCOME_BLACK_WIN
  if (white > black) return OUTCOME_WHITE_WIN
  return OUTCOME_DRAW
}

export function isLegalCell(
  pos: FastPosition,
  cell: number,
  color: number,
): boolean {
  const cells = pos.cells
  if (cells[cell] !== EMPTY) return false
  const opp = color ^ 3
  for (let d = 0; d < 8; d += 1) {
    const dir = DIRS[d]
    let j = cell + dir
    if (cells[j] !== opp) continue
    do {
      j += dir
    } while (cells[j] === opp)
    if (cells[j] === color) return true
  }
  return false
}

/** 合法手を action 値（0..99）で out に詰め、件数を返す。行優先順（ルール層と同じ） */
export function listLegalActions(
  match: FastMatch,
  side: number,
  out: Int32Array,
): number {
  const cells = scratchMoves
  const n = generateMoves(match.pos, colorOfSide(side), cells, 0)
  for (let k = 0; k < n; k += 1) {
    out[k] = CELL_TO_ACTION[cells[k]]
  }
  return n
}

const scratchMoves = new Int32Array(128)

// --- 判断待ちゲート -------------------------------------------------------

let gateRem = 0
let gateReady = false

/**
 * ルール層 tickThinkGate の 1 ステップ分。結果は gateRem / gateReady に書く。
 * canAct=false なら常に null へ戻る（＝着手不能になると測り直し）。
 */
function tickGate(
  rem: number,
  ver: number,
  canAct: boolean,
  curVer: number,
  delayMs: number,
  stepMs: number,
): void {
  if (!canAct) {
    gateRem = GATE_NULL
    gateReady = false
    return
  }
  if (delayMs <= 0) {
    gateRem = GATE_NULL
    gateReady = true
    return
  }
  let r = rem === GATE_NULL || ver !== curVer ? delayMs : rem
  r -= stepMs
  if (r > 0) {
    gateRem = r
    gateReady = false
    return
  }
  gateRem = GATE_NULL
  gateReady = true
}

/**
 * 盤面が動かない前提で、このゲートが ready になる「ステップ時刻」を返す。
 * ableAt はその側が着手可能になる時刻（既に可能なら現在時刻以下）。
 */
function gateReadyAt(
  now: number,
  ableAt: number,
  rem: number,
  ver: number,
  curVer: number,
  delayMs: number,
  stepMs: number,
): number {
  if (ableAt === INF) return INF
  if (delayMs <= 0) return ableAt > now ? ableAt : now
  const start =
    ableAt <= now ? (rem === GATE_NULL || ver !== curVer ? delayMs : rem) : delayMs
  let ticks = Math.ceil(start / stepMs)
  if (ticks < 1) ticks = 1
  return ableAt + stepMs * (ticks - 1)
}

/** target ステップに入る直前のゲート残り（ready 前）を返す */
function gateEnteringAt(
  now: number,
  ableAt: number,
  rem: number,
  ver: number,
  curVer: number,
  delayMs: number,
  stepMs: number,
  target: number,
): number {
  if (ableAt > target - stepMs) return GATE_NULL
  const start =
    ableAt <= now ? (rem === GATE_NULL || ver !== curVer ? delayMs : rem) : delayMs
  const ticks = (target - ableAt) / stepMs
  const r = start - stepMs * ticks
  return r > 0 ? r : GATE_NULL
}

// --- 終局判定 -------------------------------------------------------------

function finish(match: FastMatch, endReason: number): void {
  match.ts[TS_PHASE] = PHASE_FINISHED
  match.ts[TS_END_REASON] = endReason
}

/** ルール層 checkEndAfterBoardChange と同じ順序（盤面満杯 → 双方合法手なし） */
function checkEndAfterBoardChange(match: FastMatch): boolean {
  if (match.pos.emptyCount === 0) {
    finish(match, END_BOARD_FULL)
    return true
  }
  if (!hasMoves(match.pos, BLACK) && !hasMoves(match.pos, WHITE)) {
    finish(match, END_NO_LEGAL_MOVES)
    return true
  }
  return false
}

// --- 時間送り -------------------------------------------------------------

/** 着手なしで n ステップ進める（ルール層 advanceMatch と同じ打ち切り） */
function advanceNoMove(match: FastMatch, steps: number): void {
  const ts = match.ts
  const { stepMs, matchDurationMs } = match.config
  for (let i = 0; i < steps; i += 1) {
    ts[TS_TIME] += stepMs
    const b = ts[TS_COOLDOWN + SIDE_BLACK] - stepMs
    const w = ts[TS_COOLDOWN + SIDE_WHITE] - stepMs
    ts[TS_COOLDOWN + SIDE_BLACK] = b > 0 ? b : 0
    ts[TS_COOLDOWN + SIDE_WHITE] = w > 0 ? w : 0
    if (ts[TS_TIME] >= matchDurationMs) {
      finish(match, END_TIME_UP)
      return
    }
    if (checkEndAfterBoardChange(match)) return
  }
}

function resetAllGates(match: FastMatch): void {
  const ts = match.ts
  ts[TS_THINK_REM + SIDE_BLACK] = GATE_NULL
  ts[TS_THINK_REM + SIDE_WHITE] = GATE_NULL
  ts[TS_IDLE_REM + SIDE_BLACK] = GATE_NULL
  ts[TS_IDLE_REM + SIDE_WHITE] = GATE_NULL
}

/** 双方着手不能のときに時間だけ飛ばす（matchRunner の fastForwardBothUnable と同じ） */
function fastForwardBothUnable(match: FastMatch): void {
  const ts = match.ts
  const { stepMs, matchDurationMs } = match.config
  const b = ts[TS_COOLDOWN + SIDE_BLACK]
  const w = ts[TS_COOLDOWN + SIDE_WHITE]
  if (b <= 0 && w <= 0) {
    advanceNoMove(match, 1)
    resetAllGates(match)
    return
  }
  const remain = Math.max(0, matchDurationMs - ts[TS_TIME])
  let jump = remain
  if (b > 0 && b < jump) jump = b
  if (w > 0 && w < jump) jump = w
  jump = Math.floor(jump / stepMs) * stepMs
  if (jump < stepMs) jump = stepMs
  advanceNoMove(match, jump / stepMs)
  resetAllGates(match)
}

/**
 * 次の意思決定ステップまで進める。
 * 戻ったとき phase が playing なら out に「誰が何をできるか」が入っている。
 */
export function advanceToDecision(match: FastMatch): void {
  const ts = match.ts
  const out = match.out
  const cfg = match.config
  const stepMs = cfg.stepMs

  while (ts[TS_PHASE] === PHASE_PLAYING) {
    const hasB = hasMoves(match.pos, BLACK)
    const hasW = hasMoves(match.pos, WHITE)
    const canB = ts[TS_COOLDOWN + SIDE_BLACK] === 0 && hasB
    const canW = ts[TS_COOLDOWN + SIDE_WHITE] === 0 && hasW

    if (!canB && !canW) {
      fastForwardBothUnable(match)
      continue
    }

    const curVer = ts[TS_VERSION]

    tickGate(
      ts[TS_THINK_REM + SIDE_BLACK],
      ts[TS_THINK_VER + SIDE_BLACK],
      canB,
      curVer,
      cfg.thinkDelayMs[SIDE_BLACK],
      stepMs,
    )
    const thinkRemB = gateRem
    const thinkReadyB = gateReady

    tickGate(
      ts[TS_THINK_REM + SIDE_WHITE],
      ts[TS_THINK_VER + SIDE_WHITE],
      canW,
      curVer,
      cfg.thinkDelayMs[SIDE_WHITE],
      stepMs,
    )
    const thinkRemW = gateRem
    const thinkReadyW = gateReady

    tickGate(
      ts[TS_IDLE_REM + SIDE_BLACK],
      IDLE_VER,
      canB,
      IDLE_VER,
      cfg.idleAutoMoveMs,
      stepMs,
    )
    const idleRemB = gateRem
    const idleReadyB = gateReady

    tickGate(
      ts[TS_IDLE_REM + SIDE_WHITE],
      IDLE_VER,
      canW,
      IDLE_VER,
      cfg.idleAutoMoveMs,
      stepMs,
    )
    const idleRemW = gateRem
    const idleReadyW = gateReady

    if (thinkReadyB || thinkReadyW || idleReadyB || idleReadyW) {
      ts[TS_THINK_REM + SIDE_BLACK] = thinkRemB
      ts[TS_THINK_REM + SIDE_WHITE] = thinkRemW
      if (thinkRemB !== GATE_NULL) ts[TS_THINK_VER + SIDE_BLACK] = curVer
      if (thinkRemW !== GATE_NULL) ts[TS_THINK_VER + SIDE_WHITE] = curVer
      ts[TS_IDLE_REM + SIDE_BLACK] = idleRemB
      ts[TS_IDLE_REM + SIDE_WHITE] = idleRemW

      out[OUT_CAN_ACT + SIDE_BLACK] = canB ? 1 : 0
      out[OUT_CAN_ACT + SIDE_WHITE] = canW ? 1 : 0
      out[OUT_THINK_READY + SIDE_BLACK] = thinkReadyB ? 1 : 0
      out[OUT_THINK_READY + SIDE_WHITE] = thinkReadyW ? 1 : 0
      out[OUT_IDLE_READY + SIDE_BLACK] = idleReadyB ? 1 : 0
      out[OUT_IDLE_READY + SIDE_WHITE] = idleReadyW ? 1 : 0
      out[OUT_HAS_MOVES + SIDE_BLACK] = hasB ? 1 : 0
      out[OUT_HAS_MOVES + SIDE_WHITE] = hasW ? 1 : 0
      return
    }

    // 誰も ready でない区間は、次に ready になるステップ時刻まで一気に飛ぶ。
    // 盤面が動かないので hasMoves は不変、着手可能はクールタイムが 0 になる時だけ増える。
    const now = ts[TS_TIME]
    const cdB = ts[TS_COOLDOWN + SIDE_BLACK]
    const cdW = ts[TS_COOLDOWN + SIDE_WHITE]
    const ableB = hasB ? (cdB === 0 ? now : now + cdB) : INF
    const ableW = hasW ? (cdW === 0 ? now : now + cdW) : INF

    let target = INF
    target = Math.min(
      target,
      gateReadyAt(
        now,
        ableB,
        ts[TS_THINK_REM + SIDE_BLACK],
        ts[TS_THINK_VER + SIDE_BLACK],
        curVer,
        cfg.thinkDelayMs[SIDE_BLACK],
        stepMs,
      ),
      gateReadyAt(
        now,
        ableW,
        ts[TS_THINK_REM + SIDE_WHITE],
        ts[TS_THINK_VER + SIDE_WHITE],
        curVer,
        cfg.thinkDelayMs[SIDE_WHITE],
        stepMs,
      ),
      gateReadyAt(
        now,
        ableB,
        ts[TS_IDLE_REM + SIDE_BLACK],
        IDLE_VER,
        IDLE_VER,
        cfg.idleAutoMoveMs,
        stepMs,
      ),
      gateReadyAt(
        now,
        ableW,
        ts[TS_IDLE_REM + SIDE_WHITE],
        IDLE_VER,
        IDLE_VER,
        cfg.idleAutoMoveMs,
        stepMs,
      ),
    )

    if (target === INF || target < now + stepMs) target = now + stepMs

    const lastStepTime = cfg.matchDurationMs - stepMs
    if (target > lastStepTime) {
      const delta = cfg.matchDurationMs - now
      ts[TS_TIME] = cfg.matchDurationMs
      ts[TS_COOLDOWN + SIDE_BLACK] = Math.max(0, cdB - delta)
      ts[TS_COOLDOWN + SIDE_WHITE] = Math.max(0, cdW - delta)
      finish(match, END_TIME_UP)
      return
    }

    const thinkEnterB = gateEnteringAt(
      now,
      ableB,
      ts[TS_THINK_REM + SIDE_BLACK],
      ts[TS_THINK_VER + SIDE_BLACK],
      curVer,
      cfg.thinkDelayMs[SIDE_BLACK],
      stepMs,
      target,
    )
    const thinkEnterW = gateEnteringAt(
      now,
      ableW,
      ts[TS_THINK_REM + SIDE_WHITE],
      ts[TS_THINK_VER + SIDE_WHITE],
      curVer,
      cfg.thinkDelayMs[SIDE_WHITE],
      stepMs,
      target,
    )
    const idleEnterB = gateEnteringAt(
      now,
      ableB,
      ts[TS_IDLE_REM + SIDE_BLACK],
      IDLE_VER,
      IDLE_VER,
      cfg.idleAutoMoveMs,
      stepMs,
      target,
    )
    const idleEnterW = gateEnteringAt(
      now,
      ableW,
      ts[TS_IDLE_REM + SIDE_WHITE],
      IDLE_VER,
      IDLE_VER,
      cfg.idleAutoMoveMs,
      stepMs,
      target,
    )

    const delta = target - now
    ts[TS_TIME] = target
    ts[TS_COOLDOWN + SIDE_BLACK] = Math.max(0, cdB - delta)
    ts[TS_COOLDOWN + SIDE_WHITE] = Math.max(0, cdW - delta)
    ts[TS_THINK_REM + SIDE_BLACK] = thinkEnterB
    ts[TS_THINK_REM + SIDE_WHITE] = thinkEnterW
    if (thinkEnterB !== GATE_NULL) ts[TS_THINK_VER + SIDE_BLACK] = curVer
    if (thinkEnterW !== GATE_NULL) ts[TS_THINK_VER + SIDE_WHITE] = curVer
    ts[TS_IDLE_REM + SIDE_BLACK] = idleEnterB
    ts[TS_IDLE_REM + SIDE_WHITE] = idleEnterW
  }
}

// --- 着手適用 -------------------------------------------------------------

let appliedBlack = false
let appliedWhite = false

/**
 * 直前の applyFastStep で実際に盤に乗った手。探索の巻き戻しに使う。
 * 1 ステップで最大 2 手（同時着手）入る。適用順に並ぶ。
 */
export const lastStepUndo = {
  count: 0,
  cells: new Int32Array(2),
  colors: new Int32Array(2),
  flips: new Int32Array(2),
}

function tryApplyMove(match: FastMatch, side: number, action: number): boolean {
  const ts = match.ts
  if (ts[TS_PHASE] === PHASE_FINISHED) return false
  if (ts[TS_COOLDOWN + side] > 0) return false
  const cell = ACTION_TO_CELL[action]
  const color = colorOfSide(side)
  if (!isLegalCell(match.pos, cell, color)) return false
  const flips = doMove(match.pos, cell, color)
  const slot = lastStepUndo.count
  lastStepUndo.cells[slot] = cell
  lastStepUndo.colors[slot] = color
  lastStepUndo.flips[slot] = flips
  lastStepUndo.count = slot + 1
  ts[TS_COOLDOWN + side] = match.config.cooldownMs
  ts[TS_VERSION] += 1
  ts[TS_MOVE_COUNT] += 1
  ts[TS_LAST_CHANGE] = ts[TS_TIME]
  return true
}

/**
 * applyFastStep で盤に乗った手を逆順に戻す。
 * 時間状態は呼び出し側が saveTimeState / restoreTimeState で戻すこと。
 */
export function undoAppliedMoves(
  match: FastMatch,
  count: number,
  cells: Int32Array,
  colors: Int32Array,
  flips: Int32Array,
  at = 0,
): void {
  for (let k = count - 1; k >= 0; k -= 1) {
    undoMove(match.pos, cells[at + k], colors[at + k], flips[at + k])
  }
}

/**
 * 1 ステップ分の着手処理と時間送り。ルール層 stepMatch と同じ順序で行う。
 * actionBlack / actionWhite は 0..99 または WAIT_ACTION。
 *
 * 自発 WAIT（ready なのに置かない）のゲート据え置きも、matchRunner と同じに合わせる。
 */
export function applyFastStep(
  match: FastMatch,
  actionBlack: number,
  actionWhite: number,
): void {
  const ts = match.ts
  const out = match.out
  const cfg = match.config
  const preVersion = ts[TS_VERSION]
  lastStepUndo.count = 0

  // 自発 WAIT は「ready のまま据え置き」。着手前の盤面世代を署名として残す
  for (const side of [SIDE_BLACK, SIDE_WHITE]) {
    const action = side === SIDE_BLACK ? actionBlack : actionWhite
    if (
      out[OUT_CAN_ACT + side] === 1 &&
      out[OUT_THINK_READY + side] === 1 &&
      action === WAIT_ACTION
    ) {
      ts[TS_THINK_REM + side] = 0
      ts[TS_THINK_VER + side] = preVersion
    }
  }

  appliedBlack = false
  appliedWhite = false

  const blackMoves = actionBlack !== WAIT_ACTION
  const whiteMoves = actionWhite !== WAIT_ACTION

  if (blackMoves && whiteMoves) {
    const priority = ts[TS_PRIORITY]
    const first = priority
    const second = priority === SIDE_BLACK ? SIDE_WHITE : SIDE_BLACK
    const firstAction = first === SIDE_BLACK ? actionBlack : actionWhite
    const secondAction = second === SIDE_BLACK ? actionBlack : actionWhite

    if (tryApplyMove(match, first, firstAction)) {
      if (first === SIDE_BLACK) appliedBlack = true
      else appliedWhite = true
    }
    let ended = checkEndAfterBoardChange(match)
    if (!ended) {
      if (tryApplyMove(match, second, secondAction)) {
        if (second === SIDE_BLACK) appliedBlack = true
        else appliedWhite = true
      }
      ended = checkEndAfterBoardChange(match)
    }
    // 双方が要求した同時着手のたびに優先側を交代（片方だけなら交代しない）
    ts[TS_PRIORITY] = priority === SIDE_BLACK ? SIDE_WHITE : SIDE_BLACK
  } else if (blackMoves || whiteMoves) {
    const side = blackMoves ? SIDE_BLACK : SIDE_WHITE
    const action = blackMoves ? actionBlack : actionWhite
    if (tryApplyMove(match, side, action)) {
      if (side === SIDE_BLACK) appliedBlack = true
      else appliedWhite = true
    }
    checkEndAfterBoardChange(match)
  }

  // 着手した側の無操作タイマーを測り直す
  if (appliedBlack) ts[TS_IDLE_REM + SIDE_BLACK] = GATE_NULL
  if (appliedWhite) ts[TS_IDLE_REM + SIDE_WHITE] = GATE_NULL

  if (ts[TS_PHASE] === PHASE_FINISHED) return

  const stepMs = cfg.stepMs
  ts[TS_TIME] += stepMs
  const b = ts[TS_COOLDOWN + SIDE_BLACK] - stepMs
  const w = ts[TS_COOLDOWN + SIDE_WHITE] - stepMs
  ts[TS_COOLDOWN + SIDE_BLACK] = b > 0 ? b : 0
  ts[TS_COOLDOWN + SIDE_WHITE] = w > 0 ? w : 0

  if (ts[TS_TIME] >= cfg.matchDurationMs) {
    finish(match, END_TIME_UP)
    return
  }
  checkEndAfterBoardChange(match)
}

export function lastStepAppliedBlack(): boolean {
  return appliedBlack
}

export function lastStepAppliedWhite(): boolean {
  return appliedWhite
}

// --- 状態の退避・復元（MCTS 用） ------------------------------------------

export function saveTimeState(match: FastMatch, dst: Int32Array, at = 0): void {
  dst.set(match.ts, at)
}

export function restoreTimeState(
  match: FastMatch,
  src: Int32Array,
  at = 0,
): void {
  match.ts.set(src.subarray(at, at + TS_SIZE))
}

// --- 対戦実行 -------------------------------------------------------------

export type FastAgent = {
  id: string
  /**
   * 着手可能かつ判断待ち完了のときだけ呼ばれる。
   * match を書き換えてはいけない（探索する場合は do/undo で必ず元に戻す）。
   * 返り値は 0..99（着手）または WAIT_ACTION（自発待機）。
   */
  decide: (match: FastMatch, side: number, rng: Rng) => number
  /** 試合ごとの内部状態を捨てる */
  onMatchStart?: (side: number) => void
}

export type FastMatchResult = {
  outcome: number
  endReason: number
  black: number
  white: number
  empty: number
  stoneDiffForBlack: number
  elapsedMs: number
  moveCount: number
  decisions: number
  abnormal: boolean
}

/** 無操作 3 秒の強制着手（ルール層 pickRandomLegalMove と同じ消費順） */
function pickRandomLegalAction(
  match: FastMatch,
  side: number,
  rng: Rng,
): number {
  const n = listLegalActions(match, side, scratchActions)
  if (n === 0) return WAIT_ACTION
  return scratchActions[rng.nextInt(0, n)]
}

const scratchActions = new Int32Array(128)

export type FastMatchHooks = {
  /** 判断待ち完了で自分が選んだ行動（自己対戦の Policy Target 収集用） */
  onDecision?: (
    match: FastMatch,
    side: number,
    action: number,
    forcedByIdle: boolean,
  ) => void
  /** 着手適用の直前。両側の要求をそのまま渡す（一致検証・棋譜記録用） */
  onStep?: (match: FastMatch, actionBlack: number, actionWhite: number) => void
}

export function runFastMatch(options: {
  seed: number
  decisionSeed: number
  black: FastAgent
  white: FastAgent
  config?: Partial<FastMatchConfig>
  hooks?: FastMatchHooks
  match?: FastMatch
  rngBlack?: Rng
  rngWhite?: Rng
  maxDecisions?: number
  /**
   * 最初の N 意思決定を合法手からのランダム着手にする。
   *
   * 両者が決定的なエンジンだと、シードを変えても試合がほぼ同一になり
   * （この実装で違うのは同時着手の優先側だけ）、何局測っても独立標本にならない。
   * 開幕をばらして初期条件を散らす。
   */
  randomOpeningDecisions?: number
}): FastMatchResult {
  const match =
    options.match ?? createFastMatch({ seed: options.seed, config: options.config })
  if (options.match) resetFastMatch(match, options.seed)

  const rngBlack = options.rngBlack ?? createMatchRng(options.decisionSeed, 1)
  const rngWhite = options.rngWhite ?? createMatchRng(options.decisionSeed, 2)
  options.black.onMatchStart?.(SIDE_BLACK)
  options.white.onMatchStart?.(SIDE_WHITE)

  const maxDecisions = options.maxDecisions ?? 4000
  const randomOpening = options.randomOpeningDecisions ?? 0
  const hooks = options.hooks
  let decisions = 0

  while (decisions < maxDecisions) {
    advanceToDecision(match)
    if (match.ts[TS_PHASE] === PHASE_FINISHED) break
    decisions += 1

    const out = match.out
    let actionBlack = WAIT_ACTION
    let actionWhite = WAIT_ACTION
    let forcedBlack = false
    let forcedWhite = false
    const inOpening = decisions <= randomOpening

    if (out[OUT_CAN_ACT + SIDE_BLACK] === 1 && out[OUT_THINK_READY + SIDE_BLACK] === 1) {
      if (inOpening) {
        actionBlack = pickRandomLegalAction(match, SIDE_BLACK, rngBlack)
        forcedBlack = actionBlack !== WAIT_ACTION
      } else {
        actionBlack = options.black.decide(match, SIDE_BLACK, rngBlack)
      }
    }
    if (out[OUT_CAN_ACT + SIDE_WHITE] === 1 && out[OUT_THINK_READY + SIDE_WHITE] === 1) {
      if (inOpening) {
        actionWhite = pickRandomLegalAction(match, SIDE_WHITE, rngWhite)
        forcedWhite = actionWhite !== WAIT_ACTION
      } else {
        actionWhite = options.white.decide(match, SIDE_WHITE, rngWhite)
      }
    }

    if (
      actionBlack === WAIT_ACTION &&
      out[OUT_CAN_ACT + SIDE_BLACK] === 1 &&
      out[OUT_IDLE_READY + SIDE_BLACK] === 1
    ) {
      actionBlack = pickRandomLegalAction(match, SIDE_BLACK, rngBlack)
      forcedBlack = actionBlack !== WAIT_ACTION
    }
    if (
      actionWhite === WAIT_ACTION &&
      out[OUT_CAN_ACT + SIDE_WHITE] === 1 &&
      out[OUT_IDLE_READY + SIDE_WHITE] === 1
    ) {
      actionWhite = pickRandomLegalAction(match, SIDE_WHITE, rngWhite)
      forcedWhite = actionWhite !== WAIT_ACTION
    }

    if (hooks?.onDecision) {
      if (out[OUT_CAN_ACT + SIDE_BLACK] === 1 && out[OUT_THINK_READY + SIDE_BLACK] === 1) {
        hooks.onDecision(match, SIDE_BLACK, actionBlack, forcedBlack)
      }
      if (out[OUT_CAN_ACT + SIDE_WHITE] === 1 && out[OUT_THINK_READY + SIDE_WHITE] === 1) {
        hooks.onDecision(match, SIDE_WHITE, actionWhite, forcedWhite)
      }
    }

    hooks?.onStep?.(match, actionBlack, actionWhite)
    applyFastStep(match, actionBlack, actionWhite)
  }

  const finished = match.ts[TS_PHASE] === PHASE_FINISHED
  return {
    outcome: outcomeOf(match),
    endReason: match.ts[TS_END_REASON],
    black: match.pos.black,
    white: match.pos.white,
    empty: match.pos.emptyCount,
    stoneDiffForBlack: match.pos.black - match.pos.white,
    elapsedMs: match.ts[TS_TIME],
    moveCount: match.ts[TS_MOVE_COUNT],
    decisions,
    abnormal: !finished,
  }
}

/** matchRunner と同じ派生規則で側ごとの乱数を分ける */
function createMatchRng(decisionSeed: number, part: number): Rng {
  return createRng(deriveSeed(decisionSeed, part))
}
