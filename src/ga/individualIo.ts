import { readFileSync } from 'node:fs'
import { GENE_FORMAT_VERSION } from './constants.ts'
import type { Individual } from './genes.ts'

export function loadIndividualFromPath(path: string): Individual {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    id: string
    generation?: number
    genes: number[]
    geneFormatVersion?: string
    parentIds?: string[]
    origin?: Individual['origin']
    fitness?: Individual['fitness']
    scoreRate?: number
  }
  return {
    id: raw.id,
    generation: raw.generation ?? 0,
    parentIds: raw.parentIds ?? [],
    genes: raw.genes.slice(),
    geneFormatVersion: raw.geneFormatVersion ?? GENE_FORMAT_VERSION,
    origin: raw.origin ?? 'elite',
    fitness: raw.fitness,
  }
}
