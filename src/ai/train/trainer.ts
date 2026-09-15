/**
 * Policy / Value ネットワークの学習。
 *
 * 損失 = 方策の交差エントロピー（MCTS の訪問分布を目標）
 *      + valueWeight × 価値の二乗誤差（最終勝敗を目標）
 *
 * 局内のサンプルは相関が強いので、数百局ぶんをまとめて混ぜてからミニバッチを回す。
 * 棋譜は行動列しか持たないので、混ぜる前に毎回再生する。
 */
import { createRng, type Rng } from '../../game/rng.ts'
import { ACTION_SPACE_SIZE } from '../../sim/constants.ts'
import { DENSE_FEATURE_COUNT } from '../nn/features.ts'
import { PvNetwork, softmaxInto } from '../nn/network.ts'
import type { SelfPlayRecord } from '../selfplay/record.ts'
import {
  MAX_SPARSE,
  SampleBuffer,
  createReplayBuffer,
  createReplayMatch,
  parseShard,
  replayRecord,
} from './dataset.ts'

export type TrainOptions = {
  /** 棋譜ファイル（JSONL）。順に読む */
  shards: string[]
  epochs: number
  batchSize: number
  lr: number
  /** エポックごとに lr を掛ける係数 */
  lrDecay?: number
  valueWeight: number
  weightDecay: number
  /** 混ぜる単位（局数） */
  chunkGames: number
  /** 混ぜる置き場の上限サンプル数 */
  bufferSamples: number
  seed: number
  /** 無操作強制で着手が差し替わったサンプルを使わない */
  skipForced?: boolean
  onProgress?: (info: EpochMetrics) => void
}

export type EpochMetrics = {
  epoch: number
  samples: number
  policyLoss: number
  valueLoss: number
  /** 予測の最尤手が訪問最多手と一致した割合 */
  policyTop1: number
  /** 訪問最多手に付けた確率の平均 */
  policyBestProb: number
}

export type TrainResult = {
  samples: number
  steps: number
  /** 最終エポックの値（収束の目安） */
  policyLoss: number
  valueLoss: number
  policyTop1: number
  epochs: EpochMetrics[]
  wallMs: number
}

export function train(net: PvNetwork, options: TrainOptions): TrainResult {
  const wallStart = performance.now()
  const rng = createRng(options.seed)
  const match = createReplayMatch()
  const featureBuf = createReplayBuffer()
  const buffer = new SampleBuffer(options.bufferSamples)
  const order = new Int32Array(options.bufferSamples)

  const sparseScratch = new Int32Array(MAX_SPARSE)
  const denseScratch = new Float32Array(DENSE_FEATURE_COUNT)
  const actionScratch = new Int32Array(ACTION_SPACE_SIZE)
  const probs = new Float32Array(ACTION_SPACE_SIZE)
  const dLogits = new Float32Array(ACTION_SPACE_SIZE)

  let totalSamples = 0
  let totalSteps = 0
  let lr = options.lr
  // エポックごとに集計する（累積平均だと改善が見えない）
  let epochSamples = 0
  let policySum = 0
  let valueSum = 0
  let top1Sum = 0
  let bestProbSum = 0

  const trainBuffer = (): void => {
    const n = buffer.size
    if (n === 0) return
    for (let i = 0; i < n; i += 1) order[i] = i
    for (let i = n - 1; i > 0; i -= 1) {
      const j = rng.nextInt(0, i + 1)
      const t = order[i]!
      order[i] = order[j]!
      order[j] = t
    }

    for (let start = 0; start < n; start += options.batchSize) {
      const end = Math.min(n, start + options.batchSize)
      net.zeroGrad()
      let batchPolicy = 0
      let batchValue = 0

      for (let b = start; b < end; b += 1) {
        const at = order[b]!
        const count = buffer.actionCount[at]!
        const sparseCount = buffer.sparseCount[at]!
        sparseScratch.set(buffer.sparse.subarray(at * MAX_SPARSE, at * MAX_SPARSE + sparseCount))
        denseScratch.set(
          buffer.dense.subarray(
            at * DENSE_FEATURE_COUNT,
            (at + 1) * DENSE_FEATURE_COUNT,
          ),
        )
        const actionBase = at * ACTION_SPACE_SIZE
        actionScratch.set(buffer.actions.subarray(actionBase, actionBase + count))

        const value = net.forward(sparseScratch, sparseCount, denseScratch)
        net.policyLogits(actionScratch, count, probs)
        softmaxInto(probs, count)

        let loss = 0
        let bestTarget = -1
        let bestTargetValue = -1
        let bestPred = -1
        let bestPredValue = -1
        for (let k = 0; k < count; k += 1) {
          const target = buffer.policy[actionBase + k]!
          if (target > 0) loss -= target * Math.log(Math.max(1e-12, probs[k]!))
          dLogits[k] = probs[k]! - target
          if (target > bestTargetValue) {
            bestTargetValue = target
            bestTarget = k
          }
          if (probs[k]! > bestPredValue) {
            bestPredValue = probs[k]!
            bestPred = k
          }
        }
        if (bestPred === bestTarget) top1Sum += 1
        if (bestTarget >= 0) bestProbSum += probs[bestTarget]!

        const target = buffer.value[at]!
        const diff = value - target
        batchPolicy += loss
        batchValue += diff * diff

        net.backward(
          sparseScratch,
          sparseCount,
          denseScratch,
          actionScratch,
          count,
          dLogits,
          options.valueWeight * diff,
        )
      }

      net.step({
        lr,
        batchSize: end - start,
        weightDecay: options.weightDecay,
      })

      const size = end - start
      totalSamples += size
      epochSamples += size
      totalSteps += 1
      policySum += batchPolicy
      valueSum += batchValue
    }
    buffer.clear()
  }

  const epochs: EpochMetrics[] = []

  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    epochSamples = 0
    policySum = 0
    valueSum = 0
    top1Sum = 0
    bestProbSum = 0

    for (const shard of options.shards) {
      const records = parseShard(shard)
      shuffleRecords(records, rng)
      let inChunk = 0
      for (const record of records) {
        replayRecord(record, match, featureBuf, (sample, buf, valueTarget) => {
          if (options.skipForced && sample.f === 1) return
          // 満杯なら先に流す（サンプルを捨てない）
          if (buffer.full) trainBuffer()
          buffer.push(sample, buf, valueTarget)
        })
        inChunk += 1
        if (inChunk >= options.chunkGames || buffer.full) {
          trainBuffer()
          inChunk = 0
        }
      }
      trainBuffer()
    }

    const n = Math.max(1, epochSamples)
    const metrics: EpochMetrics = {
      epoch: epoch + 1,
      samples: epochSamples,
      policyLoss: policySum / n,
      valueLoss: valueSum / n,
      policyTop1: top1Sum / n,
      policyBestProb: bestProbSum / n,
    }
    epochs.push(metrics)
    options.onProgress?.(metrics)
    lr *= options.lrDecay ?? 1
  }

  const last = epochs[epochs.length - 1]
  return {
    samples: totalSamples,
    steps: totalSteps,
    policyLoss: last?.policyLoss ?? 0,
    valueLoss: last?.valueLoss ?? 0,
    policyTop1: last?.policyTop1 ?? 0,
    epochs,
    wallMs: performance.now() - wallStart,
  }
}

function shuffleRecords(records: SelfPlayRecord[], rng: Rng): void {
  for (let i = records.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(0, i + 1)
    const t = records[i]!
    records[i] = records[j]!
    records[j] = t
  }
}
