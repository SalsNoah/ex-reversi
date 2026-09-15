import { describe, expect, it } from 'vitest'
import { createRng } from '../../game/rng.ts'
import { ACTION_SPACE_SIZE } from '../../sim/constants.ts'
import {
  DENSE_FEATURE_COUNT,
  SPARSE_FEATURE_COUNT,
  createFeatureBuffer,
  encodeFeatures,
} from './features.ts'
import { PvNetwork, softmaxInto, type NetShape } from './network.ts'
import { advanceToDecision, createFastMatch, SIDE_BLACK, SIDE_WHITE } from '../sim/fastMatch.ts'

const SMALL: NetShape = { hidden1: 32, hidden2: 16, valueHidden: 5 }

type Sample = {
  sparse: Int32Array
  sparseCount: number
  dense: Float32Array
  actions: Int32Array
  actionCount: number
  target: Float32Array
  valueTarget: number
}

function makeSample(seed: number): Sample {
  const rng = createRng(seed)
  const count = 40
  const sparse = new Int32Array(count)
  for (let i = 0; i < count; i += 1) {
    sparse[i] = rng.nextInt(0, SPARSE_FEATURE_COUNT)
  }
  const dense = new Float32Array(DENSE_FEATURE_COUNT)
  for (let i = 0; i < DENSE_FEATURE_COUNT; i += 1) dense[i] = rng.next() * 2 - 1

  const actionCount = 6
  const actions = new Int32Array(actionCount)
  for (let i = 0; i < actionCount; i += 1) {
    actions[i] = rng.nextInt(0, ACTION_SPACE_SIZE)
  }
  const target = new Float32Array(actionCount)
  let sum = 0
  for (let i = 0; i < actionCount; i += 1) {
    target[i] = rng.next() + 0.05
    sum += target[i]!
  }
  for (let i = 0; i < actionCount; i += 1) target[i] = target[i]! / sum

  return {
    sparse,
    sparseCount: count,
    dense,
    actions,
    actionCount,
    target,
    valueTarget: rng.next() * 2 - 1,
  }
}

/** 方策の交差エントロピー + 価値の二乗誤差 */
function lossOf(net: PvNetwork, s: Sample, probs: Float32Array): number {
  const value = net.forward(s.sparse, s.sparseCount, s.dense)
  net.policyLogits(s.actions, s.actionCount, probs)
  softmaxInto(probs, s.actionCount)
  let loss = 0
  for (let i = 0; i < s.actionCount; i += 1) {
    loss -= s.target[i]! * Math.log(Math.max(1e-12, probs[i]!))
  }
  const d = value - s.valueTarget
  return loss + 0.5 * d * d
}

describe('PvNetwork', () => {
  it('逆伝播が数値微分と一致する', () => {
    const net = PvNetwork.createInitial(1234, SMALL)
    // 出力層が 0 のままだと勾配経路が一部消えるので、全部に値を入れて確かめる
    const rng = createRng(77)
    for (let i = 0; i < net.params.length; i += 1) {
      net.params[i] = net.params[i]! + (rng.next() * 2 - 1) * 0.2
    }

    const s = makeSample(9)
    const probs = new Float32Array(s.actionCount)
    const dLogits = new Float32Array(s.actionCount)

    net.zeroGrad()
    const value = net.forward(s.sparse, s.sparseCount, s.dense)
    net.policyLogits(s.actions, s.actionCount, probs)
    softmaxInto(probs, s.actionCount)
    for (let i = 0; i < s.actionCount; i += 1) {
      dLogits[i] = probs[i]! - s.target[i]!
    }
    net.backward(
      s.sparse,
      s.sparseCount,
      s.dense,
      s.actions,
      s.actionCount,
      dLogits,
      value - s.valueTarget,
    )
    const analytic = net.debugGrad().slice()

    // 全部見ると重いので、勾配が立っている位置を散らして選ぶ
    const picks: number[] = []
    for (let i = 0; i < analytic.length; i += 1) {
      if (Math.abs(analytic[i]!) > 1e-4) picks.push(i)
    }
    expect(picks.length).toBeGreaterThan(50)
    const stride = Math.max(1, Math.floor(picks.length / 60))

    const eps = 1e-3
    const scratch = new Float32Array(s.actionCount)
    let checked = 0
    for (let k = 0; k < picks.length; k += stride) {
      const i = picks[k]!
      const original = net.params[i]!
      net.params[i] = original + eps
      const plus = lossOf(net, s, scratch)
      net.params[i] = original - eps
      const minus = lossOf(net, s, scratch)
      net.params[i] = original
      const numeric = (plus - minus) / (2 * eps)
      const denom = Math.max(1e-3, Math.abs(numeric) + Math.abs(analytic[i]!))
      expect(Math.abs(numeric - analytic[i]!) / denom).toBeLessThan(0.02)
      checked += 1
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('初期モデルは一様な事前確率と価値 0 を返す', () => {
    const net = PvNetwork.createInitial(5)
    const s = makeSample(3)
    const value = net.forward(s.sparse, s.sparseCount, s.dense)
    expect(value).toBe(0)
    const probs = new Float32Array(s.actionCount)
    net.policyLogits(s.actions, s.actionCount, probs)
    softmaxInto(probs, s.actionCount)
    for (let i = 0; i < s.actionCount; i += 1) {
      expect(probs[i]!).toBeCloseTo(1 / s.actionCount, 6)
    }
  })

  it('保存と読み込みで出力が変わらない', () => {
    const net = PvNetwork.createInitial(42, SMALL)
    const rng = createRng(4)
    for (let i = 0; i < net.params.length; i += 1) {
      net.params[i] = net.params[i]! + (rng.next() * 2 - 1) * 0.3
    }
    const s = makeSample(11)
    const before = net.forward(s.sparse, s.sparseCount, s.dense)
    const probsBefore = new Float32Array(s.actionCount)
    net.policyLogits(s.actions, s.actionCount, probsBefore)

    const restored = PvNetwork.fromJson(JSON.parse(JSON.stringify(net.toJson())))
    const after = restored.forward(s.sparse, s.sparseCount, s.dense)
    const probsAfter = new Float32Array(s.actionCount)
    restored.policyLogits(s.actions, s.actionCount, probsAfter)

    expect(after).toBe(before)
    for (let i = 0; i < s.actionCount; i += 1) {
      expect(probsAfter[i]).toBe(probsBefore[i])
    }
  })

  it('Adam の 1 歩で損失が下がる', () => {
    const net = PvNetwork.createInitial(8, SMALL)
    const s = makeSample(21)
    const probs = new Float32Array(s.actionCount)
    const dLogits = new Float32Array(s.actionCount)
    const before = lossOf(net, s, probs)

    for (let step = 0; step < 20; step += 1) {
      net.zeroGrad()
      const value = net.forward(s.sparse, s.sparseCount, s.dense)
      net.policyLogits(s.actions, s.actionCount, probs)
      softmaxInto(probs, s.actionCount)
      for (let i = 0; i < s.actionCount; i += 1) dLogits[i] = probs[i]! - s.target[i]!
      net.backward(
        s.sparse,
        s.sparseCount,
        s.dense,
        s.actions,
        s.actionCount,
        dLogits,
        value - s.valueTarget,
      )
      net.step({ lr: 0.02, batchSize: 1 })
    }

    const after = lossOf(net, s, probs)
    expect(after).toBeLessThan(before)
  })
})

describe('encodeFeatures', () => {
  it('自分視点なので黒白で石の平面が入れ替わる', () => {
    const match = createFastMatch({ seed: 7 })
    advanceToDecision(match)
    const black = createFeatureBuffer()
    const white = createFeatureBuffer()
    encodeFeatures(match, SIDE_BLACK, black)
    encodeFeatures(match, SIDE_WHITE, white)

    const own = (buf: typeof black): number[] =>
      [...buf.sparse.slice(0, buf.sparseCount)].filter((f) => f < 100)
    const opp = (buf: typeof black): number[] =>
      [...buf.sparse.slice(0, buf.sparseCount)]
        .filter((f) => f >= 100 && f < 200)
        .map((f) => f - 100)

    expect(own(black)).toEqual(opp(white))
    expect(opp(black)).toEqual(own(white))
    // 開始盤面は 8 石（10×10 なので中央 2×2 ではなく 4×4 の一部）
    expect(own(black).length + opp(black).length).toBe(match.pos.black + match.pos.white)
  })

  it('時間特徴が範囲内に収まる', () => {
    const match = createFastMatch({ seed: 3 })
    advanceToDecision(match)
    const buf = createFeatureBuffer()
    encodeFeatures(match, SIDE_BLACK, buf)
    for (let i = 0; i < buf.dense.length; i += 1) {
      expect(Number.isFinite(buf.dense[i]!)).toBe(true)
      expect(Math.abs(buf.dense[i]!)).toBeLessThanOrEqual(2)
    }
    expect(buf.sparseCount).toBeGreaterThan(0)
    expect(buf.ownActionCount).toBeGreaterThan(0)
  })
})
