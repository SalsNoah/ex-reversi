/**
 * 一般的なオセロ戦略に沿った静的評価。
 *
 * 採用した考え方:
 * - 角は最優先（返らない石の起点になる）
 * - 確定石を増やし、相手の確定石を減らす
 * - 着手可能数で相手の選択肢を狭める
 * - 開放度（相手の石に接する空きマス＝将来の自分の手）を確保する
 * - 角が空いているうちの X 打ち・C 打ちは大きな損
 * - 石数は序盤ほど無価値。終盤だけ重くする
 * - ただし石を減らしすぎると全滅で即負け。残り少ない側を強く嫌う
 * - 偶数理論は最後の 1 手を取りやすい側へ小さな加点
 *
 * 重みは石数ごとに前計算した表から引く（葉で毎回補間しない）。
 */
import {
  BLACK,
  DIRS,
  EMPTY_HEAD,
  N,
  WHITE,
  cellIndex,
  type FastPosition,
} from './fastBoard.ts'
import { countStable } from './stability.ts'

const CELLS_TOTAL = N * N
const START_DISCS = 16

const CORNERS = new Int32Array([
  cellIndex(0, 0),
  cellIndex(0, N - 1),
  cellIndex(N - 1, 0),
  cellIndex(N - 1, N - 1),
])

/** 角に対応する X 打ち（角の斜め内側） */
const X_SQUARES = new Int32Array([
  cellIndex(1, 1),
  cellIndex(1, N - 2),
  cellIndex(N - 2, 1),
  cellIndex(N - 2, N - 2),
])

/** 角に対応する C 打ち（角の辺隣り）。角ごとに 2 マス */
const C_SQUARES = new Int32Array([
  cellIndex(0, 1),
  cellIndex(1, 0),
  cellIndex(0, N - 2),
  cellIndex(1, N - 1),
  cellIndex(N - 1, 1),
  cellIndex(N - 2, 0),
  cellIndex(N - 1, N - 2),
  cellIndex(N - 2, N - 1),
])

/** 角・C 打ちを除いた辺のマス */
const PLAIN_EDGES = buildPlainEdges()

function buildPlainEdges(): Int32Array {
  const list: number[] = []
  for (let k = 2; k <= N - 3; k += 1) {
    list.push(cellIndex(0, k))
    list.push(cellIndex(N - 1, k))
    list.push(cellIndex(k, 0))
    list.push(cellIndex(k, N - 1))
  }
  return new Int32Array(list)
}

export type PhaseWeights = {
  corner: number
  stable: number
  mobility: number
  potential: number
  xSquare: number
  cSquare: number
  edge: number
  disc: number
  parity: number
}

/** 序盤（石 16 枚） */
const OPENING: PhaseWeights = {
  corner: 230,
  stable: 26,
  mobility: 400,
  potential: 170,
  xSquare: 115,
  cSquare: 38,
  edge: 6,
  disc: 1,
  parity: 0,
}

/** 中盤（石 58 枚前後） */
const MIDGAME: PhaseWeights = {
  corner: 190,
  stable: 44,
  mobility: 300,
  potential: 110,
  xSquare: 90,
  cSquare: 30,
  edge: 9,
  disc: 4,
  parity: 6,
}

/** 終盤（石 100 枚） */
const ENDGAME: PhaseWeights = {
  corner: 130,
  stable: 62,
  mobility: 90,
  potential: 25,
  xSquare: 25,
  cSquare: 8,
  edge: 5,
  disc: 24,
  parity: 14,
}

/**
 * 全滅の危険。石が 0 枚になった側は打つ手も返す石もなくなり、その場で負ける。
 *
 * 石を減らす打ち方自体はオセロの基本なので、ここで嫌うのは
 * 「本当に消えかけている形」だけにする。確定石が 1 つでもあれば
 * その石は二度と返らない＝全滅はありえないので、危険度は 0。
 * 確定石がないまま残り数個まで減った側だけを、石差とは別に強く嫌う。
 *
 * 境目（`survivalFloor`）と重みは差し替えられる。速い相手にはこの境目が
 * 遅すぎて間に合わないので、上げる案を測った。弱い相手（最速の `max_flip`）には
 * 56.7%→86.7% と効くが、強い相手（GA 第100世代）には 100%→18.3% と崩れる。
 * 石を減らして相手を手詰まりにする指し方を封じてしまうため。
 * 差し替えの窓口だけ残してあり、既定は 6 枚未満（docs/strategy-ai.md「速い相手への穴」）。
 */
const SURVIVAL_FLOOR = 6
const SURVIVAL_WEIGHT = 300

/**
 * 全滅までの余裕。「相手の 1 手で返される自分の石の最大枚数」を実際に数え、
 * 自分の石数との差を見る。差 0 なら**相手が今すぐ全滅させられる**。
 *
 * 上の `survivalRisk` は石数という代理指標で危険を測っている。石が少ないこと
 * 自体は危険ではない（角に確定石が 1 つあれば石 2 枚でも安全）し、逆に
 * 石が 10 枚あっても 1 か所で全部返るなら危ない。ここでは実際の形を見る。
 *
 * 石数の代理指標で測って対策した版は、弱い相手に効いて強い相手に崩れた
 * （docs/strategy-ai.md「速い相手への穴」）。そこで指標を実物に替えた。
 *
 * 読みの地平線を 1 手ぶん伸ばすのが狙い。相手が自分より多く打てるこのゲームでは、
 * 全滅は読み切れる手前で起きる。余裕 1〜2 枚も、相手がもう 1 手打てば 0 になるので嫌う。
 */
const WIPEOUT_MARGIN = 3
const WIPEOUT_WEIGHT = 1_200
/**
 * ここまで石が減っている側だけ数える。
 * 数える色については `scanLeaf` が打ち切れなくなるので、葉が重くなる。
 */
const WIPEOUT_SCAN_MAX = 10

const TABLE_SIZE = CELLS_TOTAL - START_DISCS + 1

/**
 * 石数ごとに引ける重み表。葉で補間しないための前計算。
 *
 * 調整や各項の効き方を測るために差し替えられるようにしているが、
 * 葉の読み出しは固定の配列のままにしたいので、
 * 使うときに `applyWeights` で中身を写す（1 回の探索につき 1 回）。
 */
export type WeightTables = {
  corner: Float64Array
  stable: Float64Array
  mobility: Float64Array
  potential: Float64Array
  xSquare: Float64Array
  cSquare: Float64Array
  edge: Float64Array
  disc: Float64Array
  parity: Float64Array
  survival: number
  survivalFloor: number
  wipeout: number
}

export type WeightSpec = {
  opening: PhaseWeights
  midgame: PhaseWeights
  endgame: PhaseWeights
  survival: number
  /** これより石が少ないと全滅の危険として嫌う。省略時は既定 */
  survivalFloor?: number
  /** 相手の 1 手で全部返る形への罰。省略時は既定 */
  wipeout?: number
}

const wCorner = new Float64Array(TABLE_SIZE)
const wStable = new Float64Array(TABLE_SIZE)
const wMobility = new Float64Array(TABLE_SIZE)
const wPotential = new Float64Array(TABLE_SIZE)
const wXSquare = new Float64Array(TABLE_SIZE)
const wCSquare = new Float64Array(TABLE_SIZE)
const wEdge = new Float64Array(TABLE_SIZE)
const wDisc = new Float64Array(TABLE_SIZE)
const wParity = new Float64Array(TABLE_SIZE)
let wSurvival = 0
let wSurvivalFloor = SURVIVAL_FLOOR
let wWipeout = 0

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function buildPhaseTable(
  spec: WeightSpec,
  key: keyof PhaseWeights,
): Float64Array {
  const table = new Float64Array(TABLE_SIZE)
  for (let i = 0; i < TABLE_SIZE; i += 1) {
    const progress = i / (TABLE_SIZE - 1)
    table[i] =
      progress < 0.5
        ? lerp(spec.opening[key], spec.midgame[key], progress * 2)
        : lerp(spec.midgame[key], spec.endgame[key], (progress - 0.5) * 2)
  }
  return table
}

export function buildWeightTables(spec: WeightSpec): WeightTables {
  return {
    corner: buildPhaseTable(spec, 'corner'),
    stable: buildPhaseTable(spec, 'stable'),
    mobility: buildPhaseTable(spec, 'mobility'),
    potential: buildPhaseTable(spec, 'potential'),
    xSquare: buildPhaseTable(spec, 'xSquare'),
    cSquare: buildPhaseTable(spec, 'cSquare'),
    edge: buildPhaseTable(spec, 'edge'),
    disc: buildPhaseTable(spec, 'disc'),
    parity: buildPhaseTable(spec, 'parity'),
    survival: spec.survival,
    survivalFloor: spec.survivalFloor ?? SURVIVAL_FLOOR,
    wipeout: spec.wipeout ?? WIPEOUT_WEIGHT,
  }
}

export const DEFAULT_WEIGHT_SPEC: WeightSpec = {
  opening: OPENING,
  midgame: MIDGAME,
  endgame: ENDGAME,
  survival: SURVIVAL_WEIGHT,
}

export const DEFAULT_WEIGHTS = buildWeightTables(DEFAULT_WEIGHT_SPEC)

let activeWeights: WeightTables | null = null

/** 探索の前に 1 回だけ呼ぶ。葉から見える重みを差し替える */
export function applyWeights(tables: WeightTables): void {
  if (activeWeights === tables) return
  activeWeights = tables
  wCorner.set(tables.corner)
  wStable.set(tables.stable)
  wMobility.set(tables.mobility)
  wPotential.set(tables.potential)
  wXSquare.set(tables.xSquare)
  wCSquare.set(tables.cSquare)
  wEdge.set(tables.edge)
  wDisc.set(tables.disc)
  wParity.set(tables.parity)
  wSurvival = tables.survival
  wSurvivalFloor = tables.survivalFloor
  wWipeout = tables.wipeout
}

applyWeights(DEFAULT_WEIGHTS)

/** 石数から重み表の添字へ。0 が開始局面、末尾が満局 */
export function weightSlot(pos: FastPosition): number {
  const slot = pos.black + pos.white - START_DISCS
  if (slot < 0) return 0
  if (slot >= TABLE_SIZE) return TABLE_SIZE - 1
  return slot
}

export function phaseWeightsAt(slot: number): PhaseWeights {
  return {
    corner: wCorner[slot],
    stable: wStable[slot],
    mobility: wMobility[slot],
    potential: wPotential[slot],
    xSquare: wXSquare[slot],
    cSquare: wCSquare[slot],
    edge: wEdge[slot],
    disc: wDisc[slot],
    parity: wParity[slot],
  }
}

export type LeafScan = {
  blackMobility: number
  whiteMobility: number
  /** 黒が将来打ちうる空きマス数＝白石に接する空き */
  blackPotential: number
  whitePotential: number
  /**
   * 白の 1 手で返される黒石の最大枚数。全滅の余裕を見るときだけ数える
   * （石が `WIPEOUT_SCAN_MAX` 以下の側だけ）。数えていないときは 0。
   */
  maxBlackFlips: number
  /** 黒の 1 手で返される白石の最大枚数 */
  maxWhiteFlips: number
}

const scan: LeafScan = {
  blackMobility: 0,
  whiteMobility: 0,
  blackPotential: 0,
  whitePotential: 0,
  maxBlackFlips: 0,
  maxWhiteFlips: 0,
}

/**
 * 空きマスを 1 周するだけで、双方の着手可能数と開放度をまとめて取る。
 * 葉での最大コストなので、方向ごとの走査は 1 回に抑え、
 * 全部わかった時点で打ち切る。
 *
 * 石が減っている側については「相手の 1 手で返される最大枚数」も一緒に数える。
 * この走査は方向ごとに「同色の連なりとその先の色」をすでに見ているので、
 * 数えるのに要るのは連なりの長さを足すことだけ。別の周回は増やさない。
 * 代わりに、その色については打てると分かった時点で打ち切れなくなる。
 */
export function scanLeaf(pos: FastPosition): LeafScan {
  const cells = pos.cells
  const next = pos.emptyNext
  const adjacent = pos.adjacent
  let blackMobility = 0
  let whiteMobility = 0
  let blackPotential = 0
  let whitePotential = 0

  const countBlackFlips = wWipeout !== 0 && pos.black <= WIPEOUT_SCAN_MAX
  const countWhiteFlips = wWipeout !== 0 && pos.white <= WIPEOUT_SCAN_MAX
  const canStopEarly = !countBlackFlips && !countWhiteFlips
  let maxBlackFlips = 0
  let maxWhiteFlips = 0

  for (let i = next[EMPTY_HEAD]; i !== EMPTY_HEAD; i = next[i]) {
    // 石に接していないマスは、着手も開放度も生まない
    if (adjacent[i] === 0) continue
    let legalBlack = false
    let legalWhite = false
    let touchesBlack = false
    let touchesWhite = false
    let blackFlips = 0
    let whiteFlips = 0

    for (let d = 0; d < 8; d += 1) {
      const dir = DIRS[d]
      const neighbor = cells[i + dir]
      if (neighbor === BLACK) {
        touchesBlack = true
        if (countBlackFlips) {
          let j = i + dir
          let run = 0
          do {
            run += 1
            j += dir
          } while (cells[j] === BLACK)
          if (cells[j] === WHITE) {
            legalWhite = true
            blackFlips += run
          }
        } else if (!legalWhite) {
          let j = i + dir
          do {
            j += dir
          } while (cells[j] === BLACK)
          if (cells[j] === WHITE) {
            legalWhite = true
            if (legalBlack && canStopEarly) break
          }
        }
      } else if (neighbor === WHITE) {
        touchesWhite = true
        if (countWhiteFlips) {
          let j = i + dir
          let run = 0
          do {
            run += 1
            j += dir
          } while (cells[j] === WHITE)
          if (cells[j] === BLACK) {
            legalBlack = true
            whiteFlips += run
          }
        } else if (!legalBlack) {
          let j = i + dir
          do {
            j += dir
          } while (cells[j] === WHITE)
          if (cells[j] === BLACK) {
            legalBlack = true
            if (legalWhite && canStopEarly) break
          }
        }
      }
    }

    if (legalBlack) {
      blackMobility += 1
      // 白を挟めた＝白に接しているので、開放度も確定する
      touchesWhite = true
    }
    if (legalWhite) {
      whiteMobility += 1
      touchesBlack = true
    }
    if (touchesWhite) blackPotential += 1
    if (touchesBlack) whitePotential += 1
    if (blackFlips > maxBlackFlips) maxBlackFlips = blackFlips
    if (whiteFlips > maxWhiteFlips) maxWhiteFlips = whiteFlips
  }

  scan.blackMobility = blackMobility
  scan.whiteMobility = whiteMobility
  scan.blackPotential = blackPotential
  scan.whitePotential = whitePotential
  scan.maxBlackFlips = maxBlackFlips
  scan.maxWhiteFlips = maxWhiteFlips
  return scan
}

/** 勝敗が確定した局面の基準点。静的評価より必ず大きくする */
export const WIN_SCORE = 1_000_000
const DISC_SCALE = 1000

function survivalRisk(discs: number, stable: number): number {
  if (stable > 0 || discs >= wSurvivalFloor) return 0
  const gap = wSurvivalFloor - discs
  return gap * gap
}

/**
 * 全滅までの余裕が小さい形への危険度。石数ではなく実際の反転で測る。
 * `maxFlips` は `scanLeaf` が数えた「相手の 1 手で返される最大枚数」。
 * 確定石が 1 つでもあればその石は返らないので、全滅はありえず 0。
 */
function wipeoutRisk(
  discs: number,
  stable: number,
  maxFlips: number,
): number {
  if (wWipeout === 0 || stable > 0 || discs > WIPEOUT_SCAN_MAX) return 0
  const margin = discs - maxFlips
  if (margin >= WIPEOUT_MARGIN) return 0
  const gap = WIPEOUT_MARGIN - margin
  return gap * gap
}

/** 終局した盤面の点数。勝敗を最優先し、石差で細かく順位を付ける */
export function terminalScore(pos: FastPosition, me: number): number {
  const diff = me === BLACK ? pos.black - pos.white : pos.white - pos.black
  if (diff > 0) return WIN_SCORE + diff * DISC_SCALE
  if (diff < 0) return -WIN_SCORE + diff * DISC_SCALE
  return 0
}

/**
 * 葉の点数。双方に合法手がなければ終局として扱う。
 * scanLeaf を 1 回だけ回すため、終局判定と静的評価をここでまとめる。
 */
export function evaluateLeaf(
  pos: FastPosition,
  me: number,
  selfTurn: boolean,
): number {
  if (pos.emptyCount === 0) return terminalScore(pos, me)
  const leaf = scanLeaf(pos)
  if (leaf.blackMobility === 0 && leaf.whiteMobility === 0) {
    return terminalScore(pos, me)
  }
  return evaluateFromScan(pos, me, selfTurn, leaf)
}

/** me 視点の静的評価（整数）。selfTurn は偶数理論にだけ使う */
export function evaluate(
  pos: FastPosition,
  me: number,
  selfTurn: boolean,
): number {
  return evaluateFromScan(pos, me, selfTurn, scanLeaf(pos))
}

function evaluateFromScan(
  pos: FastPosition,
  me: number,
  selfTurn: boolean,
  leaf: LeafScan,
): number {
  const cells = pos.cells
  const opp = me ^ 3
  const slot = weightSlot(pos)
  const black = me === BLACK

  const myMobility = black ? leaf.blackMobility : leaf.whiteMobility
  const oppMobility = black ? leaf.whiteMobility : leaf.blackMobility
  const myPotential = black ? leaf.blackPotential : leaf.whitePotential
  const oppPotential = black ? leaf.whitePotential : leaf.blackPotential

  const mobilityTerm =
    (myMobility - oppMobility) / (myMobility + oppMobility + 2)
  const potentialTerm =
    (myPotential - oppPotential) / (myPotential + oppPotential + 2)

  let cornerDiff = 0
  let xTerm = 0
  let cTerm = 0
  for (let k = 0; k < 4; k += 1) {
    const corner = cells[CORNERS[k]]
    if (corner === me) {
      cornerDiff += 1
      continue
    }
    if (corner === opp) {
      cornerDiff -= 1
      continue
    }
    // 角が空いている間だけ X 打ち・C 打ちは危険
    const x = cells[X_SQUARES[k]]
    if (x === me) xTerm -= 1
    else if (x === opp) xTerm += 1

    const c0 = cells[C_SQUARES[k * 2]]
    if (c0 === me) cTerm -= 1
    else if (c0 === opp) cTerm += 1
    const c1 = cells[C_SQUARES[k * 2 + 1]]
    if (c1 === me) cTerm -= 1
    else if (c1 === opp) cTerm += 1
  }

  let edgeDiff = 0
  for (let k = 0; k < PLAIN_EDGES.length; k += 1) {
    const cell = cells[PLAIN_EDGES[k]]
    if (cell === me) edgeDiff += 1
    else if (cell === opp) edgeDiff -= 1
  }

  const stable = countStable(pos)
  const myStable = black ? stable.black : stable.white
  const oppStable = black ? stable.white : stable.black
  const stableDiff = myStable - oppStable
  const myDiscs = black ? pos.black : pos.white
  const oppDiscs = black ? pos.white : pos.black
  const discDiff = myDiscs - oppDiscs
  const survivalTerm =
    survivalRisk(oppDiscs, oppStable) - survivalRisk(myDiscs, myStable)
  const myFlips = black ? leaf.maxBlackFlips : leaf.maxWhiteFlips
  const oppFlips = black ? leaf.maxWhiteFlips : leaf.maxBlackFlips
  const wipeoutTerm =
    wipeoutRisk(oppDiscs, oppStable, oppFlips) -
    wipeoutRisk(myDiscs, myStable, myFlips)

  // 空きが奇数で自分の手番なら最後の 1 手を取りやすい
  const parity = ((pos.emptyCount & 1) === 1) === selfTurn ? 1 : -1

  const score =
    wCorner[slot] * cornerDiff +
    wStable[slot] * stableDiff +
    wMobility[slot] * mobilityTerm +
    wPotential[slot] * potentialTerm +
    wXSquare[slot] * xTerm +
    wCSquare[slot] * cTerm +
    wEdge[slot] * edgeDiff +
    wDisc[slot] * discDiff +
    wParity[slot] * parity +
    wSurvival * survivalTerm +
    wWipeout * wipeoutTerm

  return Math.round(score)
}

export type EvaluationDetail = {
  cornerDiff: number
  stableDiff: number
  mobility: { mine: number; theirs: number }
  potential: { mine: number; theirs: number }
  discDiff: number
  score: number
}

/** 説明・テスト用。葉では使わない */
export function evaluateDetailed(
  pos: FastPosition,
  me: number,
  selfTurn: boolean,
): EvaluationDetail {
  const leaf = scanLeaf(pos)
  const black = me === BLACK
  const opp = me ^ 3
  const cells = pos.cells
  let cornerDiff = 0
  for (let k = 0; k < 4; k += 1) {
    const corner = cells[CORNERS[k]]
    if (corner === me) cornerDiff += 1
    else if (corner === opp) cornerDiff -= 1
  }
  const stable = countStable(pos)
  return {
    cornerDiff,
    stableDiff: black
      ? stable.black - stable.white
      : stable.white - stable.black,
    mobility: {
      mine: black ? leaf.blackMobility : leaf.whiteMobility,
      theirs: black ? leaf.whiteMobility : leaf.blackMobility,
    },
    potential: {
      mine: black ? leaf.blackPotential : leaf.whitePotential,
      theirs: black ? leaf.whitePotential : leaf.blackPotential,
    },
    discDiff: black ? pos.black - pos.white : pos.white - pos.black,
    score: evaluate(pos, me, selfTurn),
  }
}
