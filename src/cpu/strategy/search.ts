/**
 * 先読み探索。
 *
 * このゲームは交互手番ではないので、手番は「次に着手できる時刻」で決める。
 * 双方の間隔が同じなら通常のオセロと同じ交互読みになり、片方が打てない間は
 * 連打として正しく展開される。評価は常に自分視点なので、
 * 手番側が自分なら最大化、相手なら最小化する（negamax ではない）。
 *
 * 打ち切りは実時計ではなくノード数で行う。同じ局面なら必ず同じ手を返す。
 */
import {
  BLACK,
  CELL_COUNT,
  N,
  cellIndex,
  colOf,
  doMove,
  generateMoves,
  countMobility,
  hasMoves,
  rowOf,
  undoMove,
  type FastPosition,
} from './fastBoard.ts'
import {
  WIN_SCORE,
  evaluate,
  evaluateLeaf,
  terminalScore,
} from './evaluate.ts'

const INFINITY = 4_000_000

const MAX_PLY = 128
const MOVE_STRIDE = 96

const TT_BITS = 17
const TT_SIZE = 1 << TT_BITS
const TT_MASK = TT_SIZE - 1

const FLAG_EMPTY = 0
const FLAG_EXACT = 1
const FLAG_LOWER = 2
const FLAG_UPPER = 3

/** 手順付けだけに使う静的なマス価値（評価関数とは別物） */
const SQUARE_ORDER = buildSquareOrder()

function buildSquareOrder(): Int32Array {
  const table = new Int32Array(CELL_COUNT)
  const quarter = [
    [120, -25, 12, 6, 4],
    [-25, -60, -4, -3, -3],
    [12, -4, 4, 1, 1],
    [6, -3, 1, 1, 0],
    [4, -3, 1, 0, 1],
  ]
  for (let row = 0; row < N; row += 1) {
    for (let col = 0; col < N; col += 1) {
      const r = row < N / 2 ? row : N - 1 - row
      const c = col < N / 2 ? col : N - 1 - col
      table[cellIndex(row, col)] = quarter[r][c]
    }
  }
  return table
}

export type SearchLimits = {
  /** 反復深化の上限 */
  maxDepth: number
  /** 展開ノード数の上限。実時計を使わないので結果は再現する */
  nodeBudget: number
}

export type SearchSchedule = {
  /** 自分が次に打てるまで（root では 0） */
  selfNextMs: number
  /** 相手が次に打てるまで */
  oppNextMs: number
  /** 自分の着手間隔（待ち時間＋判断待ち） */
  selfIntervalMs: number
  /** 相手の着手間隔の想定値 */
  oppIntervalMs: number
  /** 手番が回ってきてから打つまでの想定（パス復帰に使う） */
  selfReactionMs: number
  oppReactionMs: number
  /** 残り試合時間。ここを過ぎたら石数で決着 */
  matchRemainingMs: number
}

export type SearchResult = {
  /** 同点最善手（呼び出し側が乱数で選ぶ） */
  bestMoves: number[]
  score: number
  /** 読み切った深さ */
  depth: number
  nodes: number
  /** ノード上限で打ち切ったか */
  aborted: boolean
}

/**
 * 反復深化の途中経過。手番前の下読みで持ち越す。
 * `order` は前回の反復で良かった順なので、続きから読むと立ち上がりが速い。
 */
type RootState = {
  order: number[]
  bestMoves: number[]
  score: number
  /** 読み終えた深さ。途中で打ち切った反復は数えない */
  depth: number
  /** 勝敗確定か読み切りで、これ以上深くしても変わらない */
  finished: boolean
}

/**
 * 手番が来る前に読み進めるための持ち越し。
 *
 * 同じ局面・同じ手番・同じ日程のあいだだけ続ける。盤面が変わったら捨てる。
 * 置換表の世代を据え置くので、前のステップで読んだ部分木は 1 ノードで返る。
 */
export type PonderSession = {
  active: boolean
  hashA: number
  hashB: number
  me: number
  /** 日程の違い（100ms 単位）。ここが変わると読み直す */
  gap: number
  /** 相手の着手間隔の想定。変わると同じ盤面でも別の読みになるので持ち越せない */
  oppIntervalMs: number
  generation: number
  root: RootState | null
  /** このセッションで使った総ノード（計測用） */
  nodes: number
}

export function createPonderSession(): PonderSession {
  return {
    active: false,
    hashA: 0,
    hashB: 0,
    me: 0,
    gap: 0,
    oppIntervalMs: 0,
    generation: 0,
    root: null,
    nodes: 0,
  }
}

export function resetPonderSession(session: PonderSession): void {
  session.active = false
  session.root = null
  session.nodes = 0
}

/** 下読みを持たない呼び出し用。毎回読み直す */
const scratchSession = createPonderSession()

type SearchContext = {
  pos: FastPosition
  me: number
  opp: number
  schedule: SearchSchedule
  nodeBudget: number
  nodes: number
  aborted: boolean
  moveBuf: Int32Array
  orderBuf: Float64Array
  killers: Int32Array
  history: Int32Array
  generation: number
}

const ttLock = new Int32Array(TT_SIZE)
const ttValue = new Float64Array(TT_SIZE)
const ttDepth = new Int8Array(TT_SIZE)
const ttFlag = new Uint8Array(TT_SIZE)
const ttMove = new Int16Array(TT_SIZE)
const ttGen = new Int32Array(TT_SIZE)
let ttGeneration = 0

const context: SearchContext = {
  pos: null as unknown as FastPosition,
  me: BLACK,
  opp: 3 ^ BLACK,
  schedule: {
    selfNextMs: 0,
    oppNextMs: 0,
    selfIntervalMs: 1200,
    oppIntervalMs: 1200,
    selfReactionMs: 500,
    oppReactionMs: 500,
    matchRemainingMs: 180_000,
  },
  nodeBudget: 0,
  nodes: 0,
  aborted: false,
  moveBuf: new Int32Array(MAX_PLY * MOVE_STRIDE),
  orderBuf: new Float64Array(MAX_PLY * MOVE_STRIDE),
  killers: new Int32Array(MAX_PLY * 2),
  history: new Int32Array(CELL_COUNT * 4),
  generation: 0,
}

/** 局面ハッシュに手番と日程を混ぜる。日程が違えば同じ盤面でも別評価になる */
function ttIndex(ctx: SearchContext, selfTurn: boolean, gap: number): number {
  const bucket = clampGap(gap)
  const mixed =
    (ctx.pos.hashA ^ (selfTurn ? 0x5bf03635 : 0x2545f491) ^ (bucket * 0x9e3779b1)) >>>
    0
  return mixed & TT_MASK
}

function clampGap(gap: number): number {
  const bucket = Math.round(gap / 100)
  if (bucket < -16) return -16
  if (bucket > 16) return 16
  return bucket
}

/**
 * 空きマス数に応じてノード上限を配り直す。
 *
 * - 1 ノードの重さは空きマス数にほぼ比例するので、序盤は上限を下げて
 *   1 手あたりの実時間をそろえる
 * - 読み切りが届く終盤は大きく上げる。読み切れた時点で反復深化を止めるので、
 *   実際には上限まで使わないことが多い
 *
 * 空きマス数だけで決めるため、同じ局面なら結果は必ず再現する。
 */
export const EXACT_SOLVE_EMPTIES = 12

export function nodeBudgetFor(base: number, emptyCount: number): number {
  if (emptyCount <= EXACT_SOLVE_EMPTIES) return base * 5
  if (emptyCount <= 20) return base * 2
  if (emptyCount <= 40) return Math.round(base * 1.3)
  if (emptyCount <= 56) return base
  return Math.round(base * 0.7)
}

/**
 * 下読み 1 ステップぶんの上限。
 *
 * 着手時（`nodeBudgetFor`）と違って読み切りを狙わない。狙いは
 * 「1 ステップの実時間を短く一定に保つ」ことだけなので、
 * 1 ノードが重い序盤を下げるだけにして、終盤で増やさない。
 */
export function ponderBudgetFor(base: number, emptyCount: number): number {
  if (emptyCount >= 57) return Math.round(base * 0.7)
  return base
}

/**
 * root の 1 反復。読み終えたら root を更新し、打ち切ったら深さは進めない。
 *
 * `keepPartial` は「打ち切った反復の途中結果でも採用してよいか」。
 * 着手を返す直前なら採用する（前回の最善手を先に読んでいるので、
 * 少なくとも同じ深さ同士の比較にはなっている）。
 * 手番前の下読みでは採用しない。何度も打ち切られるたびに上書きすると、
 * 読み終えた深さの結果より悪いものが残りうるため。
 */
function runRootIteration(
  ctx: SearchContext,
  root: RootState,
  depth: number,
  keepPartial: boolean,
): void {
  const pos = ctx.pos
  const me = ctx.me
  const schedule = ctx.schedule
  let iterBest = -INFINITY
  let iterMoves: number[] = []

  for (let k = 0; k < root.order.length; k += 1) {
    const move = root.order[k]
    // 同点手も正しく拾うため、窓の下端は「現在の最善-1」にする
    const alpha = iterMoves.length === 0 ? -INFINITY : iterBest - 1
    const flips = doMove(pos, move, me)
    const value = visit(
      ctx,
      schedule.selfNextMs + schedule.selfIntervalMs,
      schedule.oppNextMs,
      depth - 1,
      alpha,
      INFINITY,
      1,
    )
    undoMove(pos, move, me, flips)

    if (ctx.aborted) break
    if (value > iterBest) {
      iterBest = value
      iterMoves = [move]
    } else if (value === iterBest) {
      iterMoves.push(move)
    }
  }

  if (ctx.aborted) {
    if (keepPartial && iterMoves.length > 0) {
      root.score = iterBest
      root.bestMoves = iterMoves
    }
    return
  }

  root.score = iterBest
  root.bestMoves = iterMoves
  root.depth = depth

  // 次の反復は最善手から読む
  const head = iterMoves[0]
  const at = root.order.indexOf(head)
  if (at > 0) {
    root.order.splice(at, 1)
    root.order.unshift(head)
  }

  if (iterBest >= WIN_SCORE || iterBest <= -WIN_SCORE) root.finished = true
  if (depth >= pos.emptyCount) root.finished = true
}

function scheduleGap(schedule: SearchSchedule): number {
  return clampGap(schedule.oppNextMs - schedule.selfNextMs)
}

/** 持ち越しが今の局面に使えるか */
function sessionMatches(
  session: PonderSession,
  pos: FastPosition,
  me: number,
  schedule: SearchSchedule,
  gap: number,
): boolean {
  return (
    session.active &&
    session.root !== null &&
    session.hashA === pos.hashA &&
    session.hashB === pos.hashB &&
    session.me === me &&
    session.gap === gap &&
    session.oppIntervalMs === schedule.oppIntervalMs
  )
}

/** 持ち越しを捨てて、この局面用に読み始める */
function beginSession(
  ctx: SearchContext,
  session: PonderSession,
  pos: FastPosition,
  me: number,
  schedule: SearchSchedule,
  gap: number,
): void {
  ctx.killers.fill(0)
  ctx.history.fill(0)
  ttGeneration += 1

  session.active = true
  session.hashA = pos.hashA
  session.hashB = pos.hashB
  session.me = me
  session.gap = gap
  session.oppIntervalMs = schedule.oppIntervalMs
  session.generation = ttGeneration
  session.nodes = 0

  const rootMoves = new Int32Array(MOVE_STRIDE)
  const rootCount = generateMoves(pos, me, rootMoves, 0)
  if (rootCount === 0) {
    session.root = null
    return
  }
  const order = Array.from(rootMoves.slice(0, rootCount))
  order.sort((a, b) => staticOrder(ctx, b, me) - staticOrder(ctx, a, me))
  session.root = {
    order,
    bestMoves: [order[0]],
    score: 0,
    depth: 0,
    // 手が 1 つしかないなら読む意味がない
    finished: rootCount === 1,
  }
}

/**
 * 反復深化を `maxIterations` 回だけ進める。
 *
 * 着手を決めるとき（`searchBestMove`）は上限まで回し、手番前の下読みでは 1 回だけ回す。
 * どちらも同じ持ち越し（`PonderSession`）を使うので、下読みの続きから着手を決められる。
 */
function advanceSearch(
  pos: FastPosition,
  me: number,
  schedule: SearchSchedule,
  limits: {
    maxDepth: number
    nodeBudget: number
    maxIterations: number
    keepPartial: boolean
  },
  session: PonderSession,
): SearchResult {
  const ctx = context
  ctx.pos = pos
  ctx.me = me
  ctx.opp = me ^ 3
  ctx.schedule = schedule
  ctx.nodes = 0
  ctx.aborted = false

  const gap = scheduleGap(schedule)
  if (!sessionMatches(session, pos, me, schedule, gap)) {
    beginSession(ctx, session, pos, me, schedule, gap)
  }

  const root = session.root
  if (!root) {
    return { bestMoves: [], score: 0, depth: 0, nodes: 0, aborted: false }
  }

  ctx.nodeBudget = limits.nodeBudget
  ctx.generation = session.generation

  for (let i = 0; i < limits.maxIterations; i += 1) {
    if (root.finished) break
    if (root.depth >= limits.maxDepth) break
    runRootIteration(ctx, root, root.depth + 1, limits.keepPartial)
    if (ctx.aborted) break
  }
  session.nodes += ctx.nodes

  return {
    bestMoves: root.bestMoves,
    score: root.score,
    depth: root.depth,
    nodes: ctx.nodes,
    aborted: ctx.aborted,
  }
}

/** 手番が来る前の下読みを 1 ステップ分だけ進める。着手は返さない */
export function stepPonder(
  pos: FastPosition,
  me: number,
  schedule: SearchSchedule,
  limits: { maxDepth: number; stepNodeBudget: number },
  session: PonderSession,
): SearchResult {
  return advanceSearch(
    pos,
    me,
    schedule,
    {
      maxDepth: limits.maxDepth,
      nodeBudget: ponderBudgetFor(limits.stepNodeBudget, pos.emptyCount),
      maxIterations: 1,
      keepPartial: false,
    },
    session,
  )
}

/**
 * 着手を決める。`session` を渡すと下読みの続きから読む。
 * 局面や日程が変わっていれば中で読み直すので、呼び出し側は気にしなくてよい。
 */
export function searchBestMove(
  pos: FastPosition,
  me: number,
  schedule: SearchSchedule,
  limits: SearchLimits,
  session?: PonderSession,
): SearchResult {
  const active = session ?? scratchSession
  const result = advanceSearch(
    pos,
    me,
    schedule,
    {
      maxDepth: limits.maxDepth,
      nodeBudget: nodeBudgetFor(limits.nodeBudget, pos.emptyCount),
      maxIterations: limits.maxDepth,
      keepPartial: true,
    },
    active,
  )
  // 使い終わった持ち越しは、次の呼び出しで必ず読み直させる
  if (!session) resetPonderSession(active)

  if (result.bestMoves.length <= 1) return result
  return { ...result, bestMoves: refineTies(context, result.bestMoves, me) }
}

/**
 * 読みで差が付かなかった手は、静的評価の良い方を選ぶ。
 *
 * 深く読むと「角は後でも取れる」と見て別の手と同点になることがある。
 * 実戦では相手が先に取る危険があるので、一般的なオセロの原則
 * （角・確定石・着手可能数）で決着させる。
 */
function refineTies(
  ctx: SearchContext,
  moves: number[],
  me: number,
): number[] {
  const pos = ctx.pos
  let best = -Infinity
  let picked: number[] = []
  for (const move of moves) {
    const flips = doMove(pos, move, me)
    const value = evaluate(pos, me, false)
    undoMove(pos, move, me, flips)
    if (value > best) {
      best = value
      picked = [move]
    } else if (value === best) {
      picked.push(move)
    }
  }
  return picked
}

function staticOrder(ctx: SearchContext, move: number, side: number): number {
  return SQUARE_ORDER[move] + ctx.history[side * CELL_COUNT + move] * 0.001
}

function visit(
  ctx: SearchContext,
  selfNextMs: number,
  oppNextMs: number,
  depth: number,
  alphaIn: number,
  betaIn: number,
  ply: number,
): number {
  const pos = ctx.pos

  ctx.nodes += 1
  if (ctx.nodes >= ctx.nodeBudget) {
    ctx.aborted = true
    return 0
  }

  if (pos.emptyCount === 0) return terminalScore(pos, ctx.me)

  const selfTurn = selfNextMs <= oppNextMs
  const now = selfTurn ? selfNextMs : oppNextMs
  if (now >= ctx.schedule.matchRemainingMs) return terminalScore(pos, ctx.me)

  if (depth <= 0) return evaluateLeaf(pos, ctx.me, selfTurn)

  const side = selfTurn ? ctx.me : ctx.opp
  const safePly = ply < MAX_PLY ? ply : MAX_PLY - 1
  const base = safePly * MOVE_STRIDE
  const moves = ctx.moveBuf
  const count = generateMoves(pos, side, moves, base)

  if (count === 0) {
    const other = selfTurn ? ctx.opp : ctx.me
    if (!hasMoves(pos, other)) return terminalScore(pos, ctx.me)
    // 打てない側は相手の着手後に復帰する
    if (selfTurn) {
      return visit(
        ctx,
        oppNextMs + ctx.schedule.selfReactionMs,
        oppNextMs,
        depth,
        alphaIn,
        betaIn,
        ply,
      )
    }
    return visit(
      ctx,
      selfNextMs,
      selfNextMs + ctx.schedule.oppReactionMs,
      depth,
      alphaIn,
      betaIn,
      ply,
    )
  }

  const gap = oppNextMs - selfNextMs
  const slot = ttIndex(ctx, selfTurn, gap)
  const lock =
    (pos.hashB ^
      (selfTurn ? 0x1b873593 : 0x0) ^
      Math.imul(clampGap(gap), 0x2545f491)) |
    0
  let ttBest = 0
  if (ttGen[slot] === ctx.generation && ttLock[slot] === lock) {
    if (ttDepth[slot] >= depth) {
      const flag = ttFlag[slot]
      const value = ttValue[slot]
      if (flag === FLAG_EXACT) return value
      if (flag === FLAG_LOWER && value >= betaIn) return value
      if (flag === FLAG_UPPER && value <= alphaIn) return value
    }
    ttBest = ttMove[slot]
  }

  scoreMoves(ctx, moves, base, count, side, depth, safePly, ttBest)

  let alpha = alphaIn
  let beta = betaIn
  let best = selfTurn ? -INFINITY : INFINITY
  let bestMove = 0

  for (let k = 0; k < count; k += 1) {
    selectNext(ctx, base, count, k)
    const move = moves[base + k]
    const flips = doMove(pos, move, side)
    const childSelf = selfTurn
      ? selfNextMs + ctx.schedule.selfIntervalMs
      : selfNextMs
    const childOpp = selfTurn
      ? oppNextMs
      : oppNextMs + ctx.schedule.oppIntervalMs

    let value: number
    if (k === 0) {
      value = visit(ctx, childSelf, childOpp, depth - 1, alpha, beta, ply + 1)
    } else if (selfTurn) {
      value = visit(
        ctx,
        childSelf,
        childOpp,
        depth - 1,
        alpha,
        alpha + 1,
        ply + 1,
      )
      if (!ctx.aborted && value > alpha && value < beta) {
        value = visit(ctx, childSelf, childOpp, depth - 1, alpha, beta, ply + 1)
      }
    } else {
      value = visit(
        ctx,
        childSelf,
        childOpp,
        depth - 1,
        beta - 1,
        beta,
        ply + 1,
      )
      if (!ctx.aborted && value < beta && value > alpha) {
        value = visit(ctx, childSelf, childOpp, depth - 1, alpha, beta, ply + 1)
      }
    }

    undoMove(pos, move, side, flips)
    if (ctx.aborted) return best

    if (selfTurn) {
      if (value > best) {
        best = value
        bestMove = move
        if (value > alpha) alpha = value
      }
    } else if (value < best) {
      best = value
      bestMove = move
      if (value < beta) beta = value
    }

    if (alpha >= beta) {
      rememberCut(ctx, side, move, depth, safePly)
      break
    }
  }

  let flag = FLAG_EXACT
  if (best <= alphaIn) flag = FLAG_UPPER
  else if (best >= betaIn) flag = FLAG_LOWER

  ttGen[slot] = ctx.generation
  ttLock[slot] = lock
  ttValue[slot] = best
  ttDepth[slot] = depth > 127 ? 127 : depth
  ttFlag[slot] = flag
  ttMove[slot] = bestMove

  return best
}

function rememberCut(
  ctx: SearchContext,
  side: number,
  move: number,
  depth: number,
  ply: number,
): void {
  const slot = ply * 2
  if (ctx.killers[slot] !== move) {
    ctx.killers[slot + 1] = ctx.killers[slot]
    ctx.killers[slot] = move
  }
  ctx.history[side * CELL_COUNT + move] += depth * depth
}

/**
 * 手順付け。良い手ほど大きい点にする。
 * 深いノードでは 1 手指して相手の着手可能数を数える（着手可能数を減らす手が good）。
 */
function scoreMoves(
  ctx: SearchContext,
  moves: Int32Array,
  base: number,
  count: number,
  side: number,
  depth: number,
  ply: number,
  ttBest: number,
): void {
  const pos = ctx.pos
  const other = side ^ 3
  const scores = ctx.orderBuf
  const killerA = ctx.killers[ply * 2]
  const killerB = ctx.killers[ply * 2 + 1]
  // 仮着手は葉の直前では割に合わない。深いノードほど手厚く並べ替える
  const tryMoves = depth >= 2
  const countReplies = depth >= 4

  for (let k = 0; k < count; k += 1) {
    const move = moves[base + k]
    if (move === ttBest) {
      scores[base + k] = 1e9
      continue
    }
    let score = SQUARE_ORDER[move] * 3
    if (move === killerA) score += 4000
    else if (move === killerB) score += 2000
    score += ctx.history[side * CELL_COUNT + move] * 0.01
    if (tryMoves) {
      const flips = doMove(pos, move, side)
      // たくさん返す手は開放度が悪くなりやすい（オセロの基本）
      score -= flips * 5
      if (countReplies) score -= countMobility(pos, other) * 40
      undoMove(pos, move, side, flips)
    }
    scores[base + k] = score
  }
}

/** k 番目に良い手を moves[base+k] に持ってくる（必要な分だけ選択ソート） */
function selectNext(
  ctx: SearchContext,
  base: number,
  count: number,
  k: number,
): void {
  const moves = ctx.moveBuf
  const scores = ctx.orderBuf
  let bestAt = k
  let bestScore = scores[base + k]
  for (let j = k + 1; j < count; j += 1) {
    const s = scores[base + j]
    if (s > bestScore) {
      bestScore = s
      bestAt = j
    }
  }
  if (bestAt === k) return
  const tmpMove = moves[base + k]
  moves[base + k] = moves[base + bestAt]
  moves[base + bestAt] = tmpMove
  scores[base + bestAt] = scores[base + k]
  scores[base + k] = bestScore
}

export function moveToCoord(index: number): { row: number; col: number } {
  return { row: rowOf(index), col: colOf(index) }
}

/** テスト用: 置換表の中身を無効化する */
export function resetTranspositionTable(): void {
  ttGen.fill(0)
  ttLock.fill(0)
  ttFlag.fill(FLAG_EMPTY)
  ttGeneration = 0
}
