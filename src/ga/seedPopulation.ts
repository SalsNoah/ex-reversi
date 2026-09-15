import { GENE_FORMAT_VERSION, type GaRunConfig } from './constants.ts'
import {
  genesEqual,
  handcraftedIndividuals,
  type Individual,
} from './genes.ts'
import { makeImmigrant, mutateChild } from './operators.ts'
import type { GaRng } from './rng.ts'

export function makeIndividualId(
  prefix: string,
  generation: number,
  rng: GaRng,
): string {
  return `${prefix}-g${generation}-${rng.nextInt(0, 1e9).toString(36)}`
}

function uniqueByGenes(seeds: Individual[]): Individual[] {
  const out: Individual[] = []
  for (const s of seeds) {
    if (out.some((x) => genesEqual(x.genes, s.genes))) continue
    out.push(s)
  }
  return out
}

/**
 * 既存の強い個体を種にした初期集団。
 * 現行アプリ代表の近傍を重点的に探索し、残りは手製＋新規で多様性を足す。
 */
export function buildSeededPopulation(
  config: GaRunConfig,
  rng: GaRng,
  seeds: Individual[],
  generation: number,
): Individual[] {
  if (seeds.length === 0) {
    throw new Error('buildSeededPopulation requires at least one seed')
  }
  const unique = uniqueByGenes(seeds)
  const primary = unique[0]!
  const pop: Individual[] = []

  const copyLimit = Math.min(8, unique.length, config.populationSize)
  for (let i = 0; i < copyLimit; i += 1) {
    const s = unique[i]!
    pop.push({
      id: makeIndividualId('seed', generation, rng),
      generation,
      parentIds: [s.id],
      genes: s.genes.slice(),
      geneFormatVersion: s.geneFormatVersion || GENE_FORMAT_VERSION,
      origin: 'elite',
    })
  }

  const mutantTarget = Math.min(
    32,
    config.populationSize - 3 - config.immigrants,
  )
  while (pop.length < mutantTarget) {
    const child = mutateChild(
      {
        id: makeIndividualId('seedmut', generation, rng),
        generation,
        parentIds: [primary.id],
        genes: primary.genes.slice(),
        geneFormatVersion: GENE_FORMAT_VERSION,
        origin: 'offspring',
      },
      rng,
      config.mutationSigma,
      config.mutationGeneProb,
    )
    pop.push(child)
  }

  for (const h of handcraftedIndividuals(generation)) {
    if (pop.length >= config.populationSize) break
    pop.push(h)
  }

  while (pop.length < config.populationSize) {
    pop.push(
      makeImmigrant(
        makeIndividualId('seedimm', generation, rng),
        generation,
        rng,
      ),
    )
  }

  return pop.slice(0, config.populationSize)
}
