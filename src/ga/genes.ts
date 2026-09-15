import {
  FEATURE_COUNT,
  GENE_CLAMP_MAX,
  GENE_CLAMP_MIN,
  GENE_FORMAT_VERSION,
  GENE_INIT_MAX,
  GENE_INIT_MIN,
  GENE_LENGTH,
  PHASE_COUNT,
} from './constants.ts'
import type { GaRng } from './rng.ts'

export type OriginKind = 'initial_random' | 'initial_handcrafted' | 'elite' | 'offspring' | 'immigrant'

export type Individual = {
  id: string
  generation: number
  parentIds: string[]
  genes: number[]
  geneFormatVersion: string
  origin: OriginKind
  /** 選抜用合算得点率など（世代内で更新） */
  fitness?: IndividualFitness
}

export type IndividualFitness = {
  primaryScore: number
  primaryGames: number
  extraScore: number
  extraGames: number
  /** (primaryScore+extraScore) / (primaryGames+extraGames) */
  scoreRate: number
  wins: number
  draws: number
  losses: number
  totalStoneDiff: number
  byOpponent: Record<
    string,
    { wins: number; draws: number; losses: number; score: number; games: number }
  >
}

export function clampGene(v: number): number {
  return Math.min(GENE_CLAMP_MAX, Math.max(GENE_CLAMP_MIN, v))
}

export function randomGenes(rng: GaRng): number[] {
  const genes: number[] = []
  for (let i = 0; i < GENE_LENGTH; i += 1) {
    genes.push(
      GENE_INIT_MIN + rng.next() * (GENE_INIT_MAX - GENE_INIT_MIN),
    )
  }
  return genes
}

/** 進行度 t∈[0,1] で early/mid/late の12重みを線形補間 */
export function interpolateWeights(genes: number[], progress: number): number[] {
  if (genes.length !== GENE_LENGTH) {
    throw new Error(`genes length ${genes.length} != ${GENE_LENGTH}`)
  }
  const early = genes.slice(0, FEATURE_COUNT)
  const mid = genes.slice(FEATURE_COUNT, FEATURE_COUNT * 2)
  const late = genes.slice(FEATURE_COUNT * 2, FEATURE_COUNT * 3)
  const t = Math.min(1, Math.max(0, progress))
  const out: number[] = []
  if (t <= 0.5) {
    const u = t / 0.5
    for (let i = 0; i < FEATURE_COUNT; i += 1) {
      out.push(early[i]! * (1 - u) + mid[i]! * u)
    }
  } else {
    const u = (t - 0.5) / 0.5
    for (let i = 0; i < FEATURE_COUNT; i += 1) {
      out.push(mid[i]! * (1 - u) + late[i]! * u)
    }
  }
  return out
}

export function scoreFeatures(features: number[], weights: number[]): number {
  let s = 0
  for (let i = 0; i < FEATURE_COUNT; i += 1) {
    s += features[i]! * weights[i]!
  }
  return s
}

function fillPhases(base12: number[]): number[] {
  const g: number[] = []
  for (let p = 0; p < PHASE_COUNT; p += 1) g.push(...base12)
  return g
}

/** 手動設定の初期個体（学習済みではない） */
export function handcraftedIndividuals(generation: number): Individual[] {
  const stone = fillPhases([
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ])
  const corner = fillPhases([
    0.2, 1, 0, 0, 0, 0, -0.5, 0.5, 0.3, 0, 0, 0,
  ])
  const mobility = fillPhases([
    0.1, 0.2, 0.5, -1, 0, 0, 0, 0, 0.1, 0, 0, 0,
  ])
  return [
    {
      id: `hand-stone-g${generation}`,
      generation,
      parentIds: [],
      genes: stone,
      geneFormatVersion: GENE_FORMAT_VERSION,
      origin: 'initial_handcrafted',
    },
    {
      id: `hand-corner-g${generation}`,
      generation,
      parentIds: [],
      genes: corner,
      geneFormatVersion: GENE_FORMAT_VERSION,
      origin: 'initial_handcrafted',
    },
    {
      id: `hand-mobility-g${generation}`,
      generation,
      parentIds: [],
      genes: mobility,
      geneFormatVersion: GENE_FORMAT_VERSION,
      origin: 'initial_handcrafted',
    },
  ]
}

/** 固定検証・パネル用の不変係数CPU */
export function fixedReferenceGenes(): {
  cornerPos: number[]
  mobility: number[]
} {
  return {
    cornerPos: fillPhases([0.2, 1, 0.1, -0.2, 0, 0, -0.8, 0.4, 0.4, -0.1, 0.05, 0]),
    mobility: fillPhases([0.15, 0.3, 0.8, -1, 0.1, -0.1, -0.2, 0.1, 0.2, 0, 0.1, 0]),
  }
}

export function genesEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function geneDiversityStats(pop: Individual[]): {
  uniqueGeneCount: number
  meanAbs: number
  std: number
} {
  const seen = new Set<string>()
  const all: number[] = []
  for (const ind of pop) {
    seen.add(ind.genes.map((g) => g.toFixed(6)).join(','))
    all.push(...ind.genes)
  }
  const mean = all.reduce((s, x) => s + x, 0) / Math.max(1, all.length)
  const meanAbs = all.reduce((s, x) => s + Math.abs(x), 0) / Math.max(1, all.length)
  const variance =
    all.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, all.length)
  return {
    uniqueGeneCount: seen.size,
    meanAbs,
    std: Math.sqrt(variance),
  }
}
