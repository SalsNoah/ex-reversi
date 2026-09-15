import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePopulation, resetFitness } from './evaluate.ts'
import { runGaMatch } from './matchRunner.ts'
import { validationOpponents, type PanelEntry } from './panel.ts'
import type { Individual } from './genes.ts'
import { loadCheckpoint } from './checkpoint.ts'

export type MilestonePick = {
  generation: number
  individualId: string
  genes: number[]
  geneFormatVersion: string
  selectionScoreRate: number
  fixedEvalScoreRate: number
  holdoutEvalScoreRate: number
  vsChampionScoreRate: number | null
  vsChampionGames: number
}

function evalAgainstPanel(
  ind: Individual,
  panel: PanelEntry[],
  label: string,
  masterSeed: number,
  seedOffset: number,
  gamesPerOpponentSide = 1,
): number {
  const evalInd: Individual = {
    ...ind,
    id: label,
    fitness: undefined,
  }
  resetFitness([evalInd])
  const completedIds = new Set<string>()
  const counter = { n: 0 }
  evaluatePopulation({
    population: [evalInd],
    panel,
    generation: ind.generation,
    phase: 'extra',
    masterSeed,
    seedOffset,
    gamesPerOpponentSide,
    completedIds,
    wallStart: performance.now(),
    completedMatchesGlobal: counter,
  })
  return evalInd.fitness?.scoreRate ?? 0
}

function versusChampion(
  genes: number[],
  championGenes: number[],
  gamesPerSide: number,
  seed: number,
): { scoreRate: number; games: number } {
  let points = 0
  let games = 0
  for (let i = 0; i < gamesPerSide; i += 1) {
    for (const side of ['black', 'white'] as const) {
      const matchId = `vs-${side}-${i}`
      const black =
        side === 'black'
          ? { kind: 'gene' as const, id: 'cand', genes, labelId: 'cand' }
          : {
              kind: 'gene' as const,
              id: 'champ',
              genes: championGenes,
              labelId: 'champ',
            }
      const white =
        side === 'white'
          ? { kind: 'gene' as const, id: 'cand', genes, labelId: 'cand' }
          : {
              kind: 'gene' as const,
              id: 'champ',
              genes: championGenes,
              labelId: 'champ',
            }
      const r = runGaMatch({
        matchId,
        seed: (seed + i * 17 + (side === 'black' ? 0 : 1)) >>> 0,
        black,
        white,
        decisionSeed: (seed ^ 0x9e3779b9) >>> 0,
      })
      games += 1
      if (r.outcome === 'draw') points += 0.5
      else if (
        (side === 'black' && r.outcome === 'black_win') ||
        (side === 'white' && r.outcome === 'white_win')
      ) {
        points += 1
      }
    }
  }
  return { scoreRate: games > 0 ? points / games : 0, games }
}

export function pickMilestoneFromCheckpoint(options: {
  checkpointPath: string
  topN?: number
  seed?: number
  champion?: Individual
  extraValidation?: PanelEntry[]
  /** 対代表の各色試合数。未指定は6（計12） */
  versusGamesPerSide?: number
  /** 固定・holdoutの相手×色あたり試合数。未指定は1 */
  panelGamesPerOpponentSide?: number
}): MilestonePick {
  const ckpt = loadCheckpoint(options.checkpointPath)
  const ranked = ckpt.lastRankedSnapshot
  if (ranked.length === 0) {
    throw new Error(`no ranked snapshot: ${options.checkpointPath}`)
  }
  const topN = options.topN ?? 4
  const seed = options.seed ?? 42
  const panelGames = options.panelGamesPerOpponentSide ?? 1
  const candidates = ranked.slice(0, topN)
  let best: MilestonePick | null = null

  for (const c of candidates) {
    const ind: Individual = {
      id: c.id,
      generation: ckpt.generation,
      parentIds: [],
      genes: c.genes.slice(),
      geneFormatVersion: c.geneFormatVersion,
      origin: 'elite',
    }
    const fixed = evalAgainstPanel(
      ind,
      validationOpponents(options.extraValidation),
      `pick-fixed-${c.id}`,
      (seed ^ 0x5a17da7e) >>> 0,
      9000,
      panelGames,
    )
    const holdout = evalAgainstPanel(
      ind,
      validationOpponents(options.extraValidation),
      `pick-holdout-${c.id}`,
      (seed ^ 0x70a7d07) >>> 0,
      7000,
      panelGames,
    )
    const vs = options.champion
      ? versusChampion(
          ind.genes,
          options.champion.genes,
          options.versusGamesPerSide ?? 6,
          seed,
        )
      : { scoreRate: null as number | null, games: 0 }

    const pick: MilestonePick = {
      generation: ckpt.generation,
      individualId: c.id,
      genes: ind.genes,
      geneFormatVersion: ind.geneFormatVersion,
      selectionScoreRate: c.scoreRate,
      fixedEvalScoreRate: fixed,
      holdoutEvalScoreRate: holdout,
      vsChampionScoreRate: vs.scoreRate,
      vsChampionGames: vs.games,
    }
    if (!best || milestoneRank(pick) > milestoneRank(best)) {
      best = pick
    }
  }

  if (!best) throw new Error('no milestone candidate')
  return best
}

/** 固定検証・holdout・対現行代表の順で比較。選抜得点率は使わない。 */
export function milestoneRank(p: MilestonePick): number {
  const vs = p.vsChampionScoreRate ?? 0.5
  return p.fixedEvalScoreRate * 100 + p.holdoutEvalScoreRate * 10 + vs
}

export function readExistingMilestonesFile(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

export function writeJsonReport(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

export function defaultCheckpointPath(
  cwd: string,
  runId: string,
  generation: number,
): string {
  return join(
    cwd,
    'training',
    'ga_runs',
    runId,
    `checkpoint-gen${generation}.json`,
  )
}
