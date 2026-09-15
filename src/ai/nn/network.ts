/**
 * Policy / Value ネットワーク（純 TypeScript・typed array）。
 *
 * GPU が無い環境なので、畳み込みは捨てて疎入力の全結合にした。
 * 実測（tmp-nnbench）では畳み込みは 0.1〜0.4k evals/s しか出ず MCTS に載らない。
 * 疎入力の全結合なら 0.5 GMAC/s 出るので、1 手 256 シミュレーションが現実的になる。
 *
 *   疎な盤面特徴 + 連続な時間特徴
 *     → h1 (ReLU) → h2 (ReLU)
 *        ├─ Policy: 合法手ぶんだけロジットを計算し、そこで softmax
 *        └─ Value : 小さな隠れ層 → tanh（自分視点の期待勝敗 [-1, 1]）
 *
 * Policy は「合法手だけ」を計算する。全 101 個を出してからマスクするのと
 * 数学的に同じで、実測 10 手前後なので前向き計算が桁で軽くなる。
 *
 * 価値は必ず「符号化した側から見た値」。呼び出し側が黒視点へ直す。
 */
import { createRng, type Rng } from '../../game/rng.ts'
import { ACTION_SPACE_SIZE } from '../../sim/constants.ts'
import { DENSE_FEATURE_COUNT, SPARSE_FEATURE_COUNT } from './features.ts'

export type NetShape = {
  hidden1: number
  hidden2: number
  valueHidden: number
}

export const DEFAULT_SHAPE: NetShape = {
  hidden1: 192,
  hidden2: 64,
  valueHidden: 32,
}

/** 重みの並び。1 本の Float32Array に詰めて Adam を 1 ループで回す */
type Layout = {
  w1s: number
  w1d: number
  b1: number
  w2: number
  b2: number
  wp: number
  bp: number
  wv1: number
  bv1: number
  wv2: number
  bv2: number
  total: number
}

/**
 * 前向き計算を速くするための並び。
 *
 * 1 層目と 2 層目は「入力ごとに隠れ全体へ足し込む」ので入力主体 [in][out]、
 * 出力側の 2 つは「出力ごとに入力全体を畳み込む」ので出力主体 [out][in] にする。
 * どちらも内側ループが連続アクセスになる並び。
 *
 * 加えて 1 層目・2 層目は出力を 16 本ずつローカル変数に貯める
 * （= 1 反復でキャッシュライン 1 本ぶんだけ触る）。
 * 実測（tmp-l1bench）で Float32Array へ足し込む書き方の 1.5 倍出た。
 */
export const BLOCK = 16

function buildLayout(shape: NetShape): Layout {
  const { hidden1: h1, hidden2: h2, valueHidden: vh } = shape
  if (h1 % BLOCK !== 0 || h2 % BLOCK !== 0) {
    throw new Error(`hidden sizes must be multiples of ${BLOCK}`)
  }
  let at = 0
  const take = (n: number): number => {
    const start = at
    at += n
    return start
  }
  return {
    w1s: take(SPARSE_FEATURE_COUNT * h1),
    w1d: take(DENSE_FEATURE_COUNT * h1),
    b1: take(h1),
    w2: take(h1 * h2),
    b2: take(h2),
    wp: take(ACTION_SPACE_SIZE * h2),
    bp: take(ACTION_SPACE_SIZE),
    wv1: take(vh * h2),
    bv1: take(vh),
    wv2: take(vh),
    bv2: take(1),
    total: at,
  }
}

export type SerializedNetwork = {
  v: 1
  shape: NetShape
  /** Float32Array を base64 にしたもの */
  params: string
  steps: number
}

export class PvNetwork {
  readonly shape: NetShape
  private readonly lay: Layout
  readonly params: Float32Array

  // 学習用（推論だけなら確保しない）
  private grad: Float32Array | null = null
  private adamM: Float32Array | null = null
  private adamV: Float32Array | null = null
  private adamSteps = 0

  // 前向き計算の中間結果（1 サンプルぶん）
  private z1: Float32Array
  private h1: Float32Array
  private z2: Float32Array
  private h2: Float32Array
  private zv: Float32Array
  private hv: Float32Array
  private lastValue = 0
  /** ReLU を通った隠れ素子の添字。2 層目でゼロ入力を飛ばすのに使う */
  private activeH1: Int32Array
  private activeH1Count = 0

  // 逆伝播の作業領域
  private dh1: Float32Array
  private dh2: Float32Array
  private dhv: Float32Array

  constructor(shape: NetShape = DEFAULT_SHAPE, params?: Float32Array) {
    this.shape = shape
    this.lay = buildLayout(shape)
    this.params = params ?? new Float32Array(this.lay.total)
    this.z1 = new Float32Array(shape.hidden1)
    this.h1 = new Float32Array(shape.hidden1)
    this.z2 = new Float32Array(shape.hidden2)
    this.h2 = new Float32Array(shape.hidden2)
    this.zv = new Float32Array(shape.valueHidden)
    this.hv = new Float32Array(shape.valueHidden)
    this.activeH1 = new Int32Array(shape.hidden1)
    this.dh1 = new Float32Array(shape.hidden1)
    this.dh2 = new Float32Array(shape.hidden2)
    this.dhv = new Float32Array(shape.valueHidden)
  }

  get parameterCount(): number {
    return this.lay.total
  }

  get trainSteps(): number {
    return this.adamSteps
  }

  /**
   * 初期値。出力層は 0 にして、学習前のネットが
   * 「一様な事前確率 + 価値 0」になるようにする（探索が暴れない）。
   */
  static createInitial(seed: number, shape: NetShape = DEFAULT_SHAPE): PvNetwork {
    const net = new PvNetwork(shape)
    const rng = createRng(seed)
    const p = net.params
    const lay = net.lay
    // 1 層目は「立っている特徴の数」が実効の入力次元（実測 70 前後）
    fillGaussian(p, lay.w1s, SPARSE_FEATURE_COUNT * shape.hidden1, Math.sqrt(1 / 70), rng)
    fillGaussian(
      p,
      lay.w1d,
      DENSE_FEATURE_COUNT * shape.hidden1,
      Math.sqrt(1 / DENSE_FEATURE_COUNT),
      rng,
    )
    fillGaussian(p, lay.w2, shape.hidden1 * shape.hidden2, Math.sqrt(2 / shape.hidden1), rng)
    fillGaussian(p, lay.wv1, shape.valueHidden * shape.hidden2, Math.sqrt(2 / shape.hidden2), rng)
    return net
  }

  // --- 前向き ---------------------------------------------------------------

  /** 共有部分を計算する。戻り値は自分視点の価値 [-1, 1] */
  forward(sparse: Int32Array, sparseCount: number, dense: Float32Array): number {
    const p = this.params
    const lay = this.lay
    const H1 = this.shape.hidden1
    const H2 = this.shape.hidden2
    const VH = this.shape.valueHidden
    const z1 = this.z1
    const h1 = this.h1
    const w1s = lay.w1s
    const w1d = lay.w1d
    const b1 = lay.b1

    // 1 層目。盤面は二値なので掛け算は不要（立っている特徴の重みを足すだけ）
    for (let jb = 0; jb < H1; jb += BLOCK) {
      let a0 = p[b1 + jb]!
      let a1 = p[b1 + jb + 1]!
      let a2 = p[b1 + jb + 2]!
      let a3 = p[b1 + jb + 3]!
      let a4 = p[b1 + jb + 4]!
      let a5 = p[b1 + jb + 5]!
      let a6 = p[b1 + jb + 6]!
      let a7 = p[b1 + jb + 7]!
      let a8 = p[b1 + jb + 8]!
      let a9 = p[b1 + jb + 9]!
      let a10 = p[b1 + jb + 10]!
      let a11 = p[b1 + jb + 11]!
      let a12 = p[b1 + jb + 12]!
      let a13 = p[b1 + jb + 13]!
      let a14 = p[b1 + jb + 14]!
      let a15 = p[b1 + jb + 15]!

      for (let i = 0; i < sparseCount; i += 1) {
        const q = w1s + sparse[i]! * H1 + jb
        a0 += p[q]!
        a1 += p[q + 1]!
        a2 += p[q + 2]!
        a3 += p[q + 3]!
        a4 += p[q + 4]!
        a5 += p[q + 5]!
        a6 += p[q + 6]!
        a7 += p[q + 7]!
        a8 += p[q + 8]!
        a9 += p[q + 9]!
        a10 += p[q + 10]!
        a11 += p[q + 11]!
        a12 += p[q + 12]!
        a13 += p[q + 13]!
        a14 += p[q + 14]!
        a15 += p[q + 15]!
      }
      for (let d = 0; d < DENSE_FEATURE_COUNT; d += 1) {
        const x = dense[d]!
        if (x === 0) continue
        const q = w1d + d * H1 + jb
        a0 += x * p[q]!
        a1 += x * p[q + 1]!
        a2 += x * p[q + 2]!
        a3 += x * p[q + 3]!
        a4 += x * p[q + 4]!
        a5 += x * p[q + 5]!
        a6 += x * p[q + 6]!
        a7 += x * p[q + 7]!
        a8 += x * p[q + 8]!
        a9 += x * p[q + 9]!
        a10 += x * p[q + 10]!
        a11 += x * p[q + 11]!
        a12 += x * p[q + 12]!
        a13 += x * p[q + 13]!
        a14 += x * p[q + 14]!
        a15 += x * p[q + 15]!
      }

      z1[jb] = a0
      z1[jb + 1] = a1
      z1[jb + 2] = a2
      z1[jb + 3] = a3
      z1[jb + 4] = a4
      z1[jb + 5] = a5
      z1[jb + 6] = a6
      z1[jb + 7] = a7
      z1[jb + 8] = a8
      z1[jb + 9] = a9
      z1[jb + 10] = a10
      z1[jb + 11] = a11
      z1[jb + 12] = a12
      z1[jb + 13] = a13
      z1[jb + 14] = a14
      z1[jb + 15] = a15
    }

    // ReLU。0 になった隠れ素子は 2 層目で丸ごと飛ばせるので添字を控えておく
    const active = this.activeH1
    let activeCount = 0
    for (let j = 0; j < H1; j += 1) {
      const v = z1[j]!
      if (v > 0) {
        h1[j] = v
        active[activeCount] = j
        activeCount += 1
      } else {
        h1[j] = 0
      }
    }
    this.activeH1Count = activeCount

    const z2 = this.z2
    const h2 = this.h2
    const w2 = lay.w2
    const b2 = lay.b2
    for (let kb = 0; kb < H2; kb += BLOCK) {
      let a0 = p[b2 + kb]!
      let a1 = p[b2 + kb + 1]!
      let a2 = p[b2 + kb + 2]!
      let a3 = p[b2 + kb + 3]!
      let a4 = p[b2 + kb + 4]!
      let a5 = p[b2 + kb + 5]!
      let a6 = p[b2 + kb + 6]!
      let a7 = p[b2 + kb + 7]!
      let a8 = p[b2 + kb + 8]!
      let a9 = p[b2 + kb + 9]!
      let a10 = p[b2 + kb + 10]!
      let a11 = p[b2 + kb + 11]!
      let a12 = p[b2 + kb + 12]!
      let a13 = p[b2 + kb + 13]!
      let a14 = p[b2 + kb + 14]!
      let a15 = p[b2 + kb + 15]!

      for (let t = 0; t < activeCount; t += 1) {
        const j = active[t]!
        const x = h1[j]!
        const q = w2 + j * H2 + kb
        a0 += x * p[q]!
        a1 += x * p[q + 1]!
        a2 += x * p[q + 2]!
        a3 += x * p[q + 3]!
        a4 += x * p[q + 4]!
        a5 += x * p[q + 5]!
        a6 += x * p[q + 6]!
        a7 += x * p[q + 7]!
        a8 += x * p[q + 8]!
        a9 += x * p[q + 9]!
        a10 += x * p[q + 10]!
        a11 += x * p[q + 11]!
        a12 += x * p[q + 12]!
        a13 += x * p[q + 13]!
        a14 += x * p[q + 14]!
        a15 += x * p[q + 15]!
      }

      z2[kb] = a0
      z2[kb + 1] = a1
      z2[kb + 2] = a2
      z2[kb + 3] = a3
      z2[kb + 4] = a4
      z2[kb + 5] = a5
      z2[kb + 6] = a6
      z2[kb + 7] = a7
      z2[kb + 8] = a8
      z2[kb + 9] = a9
      z2[kb + 10] = a10
      z2[kb + 11] = a11
      z2[kb + 12] = a12
      z2[kb + 13] = a13
      z2[kb + 14] = a14
      z2[kb + 15] = a15
    }
    for (let k = 0; k < H2; k += 1) {
      const v = z2[k]!
      h2[k] = v > 0 ? v : 0
    }

    // 価値側は出力主体なので、出力ごとにスカラーへ集約する
    const zv = this.zv
    const hv = this.hv
    let sum = p[lay.bv2]!
    for (let m = 0; m < VH; m += 1) {
      const q = lay.wv1 + m * H2
      let acc = p[lay.bv1 + m]!
      for (let k = 0; k < H2; k += 1) acc += h2[k]! * p[q + k]!
      zv[m] = acc
      const a = acc > 0 ? acc : 0
      hv[m] = a
      if (a !== 0) sum += a * p[lay.wv2 + m]!
    }
    this.lastValue = Math.tanh(sum)
    return this.lastValue
  }

  get value(): number {
    return this.lastValue
  }

  /** 共有部分の出力を退避する（同一局面で方策と価値を使い回すため） */
  copyHiddenTo(dst: Float32Array): void {
    dst.set(this.h2)
  }

  loadHiddenFrom(src: Float32Array): void {
    this.h2.set(src)
  }

  /** forward の後に呼ぶ。合法手ぶんのロジットを out に書く */
  policyLogits(actions: Int32Array, count: number, out: Float32Array): void {
    const p = this.params
    const lay = this.lay
    const H2 = this.shape.hidden2
    const h2 = this.h2
    for (let i = 0; i < count; i += 1) {
      const base = lay.wp + actions[i]! * H2
      let sum = p[lay.bp + actions[i]!]!
      for (let k = 0; k < H2; k += 1) sum += h2[k]! * p[base + k]!
      out[i] = sum
    }
  }

  // --- 逆伝播 ---------------------------------------------------------------

  private ensureTrainBuffers(): void {
    if (this.grad) return
    this.grad = new Float32Array(this.lay.total)
    this.adamM = new Float32Array(this.lay.total)
    this.adamV = new Float32Array(this.lay.total)
  }

  zeroGrad(): void {
    this.ensureTrainBuffers()
    this.grad!.fill(0)
  }

  /** 数値微分との照合（network.test.ts）に使う */
  debugGrad(): Float32Array {
    this.ensureTrainBuffers()
    return this.grad!
  }

  /**
   * forward 済みの状態で勾配を積む。
   * dLogits は合法手ぶんの ∂loss/∂logit、dValue は ∂loss/∂value（tanh の後）。
   */
  backward(
    sparse: Int32Array,
    sparseCount: number,
    dense: Float32Array,
    actions: Int32Array,
    actionCount: number,
    dLogits: Float32Array,
    dValue: number,
  ): void {
    this.ensureTrainBuffers()
    const p = this.params
    const g = this.grad!
    const lay = this.lay
    const H1 = this.shape.hidden1
    const H2 = this.shape.hidden2
    const VH = this.shape.valueHidden
    const h1 = this.h1
    const h2 = this.h2
    const hv = this.hv
    const dh1 = this.dh1
    const dh2 = this.dh2
    const dhv = this.dhv

    dh2.fill(0)

    // 価値側。重みは [m][k] 並び
    const dTanh = dValue * (1 - this.lastValue * this.lastValue)
    g[lay.bv2]! += dTanh
    for (let m = 0; m < VH; m += 1) {
      g[lay.wv2 + m]! += dTanh * hv[m]!
      const dz = this.zv[m]! > 0 ? dTanh * p[lay.wv2 + m]! : 0
      dhv[m] = dz
      if (dz === 0) continue
      g[lay.bv1 + m]! += dz
      const base = lay.wv1 + m * H2
      for (let k = 0; k < H2; k += 1) {
        g[base + k]! += h2[k]! * dz
        dh2[k]! += dz * p[base + k]!
      }
    }

    // 方策側（合法手だけ）
    for (let i = 0; i < actionCount; i += 1) {
      const dl = dLogits[i]!
      if (dl === 0) continue
      const action = actions[i]!
      g[lay.bp + action]! += dl
      const base = lay.wp + action * H2
      for (let k = 0; k < H2; k += 1) {
        g[base + k]! += dl * h2[k]!
        dh2[k]! += dl * p[base + k]!
      }
    }

    // h2 → h1。dh2 を ReLU 通過後の勾配に置き換えてから j を外側で回す。
    // ReLU で落ちた隠れ素子は勾配も 0 なので、立っている添字だけ回す
    for (let k = 0; k < H2; k += 1) {
      const dz = this.z2[k]! > 0 ? dh2[k]! : 0
      dh2[k] = dz
      g[lay.b2 + k]! += dz
    }
    dh1.fill(0)
    const active = this.activeH1
    for (let t = 0; t < this.activeH1Count; t += 1) {
      const j = active[t]!
      const a = h1[j]!
      const base = lay.w2 + j * H2
      let acc = 0
      for (let k = 0; k < H2; k += 1) {
        const dz = dh2[k]!
        if (dz === 0) continue
        g[base + k]! += a * dz
        acc += dz * p[base + k]!
      }
      dh1[j] = acc
      g[lay.b1 + j]! += acc
    }
    for (let i = 0; i < sparseCount; i += 1) {
      const base = lay.w1s + sparse[i]! * H1
      for (let j = 0; j < H1; j += 1) {
        const dz = dh1[j]!
        if (dz !== 0) g[base + j]! += dz
      }
    }
    for (let d = 0; d < DENSE_FEATURE_COUNT; d += 1) {
      const x = dense[d]!
      if (x === 0) continue
      const base = lay.w1d + d * H1
      for (let j = 0; j < H1; j += 1) {
        const dz = dh1[j]!
        if (dz !== 0) g[base + j]! += x * dz
      }
    }
  }

  /** Adam。batchSize で勾配を平均する。weightDecay は AdamW 方式 */
  step(options: {
    lr: number
    batchSize: number
    weightDecay?: number
    beta1?: number
    beta2?: number
    eps?: number
  }): void {
    this.ensureTrainBuffers()
    const g = this.grad!
    const m = this.adamM!
    const v = this.adamV!
    const p = this.params
    const beta1 = options.beta1 ?? 0.9
    const beta2 = options.beta2 ?? 0.999
    const eps = options.eps ?? 1e-8
    const wd = options.weightDecay ?? 0
    const scale = 1 / Math.max(1, options.batchSize)

    this.adamSteps += 1
    const bc1 = 1 - Math.pow(beta1, this.adamSteps)
    const bc2 = 1 - Math.pow(beta2, this.adamSteps)
    const lr = options.lr

    for (let i = 0; i < p.length; i += 1) {
      const grad = g[i]! * scale
      const mi = beta1 * m[i]! + (1 - beta1) * grad
      const vi = beta2 * v[i]! + (1 - beta2) * grad * grad
      m[i] = mi
      v[i] = vi
      const upd = (lr * (mi / bc1)) / (Math.sqrt(vi / bc2) + eps)
      p[i] = p[i]! - upd - lr * wd * p[i]!
    }
  }

  // --- 保存・読み込み -------------------------------------------------------

  toJson(): SerializedNetwork {
    return {
      v: 1,
      shape: this.shape,
      params: Buffer.from(
        this.params.buffer,
        this.params.byteOffset,
        this.params.byteLength,
      ).toString('base64'),
      steps: this.adamSteps,
    }
  }

  static fromJson(data: SerializedNetwork): PvNetwork {
    const raw = Buffer.from(data.params, 'base64')
    const params = new Float32Array(raw.byteLength / 4)
    new Uint8Array(params.buffer).set(raw)
    const net = new PvNetwork(data.shape, params)
    if (params.length !== net.parameterCount) {
      throw new Error(
        `network size mismatch: ${params.length} vs ${net.parameterCount}`,
      )
    }
    net.adamSteps = data.steps ?? 0
    return net
  }

  /** 重みごと複製する（学習の起点にする用。元は変わらない） */
  clone(): PvNetwork {
    return new PvNetwork(this.shape, this.params.slice())
  }

  /**
   * 重みは共有し、前向き計算の作業領域だけ別に持つ。
   * 推論では重みを書き換えないので、同じモデルを複数のエージェントで使える。
   */
  shareWeights(): PvNetwork {
    return new PvNetwork(this.shape, this.params)
  }
}

function fillGaussian(
  dst: Float32Array,
  offset: number,
  count: number,
  std: number,
  rng: Rng,
): void {
  for (let i = 0; i < count; i += 1) {
    let u = rng.next()
    let v = rng.next()
    if (u <= 0) u = 1e-12
    if (v <= 0) v = 1e-12
    dst[offset + i] = std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/** 合法手ぶんのロジットを確率へ。out を上書きする */
export function softmaxInto(out: Float32Array, count: number): void {
  let max = -Infinity
  for (let i = 0; i < count; i += 1) {
    if (out[i]! > max) max = out[i]!
  }
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    const e = Math.exp(out[i]! - max)
    out[i] = e
    sum += e
  }
  const inv = 1 / sum
  for (let i = 0; i < count; i += 1) out[i] = out[i]! * inv
}
