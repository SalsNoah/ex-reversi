/**
 * シード付き PRNG（Mulberry32）。
 * ルール層では Math.random を使わず、これを経由する。
 */
export type Rng = {
  /** [0, 1) */
  next: () => number
  /** [min, max) の整数 */
  nextInt: (min: number, max: number) => number
}

export function createRng(seed: number): Rng {
  let t = seed >>> 0

  const next = (): number => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }

  const nextInt = (min: number, max: number): number => {
    if (max <= min) {
      throw new Error(`nextInt: max (${max}) must be greater than min (${min})`)
    }
    return min + Math.floor(next() * (max - min))
  }

  return { next, nextInt }
}

/** 試合シードから最初の同時着手優先側を決める */
export function initialSimultaneousPriority(seed: number): 'black' | 'white' {
  return createRng(seed).next() < 0.5 ? 'black' : 'white'
}

export function oppositeStone(stone: 'black' | 'white'): 'black' | 'white' {
  return stone === 'black' ? 'white' : 'black'
}
