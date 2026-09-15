import {
  GENE_CLAMP_MAX,
  GENE_CLAMP_MIN,
  GENE_FORMAT_VERSION,
  GENE_LENGTH,
} from './constants.ts'
import {
  clampGene,
  randomGenes,
  type Individual,
} from './genes.ts'
import type { GaRng } from './rng.ts'

export function cloneGenes(genes: number[]): number[] {
  return genes.slice()
}

export function uniformCrossover(
  a: Individual,
  b: Individual,
  rng: GaRng,
  childId: string,
  generation: number,
): Individual {
  const genes: number[] = []
  for (let i = 0; i < GENE_LENGTH; i += 1) {
    genes.push(rng.next() < 0.5 ? a.genes[i]! : b.genes[i]!)
  }
  return {
    id: childId,
    generation,
    parentIds: [a.id, b.id],
    genes,
    geneFormatVersion: GENE_FORMAT_VERSION,
    origin: 'offspring',
  }
}

export function mutateInPlace(genes: number[], rng: GaRng, sigma: number, geneProb: number): number {
  let mutated = 0
  const hits: number[] = []
  for (let i = 0; i < genes.length; i += 1) {
    if (rng.next() < geneProb) {
      genes[i] = clampGene(genes[i]! + rng.nextGaussian() * sigma)
      mutated += 1
      hits.push(i)
    }
  }
  if (mutated === 0) {
    const i = rng.nextInt(0, genes.length)
    genes[i] = clampGene(genes[i]! + rng.nextGaussian() * sigma)
    mutated = 1
  }
  void GENE_CLAMP_MIN
  void GENE_CLAMP_MAX
  return mutated
}

export function mutateChild(
  child: Individual,
  rng: GaRng,
  sigma: number,
  geneProb: number,
): Individual {
  const genes = cloneGenes(child.genes)
  mutateInPlace(genes, rng, sigma, geneProb)
  return { ...child, genes }
}

export function makeImmigrant(
  id: string,
  generation: number,
  rng: GaRng,
): Individual {
  return {
    id,
    generation,
    parentIds: [],
    genes: randomGenes(rng),
    geneFormatVersion: GENE_FORMAT_VERSION,
    origin: 'immigrant',
  }
}

export function tournamentSelect(
  pool: Individual[],
  rng: GaRng,
  size: number,
): Individual {
  let best = pool[rng.nextInt(0, pool.length)]!
  for (let i = 1; i < size; i += 1) {
    const cand = pool[rng.nextInt(0, pool.length)]!
    const bf = best.fitness?.scoreRate ?? -1
    const cf = cand.fitness?.scoreRate ?? -1
    if (cf > bf) best = cand
    else if (cf === bf && rng.next() < 0.5) best = cand
  }
  return best
}

export function selectTwoDistinctParents(
  pool: Individual[],
  rng: GaRng,
  tournamentSize: number,
): [Individual, Individual] {
  const a = tournamentSelect(pool, rng, tournamentSize)
  let b = tournamentSelect(pool, rng, tournamentSize)
  let guard = 0
  while (b.id === a.id && guard < 50) {
    b = tournamentSelect(pool, rng, tournamentSize)
    guard += 1
  }
  if (b.id === a.id) {
    b = pool.find((p) => p.id !== a.id) ?? a
  }
  return [a, b]
}

/** 同点はシード付き抽選で安定ソート */
export function rankByFitness(pop: Individual[], rng: GaRng): Individual[] {
  const keyed = pop.map((ind) => ({
    ind,
    key: ind.fitness?.scoreRate ?? -1,
    tie: rng.next(),
  }))
  keyed.sort((a, b) => {
    if (b.key !== a.key) return b.key - a.key
    return a.tie - b.tie
  })
  return keyed.map((k) => k.ind)
}
