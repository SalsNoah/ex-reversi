/**
 * 学習済みネットを MCTS の PolicyFn / ValueFn へつなぐ。
 *
 * 1 つの意思決定点で MCTS は
 *   policy(黒) → policy(白) → value()
 * の順に呼ぶ（ready な側だけ）。同じ局面なら前向き計算を共有したいので、
 * 側ごとに 1 スロットずつ、局面と時間状態を丸ごと突き合わせるキャッシュを持つ。
 *
 * 価値は「符号化した側から見た値」なので、黒視点へ直して返す。
 * 片側だけ ready の局面では 1 局面 1 回の前向き計算で済む。
 */
import {
  OUTCOME_BLACK_WIN,
  OUTCOME_WHITE_WIN,
  PHASE_FINISHED,
  SIDE_BLACK,
  SIDE_WHITE,
  TS_PHASE,
  TS_SIZE,
  outcomeOf,
  type FastMatch,
} from '../sim/fastMatch.ts'
import type { PolicyFn, ValueFn } from '../mcts/mcts.ts'
import { createFeatureBuffer, encodeFeatures, type FeatureBuffer } from './features.ts'
import { softmaxInto, type PvNetwork } from './network.ts'

/** キャッシュキー = 時間状態 + 盤面ハッシュ（完全一致で比較する） */
const KEY_SIZE = TS_SIZE + 2

export type NnEvalStats = {
  forwards: number
  hits: number
}

export class NnEvaluator {
  private readonly net: PvNetwork
  private readonly buf: FeatureBuffer = createFeatureBuffer()
  private readonly keys: [Int32Array, Int32Array]
  private readonly valid: [boolean, boolean] = [false, false]
  private readonly values: [number, number] = [0, 0]
  private readonly hidden: [Float32Array, Float32Array]
  /** いま net の共有層に載っている側（-1 なら未定） */
  private loadedSide = -1
  readonly stats: NnEvalStats = { forwards: 0, hits: 0 }

  constructor(net: PvNetwork) {
    this.net = net
    this.keys = [new Int32Array(KEY_SIZE), new Int32Array(KEY_SIZE)]
    this.hidden = [
      new Float32Array(net.shape.hidden2),
      new Float32Array(net.shape.hidden2),
    ]
  }

  /** 木を作り直すたびに呼ぶ（別局面のキャッシュを残さない） */
  reset(): void {
    this.valid[0] = false
    this.valid[1] = false
    this.loadedSide = -1
  }

  private matches(side: number, match: FastMatch): boolean {
    if (!this.valid[side]) return false
    const key = this.keys[side]!
    const ts = match.ts
    for (let i = 0; i < TS_SIZE; i += 1) {
      if (key[i] !== ts[i]) return false
    }
    return key[TS_SIZE] === match.pos.hashA && key[TS_SIZE + 1] === match.pos.hashB
  }

  private writeKey(side: number, match: FastMatch): void {
    const key = this.keys[side]!
    key.set(match.ts, 0)
    key[TS_SIZE] = match.pos.hashA
    key[TS_SIZE + 1] = match.pos.hashB
    this.valid[side] = true
  }

  /** side 視点の前向き計算を用意する。戻り値は自分視点の価値 */
  private ensure(side: number, match: FastMatch): number {
    if (this.matches(side, match)) {
      this.stats.hits += 1
      if (this.loadedSide !== side) {
        this.net.loadHiddenFrom(this.hidden[side]!)
        this.loadedSide = side
      }
      return this.values[side]!
    }
    const buf = this.buf
    encodeFeatures(match, side, buf)
    const value = this.net.forward(buf.sparse, buf.sparseCount, buf.dense)
    this.net.copyHiddenTo(this.hidden[side]!)
    this.values[side] = value
    this.writeKey(side, match)
    this.loadedSide = side
    this.stats.forwards += 1
    return value
  }

  /** MCTS に渡す事前確率 */
  readonly policy: PolicyFn = (match, side, actions, count, priors) => {
    this.ensure(side, match)
    this.net.policyLogits(actions, count, priors)
    softmaxInto(priors, count)
  }

  /** MCTS に渡す価値（黒視点） */
  readonly value: ValueFn = (match) => {
    if (match.ts[TS_PHASE] === PHASE_FINISHED) {
      const outcome = outcomeOf(match)
      if (outcome === OUTCOME_BLACK_WIN) return 1
      if (outcome === OUTCOME_WHITE_WIN) return -1
      return 0
    }
    // 直前の policy 呼び出しで作った前向き計算をそのまま使う
    if (this.matches(SIDE_BLACK, match)) {
      this.stats.hits += 1
      return this.values[SIDE_BLACK]!
    }
    if (this.matches(SIDE_WHITE, match)) {
      this.stats.hits += 1
      return -this.values[SIDE_WHITE]!
    }
    return this.ensure(SIDE_BLACK, match)
  }
}
