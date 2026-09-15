/**
 * 時間イベント型 MCTS。
 *
 * 「次のターン」ではなく「次に発生する意思決定イベント」を木の1段にする。
 * 1段進めるたびに advanceToDecision が呼ばれるので、
 * ノードの間隔は 50ms とは限らず、クールタイム・判断待ち・連続着手が自然に入る。
 *
 * 同一の意思決定点で双方が着手できることが実測で 8〜17% ある（docs/ai-roadmap.md）。
 * そこは手番を作らず、側ごとに独立した統計で選ぶ decoupled UCT（DUCT）にする。
 * 仕様 2.4 の「相手の未確定入力を見て判断しない」と整合する。
 *
 * 価値はすべて黒視点の [-1, 1] で持ち、白の統計に積むときだけ符号を反転する。
 */
import {
  OUT_CAN_ACT,
  OUT_SIZE,
  OUT_IDLE_READY,
  OUT_THINK_READY,
  PHASE_FINISHED,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_PHASE,
  TS_SIZE,
  advanceToDecision,
  applyFastStep,
  lastStepUndo,
  listLegalActions,
  outcomeOf,
  restoreTimeState,
  saveTimeState,
  undoAppliedMoves,
  OUTCOME_BLACK_WIN,
  OUTCOME_WHITE_WIN,
  type FastMatch,
} from '../sim/fastMatch.ts'
import { WAIT_ACTION } from '../../sim/constants.ts'
import type { Rng } from '../../game/rng.ts'

export const READY_BLACK = 1
export const READY_WHITE = 2

/** 局面評価。黒視点の [-1, 1] を返す */
export type ValueFn = (match: FastMatch) => number

/**
 * 事前確率。ready な側の合法手（+ WAIT）へ確率を書き込む。
 * actions[0..count) に対応する priors[0..count) を埋める。合計 1 に正規化して返す。
 */
export type PolicyFn = (
  match: FastMatch,
  side: number,
  actions: Int32Array,
  count: number,
  priors: Float32Array,
) => void

export type MctsConfig = {
  simulations: number
  /** 探索の強さ（大きいほど広く探す） */
  cPuct: number
  /** 未訪問手の初期評価（親の価値から引く量）。0 で親と同じ */
  fpuReduction: number
  /** 自分の自発待機を手として考えるか */
  allowWait: boolean
  /**
   * 相手の自発待機も手として考えるか。
   * false にすると「相手は置けるなら必ず置く」という相手モデルになる。
   */
  allowOpponentWait: boolean
  /** 1 シミュレーションの最大段数 */
  maxDepth: number
  /** root の事前確率に混ぜる Dirichlet ノイズ量（0 で無効） */
  dirichletAlpha: number
  dirichletWeight: number
  /** 最終手の選び方。0 で最多訪問、>0 で訪問数^(1/temperature) の抽選 */
  temperature: number
  /** 木のノード上限 */
  maxNodes: number
}

export const DEFAULT_MCTS_CONFIG: MctsConfig = {
  simulations: 256,
  cPuct: 1.6,
  fpuReduction: 0.25,
  allowWait: false,
  allowOpponentWait: true,
  maxDepth: 192,
  dirichletAlpha: 0,
  dirichletWeight: 0,
  temperature: 0,
  maxNodes: 40_000,
}

const MAX_ACTIONS = 101

/** 1 ノードあたりに確保する辺の数（2 側 × 分岐の実用上限） */
const EDGES_PER_NODE = 72

export type MctsSearchStats = {
  simulations: number
  nodes: number
  rootValue: number
  maxDepthReached: number
  aborted: number
}

export class Mcts {
  private readonly cfg: MctsConfig
  private readonly value: ValueFn
  private readonly policy: PolicyFn

  // --- ノード ---
  private nVisits: Int32Array
  private nValueSum: Float64Array
  private nEdgeStart: Int32Array
  private nEdgeCount: Int32Array // [black, white] を 2 スロットで持つ
  private nReadyMask: Int32Array
  private nTerminal: Int8Array
  private nTerminalValue: Float32Array
  private nFirstChild: Int32Array
  private nodeCount = 0
  /** 実際に確保したノード数の上限 */
  private readonly maxNodes: number
  /** 今の探索でどちら側の手を選んでいるか（相手の待機可否の判定に使う） */
  private searchSide = SIDE_BLACK

  // --- 辺（側ごとの行動統計）---
  private eAction: Int32Array
  private eVisits: Int32Array
  private eValueSum: Float64Array
  private ePrior: Float32Array
  private edgeCount = 0

  // --- 子リンク ---
  private cKey: Int32Array
  private cNode: Int32Array
  private cNext: Int32Array
  private childCount = 0

  // --- 探索経路 ---
  private pathTime: Int32Array
  private pathNode: Int32Array
  private pathEdgeB: Int32Array
  private pathEdgeW: Int32Array
  private pathUndoCount: Int32Array
  private pathUndoCells: Int32Array
  private pathUndoColors: Int32Array
  private pathUndoFlips: Int32Array

  private actionBuf = new Int32Array(MAX_ACTIONS)
  private priorBuf = new Float32Array(MAX_ACTIONS)
  private gammaBuf = new Float64Array(MAX_ACTIONS)
  private rootTime = new Int32Array(TS_SIZE)
  private rootOut = new Int32Array(OUT_SIZE)

  private stats: MctsSearchStats = {
    simulations: 0,
    nodes: 0,
    rootValue: 0,
    maxDepthReached: 0,
    aborted: 0,
  }

  constructor(options: {
    config?: Partial<MctsConfig>
    value: ValueFn
    policy: PolicyFn
  }) {
    this.cfg = { ...DEFAULT_MCTS_CONFIG, ...options.config }
    this.value = options.value
    this.policy = options.policy

    // 1 シミュレーションで増えるノードは最大 1 つなので、探索量で上限が決まる。
    // 配列は数 MB になるため、探索量が小さいときに確保しすぎない
    const maxNodes = Math.min(this.cfg.maxNodes, this.cfg.simulations + 8)
    this.maxNodes = maxNodes
    // 1 ノードで 2 側 × (合法手 + WAIT)。100 マス盤なので中盤の分岐は 20 を超える。
    // ここを平均値で切ると辺が枯れてノードが死に、探索量を増やすほど弱くなる
    const maxEdges = maxNodes * EDGES_PER_NODE
    this.nVisits = new Int32Array(maxNodes)
    this.nValueSum = new Float64Array(maxNodes)
    this.nEdgeStart = new Int32Array(maxNodes)
    this.nEdgeCount = new Int32Array(maxNodes * 2)
    this.nReadyMask = new Int32Array(maxNodes)
    this.nTerminal = new Int8Array(maxNodes)
    this.nTerminalValue = new Float32Array(maxNodes)
    this.nFirstChild = new Int32Array(maxNodes)

    this.eAction = new Int32Array(maxEdges)
    this.eVisits = new Int32Array(maxEdges)
    this.eValueSum = new Float64Array(maxEdges)
    this.ePrior = new Float32Array(maxEdges)

    this.cKey = new Int32Array(maxNodes)
    this.cNode = new Int32Array(maxNodes)
    this.cNext = new Int32Array(maxNodes)

    const depth = this.cfg.maxDepth + 2
    this.pathTime = new Int32Array(depth * TS_SIZE)
    this.pathNode = new Int32Array(depth)
    this.pathEdgeB = new Int32Array(depth)
    this.pathEdgeW = new Int32Array(depth)
    this.pathUndoCount = new Int32Array(depth)
    this.pathUndoCells = new Int32Array(depth * 2)
    this.pathUndoColors = new Int32Array(depth * 2)
    this.pathUndoFlips = new Int32Array(depth * 2)
  }

  get config(): MctsConfig {
    return this.cfg
  }

  /** 自己対戦の序盤だけ抽選にする（多様性を入れる）ため、途中で変えられるようにする */
  setTemperature(value: number): void {
    this.cfg.temperature = value
  }

  get lastStats(): MctsSearchStats {
    return this.stats
  }

  /** 直前の探索の root 訪問分布（自己対戦の Policy Target 用） */
  readonly rootActions = new Int32Array(MAX_ACTIONS)
  readonly rootVisits = new Int32Array(MAX_ACTIONS)
  /** 直前の探索の root 各手の平均価値と事前確率（調査用） */
  readonly rootQ = new Float32Array(MAX_ACTIONS)
  readonly rootPrior = new Float32Array(MAX_ACTIONS)
  rootActionCount = 0

  private reset(): void {
    this.nodeCount = 0
    this.edgeCount = 0
    this.childCount = 0
    this.stats.simulations = 0
    this.stats.nodes = 0
    this.stats.rootValue = 0
    this.stats.maxDepthReached = 0
    this.stats.aborted = 0
  }

  private allocNode(): number {
    if (this.nodeCount >= this.maxNodes) return -1
    const n = this.nodeCount
    this.nodeCount += 1
    this.nVisits[n] = 0
    this.nValueSum[n] = 0
    this.nEdgeStart[n] = -1
    this.nEdgeCount[n * 2] = 0
    this.nEdgeCount[n * 2 + 1] = 0
    this.nReadyMask[n] = 0
    this.nTerminal[n] = 0
    this.nTerminalValue[n] = 0
    this.nFirstChild[n] = -1
    return n
  }

  /** ready な側ごとに行動と事前確率を並べる */
  private expand(node: number, match: FastMatch): void {
    const out = match.out
    let mask = 0
    if (out[OUT_CAN_ACT + SIDE_BLACK] === 1 && out[OUT_THINK_READY + SIDE_BLACK] === 1) {
      mask |= READY_BLACK
    }
    if (out[OUT_CAN_ACT + SIDE_WHITE] === 1 && out[OUT_THINK_READY + SIDE_WHITE] === 1) {
      mask |= READY_WHITE
    }
    this.nReadyMask[node] = mask
    this.nEdgeStart[node] = this.edgeCount

    for (const side of [SIDE_BLACK, SIDE_WHITE]) {
      const readyBit = side === SIDE_BLACK ? READY_BLACK : READY_WHITE
      if ((mask & readyBit) === 0) {
        this.nEdgeCount[node * 2 + side] = 0
        continue
      }
      let count = listLegalActions(match, side, this.actionBuf)
      // 無操作タイマーが切れている側は待機できない（ルール上ランダム着手が入る）。
      // ここで WAIT を許すと探索の中だけ「無料で何もしない手」が生まれ、
      // 探索量を増やすほど MCTS がそのモデル誤差を突いて弱くなる
      const waitAllowed = side === this.searchSide ? this.cfg.allowWait : this.cfg.allowOpponentWait
      if (waitAllowed && out[OUT_IDLE_READY + side] === 0) {
        this.actionBuf[count] = WAIT_ACTION
        count += 1
      }
      if (count === 0) {
        // 合法手がない、または待機できないのに置く手もない。待機だけ入れる
        this.actionBuf[0] = WAIT_ACTION
        count = 1
      }
      if (this.edgeCount + count > this.eAction.length) {
        // 辺の上限。以後はこのノードを葉として扱う
        this.nEdgeCount[node * 2 + side] = 0
        continue
      }
      this.policy(match, side, this.actionBuf, count, this.priorBuf)

      const start = this.edgeCount
      for (let k = 0; k < count; k += 1) {
        const e = start + k
        this.eAction[e] = this.actionBuf[k]!
        this.eVisits[e] = 0
        this.eValueSum[e] = 0
        this.ePrior[e] = this.priorBuf[k]!
      }
      this.edgeCount = start + count
      this.nEdgeCount[node * 2 + side] = count
    }
  }

  private edgeBase(node: number, side: number): number {
    const start = this.nEdgeStart[node]!
    return side === SIDE_BLACK ? start : start + this.nEdgeCount[node * 2]!
  }

  /** PUCT で side の行動を 1 つ選び、辺の添字を返す */
  private selectEdge(node: number, side: number): number {
    const count = this.nEdgeCount[node * 2 + side]!
    const base = this.edgeBase(node, side)
    if (count === 1) return base

    let totalVisits = 0
    for (let k = 0; k < count; k += 1) totalVisits += this.eVisits[base + k]!
    const sqrtTotal = Math.sqrt(Math.max(1, totalVisits))

    // 未訪問手の初期値は「この側から見た現在の推定値 - fpu」
    const nodeVisits = this.nVisits[node]!
    const blackMean = nodeVisits > 0 ? this.nValueSum[node]! / nodeVisits : 0
    const ownMean = side === SIDE_BLACK ? blackMean : -blackMean
    const fpu = ownMean - this.cfg.fpuReduction

    let bestEdge = base
    let bestScore = -Infinity
    for (let k = 0; k < count; k += 1) {
      const e = base + k
      const visits = this.eVisits[e]!
      const q = visits > 0 ? this.eValueSum[e]! / visits : fpu
      const u = (this.cfg.cPuct * this.ePrior[e]! * sqrtTotal) / (1 + visits)
      const score = q + u
      if (score > bestScore) {
        bestScore = score
        bestEdge = e
      }
    }
    return bestEdge
  }

  private findChild(node: number, key: number): number {
    for (let c = this.nFirstChild[node]!; c !== -1; c = this.cNext[c]!) {
      if (this.cKey[c] === key) return this.cNode[c]!
    }
    return -1
  }

  private addChild(node: number, key: number, child: number): void {
    if (this.childCount >= this.cKey.length) return
    const c = this.childCount
    this.childCount += 1
    this.cKey[c] = key
    this.cNode[c] = child
    this.cNext[c] = this.nFirstChild[node]!
    this.nFirstChild[node] = c
  }

  private terminalValue(match: FastMatch): number {
    const outcome = outcomeOf(match)
    if (outcome === OUTCOME_BLACK_WIN) return 1
    if (outcome === OUTCOME_WHITE_WIN) return -1
    return 0
  }

  /**
   * 探索して root で選ぶ行動を返す。
   * match は呼び出し時の状態に必ず戻る（盤面も時間状態も）。
   */
  search(match: FastMatch, side: number, rng: Rng): number {
    this.reset()
    this.searchSide = side
    const rootTime = this.rootTime
    const rootOut = this.rootOut
    saveTimeState(match, rootTime)
    // out は時間状態と別なので、探索で上書きした分を必ず戻す
    // （呼び出し側は探索後にもう一方の側の ready 判定を読む）
    rootOut.set(match.out)

    const root = this.allocNode()
    this.expand(root, match)
    if (this.cfg.dirichletWeight > 0 && this.cfg.dirichletAlpha > 0) {
      this.applyDirichlet(root, side, rng)
    }

    for (let sim = 0; sim < this.cfg.simulations; sim += 1) {
      this.simulate(match, root)
      restoreTimeState(match, rootTime)
      // out は applyFastStep が自発WAIT判定に読むので、毎回 root の値へ戻す
      match.out.set(rootOut)
      if (this.nodeCount >= this.maxNodes) break
    }

    restoreTimeState(match, rootTime)
    match.out.set(rootOut)
    this.stats.nodes = this.nodeCount
    const rootVisits = this.nVisits[root]!
    this.stats.rootValue = rootVisits > 0 ? this.nValueSum[root]! / rootVisits : 0

    return this.pickRootAction(root, side, rng)
  }

  private applyDirichlet(root: number, side: number, rng: Rng): void {
    const count = this.nEdgeCount[root * 2 + side]!
    if (count <= 1) return
    const base = this.edgeBase(root, side)
    let sum = 0
    for (let k = 0; k < count; k += 1) {
      const g = sampleGamma(this.cfg.dirichletAlpha, rng)
      this.gammaBuf[k] = g
      sum += g
    }
    if (sum <= 0) return
    const w = this.cfg.dirichletWeight
    for (let k = 0; k < count; k += 1) {
      const noise = this.gammaBuf[k]! / sum
      this.ePrior[base + k] = (1 - w) * this.ePrior[base + k]! + w * noise
    }
  }

  private simulate(match: FastMatch, root: number): void {
    let node = root
    let depth = 0
    let leafValue = 0
    // 経路に積まれていない末端ノード。統計を二重に足さないため別に持つ
    let leafNode = -1

    for (;;) {
      if (depth >= this.cfg.maxDepth) {
        leafValue = this.value(match)
        leafNode = node
        this.stats.aborted += 1
        break
      }

      // 終局していれば確定値
      if (match.ts[TS_PHASE] === PHASE_FINISHED) {
        if (this.nTerminal[node] === 0) {
          this.nTerminal[node] = 1
          this.nTerminalValue[node] = this.terminalValue(match)
        }
        leafValue = this.nTerminalValue[node]!
        leafNode = node
        break
      }

      // 展開されていなければここが葉
      if (this.nEdgeStart[node] === -1) {
        this.expand(node, match)
        leafValue = this.value(match)
        leafNode = node
        break
      }

      const countB = this.nEdgeCount[node * 2 + SIDE_BLACK]!
      const countW = this.nEdgeCount[node * 2 + SIDE_WHITE]!
      if (countB === 0 && countW === 0) {
        // 辺を確保できなかったノード。ここで打ち切る
        leafValue = this.value(match)
        leafNode = node
        break
      }
      const edgeB = countB > 0 ? this.selectEdge(node, SIDE_BLACK) : -1
      const edgeW = countW > 0 ? this.selectEdge(node, SIDE_WHITE) : -1
      const actionB = edgeB >= 0 ? this.eAction[edgeB]! : WAIT_ACTION
      const actionW = edgeW >= 0 ? this.eAction[edgeW]! : WAIT_ACTION

      // 経路を積む
      const slot = depth
      saveTimeState(match, this.pathTime, slot * TS_SIZE)
      this.pathNode[slot] = node
      this.pathEdgeB[slot] = edgeB
      this.pathEdgeW[slot] = edgeW

      applyFastStep(match, actionB, actionW)
      this.pathUndoCount[slot] = lastStepUndo.count
      for (let k = 0; k < lastStepUndo.count; k += 1) {
        this.pathUndoCells[slot * 2 + k] = lastStepUndo.cells[k]!
        this.pathUndoColors[slot * 2 + k] = lastStepUndo.colors[k]!
        this.pathUndoFlips[slot * 2 + k] = lastStepUndo.flips[k]!
      }
      advanceToDecision(match)

      depth += 1
      if (depth > this.stats.maxDepthReached) this.stats.maxDepthReached = depth

      const key = actionB * MAX_ACTIONS + actionW
      let child = this.findChild(node, key)
      if (child === -1) {
        child = this.allocNode()
        if (child === -1) {
          // ノード上限。この段の親までを更新して打ち切る
          leafValue = this.value(match)
          leafNode = -1
          break
        }
        this.addChild(node, key, child)
      }
      node = child
    }

    if (leafNode >= 0) {
      this.nVisits[leafNode] += 1
      this.nValueSum[leafNode] += leafValue
    }

    // 逆伝播しながら盤面を戻す
    for (let slot = depth - 1; slot >= 0; slot -= 1) {
      undoAppliedMoves(
        match,
        this.pathUndoCount[slot]!,
        this.pathUndoCells,
        this.pathUndoColors,
        this.pathUndoFlips,
        slot * 2,
      )
      restoreTimeState(match, this.pathTime, slot * TS_SIZE)
      const n = this.pathNode[slot]!
      this.nVisits[n] += 1
      this.nValueSum[n] += leafValue
      const eb = this.pathEdgeB[slot]!
      if (eb >= 0) {
        this.eVisits[eb] += 1
        this.eValueSum[eb] += leafValue
      }
      const ew = this.pathEdgeW[slot]!
      if (ew >= 0) {
        this.eVisits[ew] += 1
        this.eValueSum[ew] -= leafValue
      }
    }

    // 葉ノード自身の統計（経路の外側）
    this.stats.simulations += 1
  }

  private pickRootAction(root: number, side: number, rng: Rng): number {
    const count = this.nEdgeCount[root * 2 + side]!
    this.rootActionCount = 0
    if (count === 0) return WAIT_ACTION
    const base = this.edgeBase(root, side)

    for (let k = 0; k < count; k += 1) {
      const e = base + k
      const visits = this.eVisits[e]!
      this.rootActions[k] = this.eAction[e]!
      this.rootVisits[k] = visits
      this.rootQ[k] = visits > 0 ? this.eValueSum[e]! / visits : NaN
      this.rootPrior[k] = this.ePrior[e]!
    }
    this.rootActionCount = count

    const temperature = this.cfg.temperature
    if (temperature <= 0) {
      let bestAction = this.eAction[base]!
      let bestVisits = -1
      let bestValue = -Infinity
      for (let k = 0; k < count; k += 1) {
        const e = base + k
        const visits = this.eVisits[e]!
        const value = visits > 0 ? this.eValueSum[e]! / visits : -Infinity
        if (visits > bestVisits || (visits === bestVisits && value > bestValue)) {
          bestVisits = visits
          bestValue = value
          bestAction = this.eAction[e]!
        }
      }
      return bestAction
    }

    // 訪問数^(1/T) の抽選（自己対戦の序盤に多様性を入れる）
    const inv = 1 / temperature
    let total = 0
    for (let k = 0; k < count; k += 1) {
      const w = Math.pow(this.eVisits[base + k]!, inv)
      this.gammaBuf[k] = w
      total += w
    }
    if (total <= 0) return this.eAction[base + rng.nextInt(0, count)]!
    let r = rng.next() * total
    for (let k = 0; k < count; k += 1) {
      r -= this.gammaBuf[k]!
      if (r <= 0) return this.eAction[base + k]!
    }
    return this.eAction[base + count - 1]!
  }
}

/** Marsaglia–Tsang 法。Dirichlet ノイズ用 */
function sampleGamma(alpha: number, rng: Rng): number {
  if (alpha < 1) {
    const u = rng.next()
    return sampleGamma(alpha + 1, rng) * Math.pow(u === 0 ? 1e-12 : u, 1 / alpha)
  }
  const d = alpha - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x = 0
    let v = 0
    do {
      x = gaussian(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng.next()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u === 0 ? 1e-12 : u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v
    }
  }
}

function gaussian(rng: Rng): number {
  let u = rng.next()
  let v = rng.next()
  if (u === 0) u = 1e-12
  if (v === 0) v = 1e-12
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
