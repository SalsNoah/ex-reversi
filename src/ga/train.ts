import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GA_SPEC_VERSION,
  GENE_FORMAT_VERSION,
  type GaRunConfig,
} from './constants.ts'
import { evaluatePopulation, resetFitness } from './evaluate.ts'
import {
  fixedReferenceGenes,
  geneDiversityStats,
  handcraftedIndividuals,
  randomGenes,
  type Individual,
} from './genes.ts'
import {
  buildSeededPopulation,
  makeIndividualId,
} from './seedPopulation.ts'
import {
  makeImmigrant,
  mutateChild,
  rankByFitness,
  selectTwoDistinctParents,
  uniformCrossover,
} from './operators.ts'
import {
  buildGenerationPanel,
  validationOpponents,
  type ArchiveEntry,
  type PanelEntry,
} from './panel.ts'
import {
  defaultRunDir,
  loadCheckpoint,
  saveCheckpoint,
  saveImmutableIndividual,
  type Checkpoint,
} from './checkpoint.ts'
import { createGaRng, createGaRngFromState, type GaRng } from './rng.ts'
import { notifyTrainingProgress } from './notify.ts'
import { noticeFromCheckpoint } from './status.ts'

export type TrainOptions = {
  runId: string
  masterSeed: number
  config: GaRunConfig
  cwd?: string
  resumePath?: string
  maxMatches?: number
  /** 続き育成: 既存個体を種にする */
  seedIndividuals?: Individual[]
  startGeneration?: number
  pinnedArchive?: ArchiveEntry[]
  extraValidationOpponents?: PanelEntry[]
  configOverride?: Partial<GaRunConfig>
}

function createInitialPopulation(
  config: GaRunConfig,
  rng: GaRng,
  seeds: Individual[] | undefined,
  generation: number,
): Individual[] {
  if (seeds && seeds.length > 0) {
    return buildSeededPopulation(config, rng, seeds, generation)
  }
  const hand = handcraftedIndividuals(generation)
  const pop: Individual[] = [...hand]
  while (pop.length < config.populationSize) {
    pop.push({
      id: makeIndividualId('init', generation, rng),
      generation,
      parentIds: [],
      genes: randomGenes(rng),
      geneFormatVersion: GENE_FORMAT_VERSION,
      origin: 'initial_random',
    })
  }
  return pop.slice(0, config.populationSize)
}

function seedReferenceArchive(): ArchiveEntry[] {
  const refs = fixedReferenceGenes()
  const hand = handcraftedIndividuals(0)
  const now = new Date().toISOString()
  return [
    ...hand.map((h) => ({
      id: h.id,
      generation: 0,
      genes: h.genes.slice(),
      geneFormatVersion: h.geneFormatVersion,
      scoreRate: 0,
      savedAt: now,
    })),
    {
      id: 'seedref-corner',
      generation: -1,
      genes: refs.cornerPos.slice(),
      geneFormatVersion: GENE_FORMAT_VERSION,
      scoreRate: 0,
      savedAt: now,
    },
    {
      id: 'seedref-mobility',
      generation: -1,
      genes: refs.mobility.slice(),
      geneFormatVersion: GENE_FORMAT_VERSION,
      scoreRate: 0,
      savedAt: now,
    },
  ]
}

function breedNext(
  ranked: Individual[],
  config: GaRunConfig,
  generation: number,
  rng: GaRng,
  parentUsage: Record<string, number>,
): Individual[] {
  const elites = ranked.slice(0, config.elites).map((e) => ({
    ...e,
    id: makeIndividualId('elite', generation, rng),
    generation,
    parentIds: [e.id],
    origin: 'elite' as const,
    genes: e.genes.slice(),
    fitness: undefined,
  }))
  const parents = ranked.slice(0, config.parentPool)
  const children: Individual[] = []
  while (children.length < config.offspring) {
    const [a, b] = selectTwoDistinctParents(
      parents,
      rng,
      config.tournamentSize,
    )
    parentUsage[a.id] = (parentUsage[a.id] ?? 0) + 1
    parentUsage[b.id] = (parentUsage[b.id] ?? 0) + 1
    let child = uniformCrossover(
      a,
      b,
      rng,
      makeIndividualId('child', generation, rng),
      generation,
    )
    child = mutateChild(
      child,
      rng,
      config.mutationSigma,
      config.mutationGeneProb,
    )
    children.push(child)
  }
  const immigrants: Individual[] = []
  for (let i = 0; i < config.immigrants; i += 1) {
    immigrants.push(
      makeImmigrant(makeIndividualId('imm', generation, rng), generation, rng),
    )
  }
  const next = [...elites, ...children, ...immigrants]
  if (next.length !== config.populationSize) {
    throw new Error(
      `population size ${next.length} != ${config.populationSize}`,
    )
  }
  return next
}

function printProgress(line: string): void {
  process.stderr.write(`${line}\n`)
}

function runFixedValidation(options: {
  individual: Individual
  masterSeed: number
  generation: number
  extraOpponents?: PanelEntry[]
}): {
  generation: number
  individualId: string
  scoreRate: number
  games: number
} {
  // シードは個体IDに依存させない（保存時ID変化で結果が変わらないようにする）
  const ind: Individual = {
    ...options.individual,
    id: `val-g${options.generation}`,
    fitness: undefined,
  }
  const panel = validationOpponents(options.extraOpponents)
  const completedIds = new Set<string>()
  const counter = { n: 0 }
  evaluatePopulation({
    population: [ind],
    panel,
    generation: options.generation,
    phase: 'extra',
    masterSeed: options.masterSeed ^ 0x5a17da7e,
    seedOffset: 9000 + options.generation,
    completedIds,
    wallStart: performance.now(),
    completedMatchesGlobal: counter,
  })
  return {
    generation: options.generation,
    individualId: options.individual.id,
    scoreRate: ind.fitness?.scoreRate ?? 0,
    games: (ind.fitness?.primaryGames ?? 0) + (ind.fitness?.extraGames ?? 0),
  }
}

export function runGaTraining(options: TrainOptions): Checkpoint {
  const cwd = options.cwd ?? process.cwd()
  const runDir = defaultRunDir(cwd, options.runId)
  if (!options.resumePath && existsSync(join(runDir, 'checkpoint-latest.json'))) {
    throw new Error(
      `run dir exists: ${runDir} — use another --run-id or ga:resume`,
    )
  }
  mkdirSync(runDir, { recursive: true })
  mkdirSync(join(runDir, 'hall_of_fame'), { recursive: true })

  let stopFlag = false
  const onSig = () => {
    stopFlag = true
    printProgress('[ga] stop requested — checkpoint after current match')
  }
  process.on('SIGINT', onSig)
  process.on('SIGTERM', onSig)

  let ckpt: Checkpoint
  let evoRng: GaRng
  let panelRng: GaRng

  if (options.resumePath) {
    ckpt = loadCheckpoint(options.resumePath)
    if (options.configOverride) {
      ckpt.config = { ...ckpt.config, ...options.configOverride }
    }
    evoRng = createGaRngFromState(ckpt.evoRngState)
    panelRng = createGaRngFromState(ckpt.panelRngState)
    ckpt.stoppedReason = undefined
    printProgress(
      `[ga] resume gen=${ckpt.generation} phase=${ckpt.phase} matches=${ckpt.completedMatches} generations=${ckpt.config.generations}`,
    )
  } else {
    evoRng = createGaRng(options.masterSeed)
    panelRng = createGaRng(options.masterSeed ^ 0x0a0a0a0a)
    const startGeneration = options.startGeneration ?? 0
    const seedRefs = seedReferenceArchive()
    const pinned = options.pinnedArchive ?? []
    for (const s of [...seedRefs, ...pinned]) saveImmutableIndividual(runDir, s)
    const population = createInitialPopulation(
      options.config,
      evoRng,
      options.seedIndividuals,
      startGeneration,
    )
    const lastRankedSnapshot = (options.seedIndividuals ?? []).map((s) => ({
      id: s.id,
      genes: s.genes.slice(),
      geneFormatVersion: s.geneFormatVersion,
      scoreRate: s.fitness?.scoreRate ?? 0,
    }))
    ckpt = {
      version: 1,
      runId: options.runId,
      masterSeed: options.masterSeed,
      gaSpecVersion: GA_SPEC_VERSION,
      geneFormatVersion: GENE_FORMAT_VERSION,
      config: options.config,
      generation: startGeneration,
      phase: 'init',
      population,
      panel: [],
      panelNotes: [],
      archive: pinned.map((p) => ({ ...p, genes: p.genes.slice() })),
      seedRefs,
      completedMatchIds: [],
      evoRngState: evoRng.getState(),
      panelRngState: panelRng.getState(),
      completedMatches: 0,
      generationWallMs: 0,
      totalWallMs: 0,
      moveHashCounts: {},
      validationHistory: [],
      parentUsage: {},
      lastRankedSnapshot,
      pinnedArchive: pinned,
      extraValidationOpponents: options.extraValidationOpponents,
    }
    writeFileSync(
      join(runDir, 'config.json'),
      JSON.stringify(
        {
          runId: options.runId,
          masterSeed: options.masterSeed,
          config: options.config,
          gaSpecVersion: GA_SPEC_VERSION,
          startGeneration,
          seedIds: (options.seedIndividuals ?? []).map((s) => s.id),
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  const config = ckpt.config
  const completedIds = new Set(ckpt.completedMatchIds)
  const matchCounter = { n: ckpt.completedMatches }
  const maxMatches = options.maxMatches ?? config.matchSafetyCap
  const wallAll = performance.now()

  try {
    while (ckpt.generation < config.generations) {
      if (stopFlag) {
        ckpt.stoppedReason = 'signal'
        break
      }
      if (matchCounter.n >= maxMatches) {
        ckpt.stoppedReason = 'match_cap'
        break
      }

      if (ckpt.phase === 'done' && ckpt.generation + 1 < config.generations) {
        printProgress(
          `[ga] continue from done gen=${ckpt.generation} -> breed next`,
        )
        ckpt.phase = 'breed'
      }

      const genWall0 = performance.now()
      let rankedPrev: Individual[] | null = null
      if (ckpt.lastRankedSnapshot.length > 0) {
        rankedPrev = ckpt.lastRankedSnapshot.map((a) => ({
          id: a.id,
          generation: ckpt.generation - 1,
          parentIds: [],
          genes: a.genes.slice(),
          geneFormatVersion: a.geneFormatVersion,
          origin: 'elite' as const,
          fitness: {
            primaryScore: 0,
            primaryGames: 0,
            extraScore: 0,
            extraGames: 0,
            scoreRate: a.scoreRate,
            wins: 0,
            draws: 0,
            losses: 0,
            totalStoneDiff: 0,
            byOpponent: {},
          },
        }))
      }

      if (ckpt.phase === 'init' || ckpt.panel.length === 0) {
        const pinned = ckpt.pinnedArchive ?? []
        const archiveCount = Math.max(
          0,
          config.panelArchive - pinned.length,
        )
        const built = buildGenerationPanel({
          rankedPrev,
          archive: ckpt.archive,
          seedRefs: ckpt.seedRefs,
          rng: panelRng,
          pastTop: config.panelPastTop,
          pastOther: config.panelPastOther,
          archiveCount,
          pinned,
        })
        ckpt.panel = built.panel.slice(0, 12)
        while (ckpt.panel.length < 12 && ckpt.seedRefs.length > 0) {
          const ref =
            ckpt.seedRefs[ckpt.panel.length % ckpt.seedRefs.length]!
          ckpt.panel.push({
            panelId: `pad-${ckpt.panel.length}-${ref.id}`,
            spec: {
              kind: 'gene',
              id: `pad-${ref.id}`,
              genes: ref.genes.slice(),
            },
            source: 'pad',
          })
        }
        ckpt.panelNotes = built.notes
        ckpt.phase = 'primary'
        resetFitness(ckpt.population)
        persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
      }

      if (ckpt.phase === 'primary') {
        printProgress(
          `[ga] gen=${ckpt.generation} primary panel=${ckpt.panel.length}`,
        )
        const { stopped, moveHashes } = evaluatePopulation({
          population: ckpt.population,
          panel: ckpt.panel,
          generation: ckpt.generation,
          phase: 'primary',
          masterSeed: ckpt.masterSeed,
          seedOffset: 0,
          gamesPerOpponentSide: config.primaryGamesPerOpponentSide,
          completedIds,
          wallStart: wallAll,
          completedMatchesGlobal: matchCounter,
          shouldStop: () => stopFlag || matchCounter.n >= maxMatches,
          onMatch: (_r, p) => {
            if (p.completedMatches % 64 === 0) {
              printProgress(
                `[ga] matches=${p.completedMatches} ${p.matchesPerSec.toFixed(1)}/s`,
              )
            }
          },
        })
        tallyHashes(ckpt, moveHashes)
        if (stopped) {
          ckpt.stoppedReason = stopFlag ? 'signal' : 'match_cap'
          persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
          break
        }
        ckpt.population = rankByFitness(ckpt.population, evoRng)
        ckpt.phase = 'extra'
        persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
      }

      if (ckpt.phase === 'extra') {
        const top = ckpt.population.slice(0, config.parentPool)
        printProgress(`[ga] gen=${ckpt.generation} extra top=${top.length}`)
        const { stopped, moveHashes } = evaluatePopulation({
          population: top,
          panel: ckpt.panel,
          generation: ckpt.generation,
          phase: 'extra',
          masterSeed: ckpt.masterSeed,
          seedOffset: 100,
          gamesPerOpponentSide: config.extraGamesPerOpponentSide,
          completedIds,
          wallStart: wallAll,
          completedMatchesGlobal: matchCounter,
          shouldStop: () => stopFlag || matchCounter.n >= maxMatches,
          onMatch: (_r, p) => {
            if (p.completedMatches % 64 === 0) {
              printProgress(
                `[ga] matches=${p.completedMatches} ${p.matchesPerSec.toFixed(1)}/s`,
              )
            }
          },
        })
        tallyHashes(ckpt, moveHashes)
        if (stopped) {
          ckpt.stoppedReason = stopFlag ? 'signal' : 'match_cap'
          persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
          break
        }
        ckpt.population = rankByFitness(ckpt.population, evoRng)
        ckpt.lastRankedSnapshot = ckpt.population.map((ind) => ({
          id: ind.id,
          genes: ind.genes.slice(),
          geneFormatVersion: ind.geneFormatVersion,
          scoreRate: ind.fitness?.scoreRate ?? 0,
        }))
        const best = ckpt.population[0]!
        const div = geneDiversityStats(ckpt.population)
        const totalHashes = Object.values(ckpt.moveHashCounts).reduce(
          (a, b) => a + b,
          0,
        )
        const uniqueHashes = Object.keys(ckpt.moveHashCounts).length
        const dupRate =
          totalHashes > 0 ? 1 - uniqueHashes / totalHashes : 0
        printProgress(
          `[ga] gen=${ckpt.generation} bestScore=${(best.fitness?.scoreRate ?? 0).toFixed(3)} uniqueGenes=${div.uniqueGeneCount} moveDup=${dupRate.toFixed(3)}`,
        )
        notifyTrainingProgress(
          noticeFromCheckpoint(ckpt, 'generation-done'),
          { log: false },
        )

        for (const ind of ckpt.population.slice(
          0,
          Math.max(4, config.elites),
        )) {
          const entry: ArchiveEntry = {
            id: `${ind.id}-arch`,
            generation: ckpt.generation,
            genes: ind.genes.slice(),
            geneFormatVersion: ind.geneFormatVersion,
            scoreRate: ind.fitness?.scoreRate ?? 0,
            savedAt: new Date().toISOString(),
          }
          ckpt.archive.push(entry)
          saveImmutableIndividual(runDir, entry)
        }

        if (ckpt.generation % 5 === 0) {
          const val = runFixedValidation({
            individual: best,
            masterSeed: ckpt.masterSeed,
            generation: ckpt.generation,
            extraOpponents: ckpt.extraValidationOpponents,
          })
          ckpt.validationHistory.push(val)
          printProgress(
            `[ga] fixedValidation gen=${ckpt.generation} scoreRate=${val.scoreRate.toFixed(3)} games=${val.games}`,
          )
        }

        ckpt.phase = 'breed'
        ckpt.generationWallMs = performance.now() - genWall0
        ckpt.totalWallMs += ckpt.generationWallMs
        persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
      }

      if (ckpt.phase === 'breed') {
        if (ckpt.generation + 1 >= config.generations) {
          ckpt.phase = 'done'
          persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
          break
        }
        const ranked = rankByFitness(ckpt.population, evoRng)
        ckpt.population = breedNext(
          ranked,
          config,
          ckpt.generation + 1,
          evoRng,
          ckpt.parentUsage,
        )
        ckpt.generation += 1
        ckpt.phase = 'init'
        ckpt.panel = []
        persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
      }
    }
  } finally {
    process.off('SIGINT', onSig)
    process.off('SIGTERM', onSig)
    persist(ckpt, evoRng, panelRng, completedIds, matchCounter, runDir)
  }

  if (ckpt.phase === 'done') {
    notifyTrainingProgress(noticeFromCheckpoint(ckpt, 'finished'), {
      log: false,
    })
  }

  return ckpt
}

function tallyHashes(ckpt: Checkpoint, moveHashes: string[]): void {
  for (const h of moveHashes) {
    ckpt.moveHashCounts[h] = (ckpt.moveHashCounts[h] ?? 0) + 1
  }
}

function persist(
  ckpt: Checkpoint,
  evoRng: GaRng,
  panelRng: GaRng,
  completedIds: Set<string>,
  matchCounter: { n: number },
  runDir: string,
): void {
  ckpt.evoRngState = evoRng.getState()
  ckpt.panelRngState = panelRng.getState()
  ckpt.completedMatchIds = [...completedIds]
  ckpt.completedMatches = matchCounter.n
  const path = saveCheckpoint(runDir, ckpt)
  printProgress(`[ga] saved ${path}`)
}
