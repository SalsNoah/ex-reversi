import { describe, expect, it } from 'vitest'
import { WAIT_ACTION } from '../../sim/constants.ts'
import { heuristicChampionSpec } from '../engine/engine.ts'
import { runSelfPlay } from '../selfplay/selfplay.ts'
import type { SelfPlayRecord } from '../selfplay/record.ts'
import {
  OUTCOME_BLACK_WIN,
  OUTCOME_DRAW,
  SIDE_BLACK,
  listLegalActions,
} from '../sim/fastMatch.ts'
import {
  MAX_SPARSE,
  SampleBuffer,
  createReplayBuffer,
  createReplayMatch,
  replayRecord,
} from './dataset.ts'

function generate(games: number): SelfPlayRecord[] {
  const records: SelfPlayRecord[] = []
  runSelfPlay({
    champion: heuristicChampionSpec(16),
    games,
    masterSeed: 987,
    temperatureMoves: 8,
    varyThinkDelay: true,
    onGame(record) {
      records.push(record)
    },
  })
  return records
}

describe('自己対戦の棋譜と再生', () => {
  const records = generate(6)

  it('棋譜から局面を再現でき、記録された合法手と完全に一致する', () => {
    const match = createReplayMatch()
    const buf = createReplayBuffer()
    const legal = new Int32Array(128)
    let samples = 0

    for (const record of records) {
      replayRecord(record, match, buf, (sample) => {
        const n = listLegalActions(match, sample.s, legal)
        const recorded = sample.a.filter((a) => a !== WAIT_ACTION)
        expect(recorded.length, `generation=${record.seed}`).toBe(n)
        for (let k = 0; k < n; k += 1) {
          expect(recorded[k]).toBe(legal[k])
        }
        expect(buf.sparseCount).toBeLessThanOrEqual(MAX_SPARSE)
        // 自分視点の符号化なので、合法手の平面は必ず自分のぶんが立つ
        expect(buf.ownActionCount).toBe(n)
        samples += 1
      })
    }
    expect(samples).toBeGreaterThan(300)
  })

  it('価値の目標が勝敗と符号で一致する', () => {
    const match = createReplayMatch()
    const buf = createReplayBuffer()
    for (const record of records) {
      const expectedBlack =
        record.outcome === OUTCOME_DRAW
          ? 0
          : record.outcome === OUTCOME_BLACK_WIN
            ? 1
            : -1
      replayRecord(record, match, buf, (sample, _buf, valueTarget) => {
        const expected = sample.s === SIDE_BLACK ? expectedBlack : -expectedBlack
        expect(valueTarget).toBe(expected)
      })
    }
  })

  it('訪問数が確率に正規化される', () => {
    const match = createReplayMatch()
    const buf = createReplayBuffer()
    const buffer = new SampleBuffer(2000)
    for (const record of records) {
      replayRecord(record, match, buf, (sample, b, valueTarget) => {
        if (buffer.full) return
        buffer.push(sample, b, valueTarget)
      })
    }
    expect(buffer.size).toBeGreaterThan(300)
    for (let i = 0; i < buffer.size; i += 1) {
      const count = buffer.actionCount[i]!
      let sum = 0
      for (let k = 0; k < count; k += 1) {
        const p = buffer.policy[i * 101 + k]!
        expect(p).toBeGreaterThanOrEqual(0)
        sum += p
      }
      expect(sum).toBeCloseTo(1, 5)
    }
  })

  it('同じ棋譜を 2 回再生しても同じ特徴量になる', () => {
    const match = createReplayMatch()
    const first = createReplayBuffer()
    const second = createReplayBuffer()
    const record = records[0]!

    const snapshot: Array<{ sparse: number[]; dense: number[] }> = []
    replayRecord(record, match, first, (_s, buf) => {
      snapshot.push({
        sparse: [...buf.sparse.subarray(0, buf.sparseCount)],
        dense: [...buf.dense],
      })
    })
    let at = 0
    replayRecord(record, match, second, (_s, buf) => {
      const want = snapshot[at]!
      at += 1
      expect([...buf.sparse.subarray(0, buf.sparseCount)]).toEqual(want.sparse)
      expect([...buf.dense]).toEqual(want.dense)
    })
    expect(at).toBe(snapshot.length)
  })
})
