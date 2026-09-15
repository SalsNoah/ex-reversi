/**
 * 棋譜（シード + 行動列）を再生して学習サンプルに戻す。
 *
 * 局面を保存していないのは、高速シミュレータが決定的だから。
 * 特徴量の設計を変えても、同じ棋譜からそのまま作り直せる。
 */
import { readFileSync } from 'node:fs'
import { ACTION_SPACE_SIZE } from '../../sim/constants.ts'
import {
  DENSE_FEATURE_COUNT,
  createFeatureBuffer,
  encodeFeatures,
  type FeatureBuffer,
} from '../nn/features.ts'
import {
  OUTCOME_BLACK_WIN,
  OUTCOME_DRAW,
  PHASE_FINISHED,
  SIDE_BLACK,
  TS_PHASE,
  advanceToDecision,
  applyFastStep,
  createFastMatch,
  resetFastMatch,
  type FastMatch,
} from '../sim/fastMatch.ts'
import type { SelfPlayRecord, SelfPlaySample } from '../selfplay/record.ts'

/** 石 100 + 自分の合法手 + 相手の合法手。盤が埋まるほど合法手は減る */
export const MAX_SPARSE = 180

export type ReplayVisitor = (
  sample: SelfPlaySample,
  buf: FeatureBuffer,
  /** 探索した側から見た最終結果（+1 勝ち / -1 負け / 0 引分） */
  valueTarget: number,
) => void

export function createReplayMatch(): FastMatch {
  return createFastMatch({ seed: 1 })
}

/** 1 局を再生して、記録された意思決定点ごとに visitor を呼ぶ */
export function replayRecord(
  record: SelfPlayRecord,
  match: FastMatch,
  buf: FeatureBuffer,
  visit: ReplayVisitor,
): void {
  match.config.thinkDelayMs = [record.think[0], record.think[1]]
  resetFastMatch(match, record.seed)

  const blackValue =
    record.outcome === OUTCOME_DRAW ? 0 : record.outcome === OUTCOME_BLACK_WIN ? 1 : -1

  const samples = record.samples
  let si = 0

  for (let i = 0; i < record.steps.length; i += 1) {
    advanceToDecision(match)
    if (match.ts[TS_PHASE] === PHASE_FINISHED) break

    while (si < samples.length && samples[si]!.i === i) {
      const sample = samples[si]!
      encodeFeatures(match, sample.s, buf)
      visit(sample, buf, sample.s === SIDE_BLACK ? blackValue : -blackValue)
      si += 1
    }

    const step = record.steps[i]!
    applyFastStep(match, step[0], step[1])
  }
}

export function parseShard(path: string): SelfPlayRecord[] {
  const text = readFileSync(path, 'utf8')
  const out: SelfPlayRecord[] = []
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    if (end > start) {
      const line = text.slice(start, end).trim()
      if (line.length > 0) out.push(JSON.parse(line) as SelfPlayRecord)
    }
    start = end + 1
  }
  return out
}

/**
 * 学習用のミニバッチ置き場。
 * 局内のサンプルは相関が強いので、ここに数百局ぶん貯めてから混ぜる。
 */
export class SampleBuffer {
  readonly capacity: number
  readonly sparse: Int32Array
  readonly sparseCount: Int32Array
  readonly dense: Float32Array
  readonly actions: Int32Array
  readonly policy: Float32Array
  readonly actionCount: Int32Array
  readonly value: Float32Array
  size = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.sparse = new Int32Array(capacity * MAX_SPARSE)
    this.sparseCount = new Int32Array(capacity)
    this.dense = new Float32Array(capacity * DENSE_FEATURE_COUNT)
    this.actions = new Int32Array(capacity * ACTION_SPACE_SIZE)
    this.policy = new Float32Array(capacity * ACTION_SPACE_SIZE)
    this.actionCount = new Int32Array(capacity)
    this.value = new Float32Array(capacity)
  }

  get full(): boolean {
    return this.size >= this.capacity
  }

  clear(): void {
    this.size = 0
  }

  /** 訪問数を確率に直して 1 件積む。容量を超えたら false */
  push(sample: SelfPlaySample, buf: FeatureBuffer, valueTarget: number): boolean {
    if (this.size >= this.capacity) return false
    if (buf.sparseCount > MAX_SPARSE) {
      throw new Error(`sparse overflow: ${buf.sparseCount} > ${MAX_SPARSE}`)
    }
    const at = this.size
    this.sparse.set(buf.sparse.subarray(0, buf.sparseCount), at * MAX_SPARSE)
    this.sparseCount[at] = buf.sparseCount
    this.dense.set(buf.dense, at * DENSE_FEATURE_COUNT)

    const count = sample.a.length
    let total = 0
    for (let k = 0; k < count; k += 1) total += sample.n[k]!
    const base = at * ACTION_SPACE_SIZE
    if (total <= 0) {
      // 探索が 1 回も回らなかった場合。一様にしておく
      for (let k = 0; k < count; k += 1) {
        this.actions[base + k] = sample.a[k]!
        this.policy[base + k] = 1 / count
      }
    } else {
      const inv = 1 / total
      for (let k = 0; k < count; k += 1) {
        this.actions[base + k] = sample.a[k]!
        this.policy[base + k] = sample.n[k]! * inv
      }
    }
    this.actionCount[at] = count
    this.value[at] = valueTarget
    this.size = at + 1
    return true
  }
}

export function createReplayBuffer(): FeatureBuffer {
  return createFeatureBuffer()
}
