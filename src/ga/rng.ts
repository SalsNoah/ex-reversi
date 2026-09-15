import { createRng, type Rng } from '../game/rng.ts'

/** 進化・同点抽選用。試合シードとは分離して使う。 */
export type GaRng = Rng & {
  // Irwin–Hall 近似（平均0・分散1付近。spare なしでチェックポイント復元可能）
  nextGaussian: () => number
  getState: () => number
}

export function createGaRng(seed: number): GaRng {
  let t = seed >>> 0
  const base = createRng(seed)
  // createRng は閉じた t を持つため、状態同期用に自前でも回す
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let r = Math.imul(state ^ (state >>> 15), 1 | state)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
  const nextInt = (min: number, max: number): number => {
    if (max <= min) throw new Error('nextInt invalid range')
    return min + Math.floor(next() * (max - min))
  }
  // Irwin–Hall 近似（状態に spare を持たせずチェックポイント復元可能）
  const nextGaussian = (): number => {
    let sum = 0
    for (let i = 0; i < 12; i += 1) sum += next()
    return sum - 6
  }
  void base
  void t
  return {
    next,
    nextInt,
    nextGaussian,
    getState: () => state,
  }
}

export function createGaRngFromState(state: number): GaRng {
  // 状態復元: seed として state を渡し、1回分ずらさないよう専用生成
  let s = state >>> 0
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let r = Math.imul(s ^ (s >>> 15), 1 | s)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
  const nextInt = (min: number, max: number): number => {
    if (max <= min) throw new Error('nextInt invalid range')
    return min + Math.floor(next() * (max - min))
  }
  const nextGaussian = (): number => {
    let sum = 0
    for (let i = 0; i < 12; i += 1) sum += next()
    return sum - 6
  }
  return { next, nextInt, nextGaussian, getState: () => s }
}

/** 決定的な派生シード */
export function deriveSeed(master: number, ...parts: number[]): number {
  let h = master >>> 0
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x9e3779b1) >>> 0
  }
  return h >>> 0
}
