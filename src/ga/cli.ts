import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_GA_CONFIG,
  GENE_FORMAT_VERSION,
  SMOKE_GA_CONFIG,
  type GaRunConfig,
} from './constants.ts'
import { defaultRunDir, loadCheckpoint } from './checkpoint.ts'
import { evaluatePopulation } from './evaluate.ts'
import {
  handcraftedIndividuals,
  type Individual,
} from './genes.ts'
import { loadIndividualFromPath } from './individualIo.ts'
import { validationOpponents, type ArchiveEntry, type PanelEntry } from './panel.ts'
import {
  defaultCheckpointPath,
  pickMilestoneFromCheckpoint,
  writeJsonReport,
} from './pickMilestone.ts'
import { runGaTraining } from './train.ts'
import { runInstalledRoundRobin, writeRoundRobinReport } from './tournament.ts'
import { notifyTrainingProgress } from './notify.ts'
import {
  latestCompletedGeneration,
  readTrainingStatus,
  watchTrainingStatus,
} from './status.ts'
import { renderGaMilestonesSource, type MilestoneRecord } from './writeMilestones.ts'
import { GA_MILESTONES, strongestMilestone, type GaMilestoneId } from '../cpu/gaMilestones.ts'

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return undefined
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

function parseConfig(base: GaRunConfig, argv: string[]): GaRunConfig {
  const cfg = { ...base }
  const gens = argValue(argv, '--generations')
  if (gens) cfg.generations = Number(gens)
  const pop = argValue(argv, '--population')
  if (pop) cfg.populationSize = Number(pop)
  const cap = argValue(argv, '--max-matches')
  if (cap) cfg.matchSafetyCap = Number(cap)
  const primary = argValue(argv, '--primary-games')
  if (primary) cfg.primaryGamesPerOpponentSide = Number(primary)
  const extra = argValue(argv, '--extra-games')
  if (extra) cfg.extraGamesPerOpponentSide = Number(extra)
  return cfg
}

function championPanel(champion: Individual): PanelEntry {
  return {
    panelId: `champion-${champion.id}`,
    spec: {
      kind: 'gene',
      id: `champion-${champion.id}`,
      genes: champion.genes.slice(),
    },
    source: 'app_champion',
  }
}

function individualsFromMilestones(): Individual[] {
  return [...GA_MILESTONES]
    .sort((a, b) => b.generation - a.generation)
    .map((m) => ({
      id: m.sourceId,
      generation: 0,
      parentIds: [],
      genes: [...m.genes],
      geneFormatVersion: m.geneFormatVersion,
      origin: 'elite' as const,
    }))
}

function printTrainResult(
  out: ReturnType<typeof runGaTraining>,
  cwd: string,
): void {
  console.log(
    JSON.stringify(
      {
        runId: out.runId,
        generation: out.generation,
        phase: out.phase,
        completedMatches: out.completedMatches,
        stoppedReason: out.stoppedReason ?? null,
        bestScoreRate: out.lastRankedSnapshot[0]?.scoreRate ?? null,
        validationHistory: out.validationHistory,
        totalWallMs: out.totalWallMs,
        dir: defaultRunDir(cwd, out.runId),
      },
      null,
      2,
    ),
  )
}

function evaluateCommand(argv: string[]): void {
  const runId = argValue(argv, '--run-id')
  const individualPath = argValue(argv, '--individual')
  const seed = Number(argValue(argv, '--seed') ?? '42')
  const label = argValue(argv, '--label') ?? 'eval'
  const holdout = hasFlag(argv, '--holdout')
  const cwd = process.cwd()

  let ind: Individual
  if (individualPath) {
    ind = loadIndividualFromPath(individualPath)
  } else if (runId) {
    const dir = defaultRunDir(cwd, runId)
    const ckpt = loadCheckpoint(join(dir, 'checkpoint-latest.json'))
    const best = ckpt.lastRankedSnapshot[0]
    if (!best) throw new Error('no ranked snapshot in checkpoint')
    ind = {
      id: best.id,
      generation: ckpt.generation,
      parentIds: [],
      genes: best.genes.slice(),
      geneFormatVersion: best.geneFormatVersion,
      origin: 'elite',
    }
  } else {
    ind = handcraftedIndividuals(0)[0]!
  }

  const championPath = argValue(argv, '--champion')
  const extra = championPath
    ? [championPanel(loadIndividualFromPath(championPath))]
    : []
  const panel = validationOpponents(extra)
  const completedIds = new Set<string>()
  const counter = { n: 0 }
  const wallStart = performance.now()
  const masterSeed = holdout
    ? (seed ^ 0x70a7d07) >>> 0
    : (seed ^ 0x5a17da7e) >>> 0
  const evalInd: Individual = {
    ...ind,
    id: `eval-${label}`,
    fitness: undefined,
  }
  evaluatePopulation({
    population: [evalInd],
    panel,
    generation: ind.generation,
    phase: 'extra',
    masterSeed,
    seedOffset: holdout ? 7000 : 9000,
    completedIds,
    wallStart,
    completedMatchesGlobal: counter,
  })

  const elapsed = (performance.now() - wallStart) / 1000
  const report = {
    label,
    holdout,
    individualId: ind.id,
    generation: ind.generation,
    scoreRate: evalInd.fitness?.scoreRate ?? 0,
    wins: evalInd.fitness?.wins ?? 0,
    draws: evalInd.fitness?.draws ?? 0,
    losses: evalInd.fitness?.losses ?? 0,
    games: counter.n,
    matchesPerSec: elapsed > 0 ? counter.n / elapsed : 0,
    byOpponent: evalInd.fitness?.byOpponent ?? {},
    panelIds: panel.map((p) => p.panelId),
  }
  console.log(JSON.stringify(report, null, 2))

  if (runId) {
    const outPath = join(
      defaultRunDir(cwd, runId),
      `eval-${label}${holdout ? '-holdout' : ''}.json`,
    )
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')
    console.error(`wrote ${outPath}`)
  }
}

function tournamentCommand(argv: string[]): void {
  const gamesArg = argValue(argv, '--games')
  const gamesPerPair = gamesArg ? Number(gamesArg) : undefined
  const firstTo = gamesPerPair ? 0 : Number(argValue(argv, '--first-to') ?? '10')
  const seed = Number(argValue(argv, '--seed') ?? '20260915')
  const idsArg = argValue(argv, '--ids')
  const playerIds = idsArg
    ? idsArg.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
    : undefined
  const cwd = process.cwd()
  const defaultName = gamesPerPair
    ? `round-robin-n${gamesPerPair}.json`
    : `round-robin-ft${firstTo}.json`
  const outPath =
    argValue(argv, '--out') ??
    join(defaultRunDir(cwd, 'ga1-train-004'), defaultName)
  const report = runInstalledRoundRobin({
    firstTo,
    gamesPerPair,
    playerIds,
    masterSeed: seed,
    onSeries: (pairing, index, total) => {
      const score = `${pairing.aWins}-${pairing.bWins}`
      const winner = pairing.winnerId ?? 'draw'
      console.error(
        `[ga] series ${index}/${total} ${pairing.aId} vs ${pairing.bId} ${score} (${pairing.draws}d) winner=${winner}`,
      )
    },
  })
  writeRoundRobinReport(outPath, report)
  console.log(JSON.stringify({ ...report, pairings: undefined }, null, 2))
  console.error(`wrote ${outPath}`)
}

function defaultSeedPaths(cwd: string, fromRun: string): string[] {
  const hof = join(defaultRunDir(cwd, fromRun), 'hall_of_fame')
  return [
    join(hof, 'elite-g20-aklou8-arch.json'),
    join(hof, 'elite-g20-947lhq-arch.json'),
    join(hof, 'elite-g15-6smuy0-arch.json'),
    join(hof, 'elite-g10-7u0nr8-arch.json'),
    join(hof, 'child-g10-2r4i2i-arch.json'),
  ]
}

function continueCommand(argv: string[]): void {
  const cwd = process.cwd()
  const fromMilestones = hasFlag(argv, '--from-milestones')
  const fromBest = hasFlag(argv, '--from-best')
  const runId =
    argValue(argv, '--run-id') ??
    (fromBest
      ? 'ga1-train-004'
      : fromMilestones
        ? 'ga1-train-003'
        : 'ga1-train-002')
  const fromRun = argValue(argv, '--from-run') ?? 'ga1-train-001'
  const seed = Number(argValue(argv, '--seed') ?? '20260915')
  const startGeneration = Number(
    argValue(argv, '--start-generation') ??
      (fromBest || fromMilestones ? '1' : '21'),
  )
  const config = parseConfig(
    {
      ...DEFAULT_GA_CONFIG,
      ...(fromBest
        ? {
            generations: 21,
            matchSafetyCap: 2_000_000,
            // レポート: 一次は据え置き、上位の追加を各色3（+72/個体）
            primaryGamesPerOpponentSide: 1,
            extraGamesPerOpponentSide: 3,
          }
        : fromMilestones
          ? { generations: 16, matchSafetyCap: 250_000 }
          : {}),
    },
    argv,
  )
  const maxMatches = argValue(argv, '--max-matches')
    ? Number(argValue(argv, '--max-matches'))
    : undefined

  const seeds: Individual[] = []
  if (fromBest) {
    const best = strongestMilestone()
    seeds.push({
      id: best.sourceId,
      generation: 0,
      parentIds: [],
      genes: [...best.genes],
      geneFormatVersion: best.geneFormatVersion,
      origin: 'elite',
    })
  } else if (fromMilestones) {
    seeds.push(...individualsFromMilestones())
    const g10 = join(
      defaultRunDir(cwd, fromRun),
      'hall_of_fame',
      'child-g10-2r4i2i-arch.json',
    )
    if (existsSync(g10)) {
      const ind = loadIndividualFromPath(g10)
      if (!seeds.some((s) => s.id === ind.id)) seeds.push(ind)
    }
  } else {
    const championPath =
      argValue(argv, '--champion') ??
      join(
        defaultRunDir(cwd, fromRun),
        'hall_of_fame',
        'elite-g20-aklou8-arch.json',
      )
    if (!existsSync(championPath)) {
      throw new Error(`champion not found: ${championPath}`)
    }
    seeds.push(loadIndividualFromPath(championPath))
    for (const p of defaultSeedPaths(cwd, fromRun)) {
      if (!existsSync(p)) continue
      const ind = loadIndividualFromPath(p)
      if (seeds.some((s) => s.id === ind.id)) continue
      seeds.push(ind)
    }
  }

  if (seeds.length === 0) {
    throw new Error('no seed individuals')
  }
  const champion = seeds[0]!

  const pinned: ArchiveEntry[] = [
    {
      id: champion.id,
      generation: champion.generation,
      genes: champion.genes.slice(),
      geneFormatVersion: champion.geneFormatVersion || GENE_FORMAT_VERSION,
      scoreRate: champion.fitness?.scoreRate ?? 0,
      savedAt: new Date().toISOString(),
    },
  ]

  const extra = [championPanel(champion)]
  const out = runGaTraining({
    runId,
    masterSeed: seed,
    config,
    cwd,
    maxMatches,
    seedIndividuals: seeds,
    startGeneration,
    pinnedArchive: pinned,
    extraValidationOpponents: extra,
  })
  printTrainResult(out, cwd)
}

function pickMilestoneCommand(argv: string[]): void {
  const cwd = process.cwd()
  const runId = argValue(argv, '--run-id') ?? 'ga1-train-002'
  const generation = Number(argValue(argv, '--generation') ?? '30')
  const seed = Number(argValue(argv, '--seed') ?? '42')
  const milestoneId = (argValue(argv, '--id') ??
    `ga_g${generation}`) as GaMilestoneId
  const fromRun = argValue(argv, '--from-run') ?? 'ga1-train-001'
  const championPath = argValue(argv, '--champion')
  const checkpointPath =
    argValue(argv, '--checkpoint') ??
    defaultCheckpointPath(cwd, runId, generation)
  if (!existsSync(checkpointPath)) {
    throw new Error(`checkpoint not found: ${checkpointPath}`)
  }
  let champion: Individual | undefined
  if (championPath && existsSync(championPath)) {
    champion = loadIndividualFromPath(championPath)
  } else if (GA_MILESTONES.length > 0) {
    const best = strongestMilestone()
    champion = {
      id: best.sourceId,
      generation: best.generation,
      parentIds: [],
      genes: [...best.genes],
      geneFormatVersion: best.geneFormatVersion,
      origin: 'elite',
    }
  } else {
    const fallback = join(
      defaultRunDir(cwd, fromRun),
      'hall_of_fame',
      'elite-g20-aklou8-arch.json',
    )
    if (existsSync(fallback)) champion = loadIndividualFromPath(fallback)
  }
  const extra = champion ? [championPanel(champion)] : []
  const versusGamesPerSide = Number(
    argValue(argv, '--versus-games') ?? (runId === 'ga1-train-004' ? '95' : '6'),
  )
  const panelGamesPerOpponentSide = Number(
    argValue(argv, '--panel-games') ?? (runId === 'ga1-train-004' ? '8' : '1'),
  )
  const pick = pickMilestoneFromCheckpoint({
    checkpointPath,
    seed,
    champion,
    extraValidation: extra,
    versusGamesPerSide,
    panelGamesPerOpponentSide,
  })
  const record: MilestoneRecord = {
    id: milestoneId,
    generation: pick.generation,
    sourceId: pick.individualId,
    runId,
    geneFormatVersion: pick.geneFormatVersion,
    selectionScoreRate: pick.selectionScoreRate,
    fixedEvalScoreRate: pick.fixedEvalScoreRate,
    holdoutEvalScoreRate: pick.holdoutEvalScoreRate,
    vsChampionScoreRate: pick.vsChampionScoreRate,
    genes: pick.genes,
  }
  console.log(JSON.stringify({ ...pick, id: milestoneId }, null, 2))
  writeJsonReport(
    join(defaultRunDir(cwd, runId), `milestone-${milestoneId}.json`),
    record,
  )

  if (hasFlag(argv, '--write-cpu')) {
    const next: MilestoneRecord[] = hasFlag(argv, '--reset-milestones')
      ? []
      : GA_MILESTONES.filter((m) => m.id !== milestoneId).map((m) => ({
          ...m,
          genes: [...m.genes],
        }))
    next.push({ ...record, genes: [...record.genes] })
    next.sort((a, b) => a.generation - b.generation)
    const outPath = join(cwd, 'src', 'cpu', 'gaMilestones.ts')
    writeFileSync(outPath, renderGaMilestonesSource(next), 'utf8')
    console.error(`wrote ${outPath}`)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'help'
  const cwd = process.cwd()

  if (command === 'smoke') {
    const runId = argValue(argv, '--run-id') ?? 'ga1-smoke-001'
    const seed = Number(argValue(argv, '--seed') ?? '20260913')
    const maxMatches = argValue(argv, '--max-matches')
      ? Number(argValue(argv, '--max-matches'))
      : undefined
    const config = parseConfig({ ...SMOKE_GA_CONFIG }, argv)
    const out = runGaTraining({
      runId,
      masterSeed: seed,
      config,
      cwd,
      maxMatches,
    })
    printTrainResult(out, cwd)
    return
  }

  if (command === 'train') {
    const runId = argValue(argv, '--run-id') ?? 'ga1-train-001'
    const seed = Number(argValue(argv, '--seed') ?? '20260913')
    const maxMatches = argValue(argv, '--max-matches')
      ? Number(argValue(argv, '--max-matches'))
      : undefined
    const config = parseConfig({ ...DEFAULT_GA_CONFIG }, argv)
    const out = runGaTraining({
      runId,
      masterSeed: seed,
      config,
      cwd,
      maxMatches,
    })
    printTrainResult(out, cwd)
    return
  }

  if (command === 'continue') {
    continueCommand(argv)
    return
  }

  if (command === 'pick-milestone') {
    pickMilestoneCommand(argv)
    return
  }

  if (command === 'resume') {
    const runId = argValue(argv, '--run-id')
    const pathArg = argValue(argv, '--checkpoint')
    if (!runId && !pathArg) {
      console.error('ga:resume requires --run-id or --checkpoint')
      process.exitCode = 1
      return
    }
    const resumePath =
      pathArg ?? join(defaultRunDir(cwd, runId!), 'checkpoint-latest.json')
    if (!existsSync(resumePath)) {
      console.error(`checkpoint not found: ${resumePath}`)
      process.exitCode = 1
      return
    }
    const existing = loadCheckpoint(resumePath)
    const maxMatches = argValue(argv, '--max-matches')
      ? Number(argValue(argv, '--max-matches'))
      : undefined
    const gens = argValue(argv, '--generations')
    const configOverride = gens
      ? { generations: Number(gens) }
      : undefined
    const out = runGaTraining({
      runId: existing.runId,
      masterSeed: existing.masterSeed,
      config: existing.config,
      cwd,
      resumePath,
      maxMatches,
      configOverride,
    })
    printTrainResult(out, cwd)
    return
  }

  if (command === 'evaluate') {
    evaluateCommand(argv)
    return
  }

  if (command === 'tournament') {
    tournamentCommand(argv)
    return
  }

  if (command === 'status') {
    const runId = argValue(argv, '--run-id') ?? 'ga1-train-004'
    const doNotify = hasFlag(argv, '--notify')
    const watch = hasFlag(argv, '--watch')
    const intervalMs =
      Number(argValue(argv, '--interval') ?? '20') * 1000
    if (watch) {
      watchTrainingStatus({
        cwd,
        runId,
        intervalMs,
        notify: doNotify,
        log: (line) => process.stderr.write(`${line}\n`),
      })
      return
    }
    const status = readTrainingStatus(cwd, runId)
    console.log(JSON.stringify(status, null, 2))
    if (!status.exists) {
      process.stderr.write(`[ga] checkpoint not found: ${status.path}\n`)
      process.exitCode = 1
      return
    }
    if (doNotify) {
      const completed = latestCompletedGeneration(status)
      if (completed === null) {
        process.stderr.write(
          `[ga] まだ終わった世代はない（現在 第${status.generation}世代 ${status.phase}）\n`,
        )
        return
      }
      notifyTrainingProgress({
        ...status,
        generation: completed,
        kind:
          status.phase === 'done' && completed === status.generation
            ? 'finished'
            : 'generation-done',
      })
    }
    return
  }

  console.error(`未知のコマンド: ${command}`)
  console.error(
    '使い方: smoke|train|continue|resume|evaluate|pick-milestone|tournament|status [--run-id ID] [--seed N] [--max-matches N] [--generations N]',
  )
  process.exitCode = 1
}

main()
