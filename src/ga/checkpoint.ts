import {
  mkdirSync,
  renameSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  copyFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { GaRunConfig } from './constants.ts'
import type { Individual } from './genes.ts'
import type { ArchiveEntry, PanelEntry } from './panel.ts'

export type Checkpoint = {
  version: number
  runId: string
  masterSeed: number
  gaSpecVersion: string
  geneFormatVersion: string
  config: GaRunConfig
  generation: number
  phase: 'init' | 'primary' | 'extra' | 'breed' | 'done'
  population: Individual[]
  panel: PanelEntry[]
  panelNotes: string[]
  archive: ArchiveEntry[]
  seedRefs: ArchiveEntry[]
  completedMatchIds: string[]
  evoRngState: number
  panelRngState: number
  completedMatches: number
  generationWallMs: number
  totalWallMs: number
  moveHashCounts: Record<string, number>
  validationHistory: Array<{
    generation: number
    individualId: string
    scoreRate: number
    games: number
  }>
  parentUsage: Record<string, number>
  /** 前世代の全個体順位（パネル用。遺伝子のみ） */
  lastRankedSnapshot: Array<{
    id: string
    genes: number[]
    geneFormatVersion: string
    scoreRate: number
  }>
  stoppedReason?: string
  /** 世代を通してパネルに残す相手（続き育成用。旧チェックポイントには無い） */
  pinnedArchive?: ArchiveEntry[]
  extraValidationOpponents?: PanelEntry[]
}

export function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    // Windows / OneDrive では既存ファイルへの rename が EPERM になることがある
    try {
      if (existsSync(path)) unlinkSync(path)
      renameSync(tmp, path)
    } catch {
      copyFileSync(tmp, path)
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  }
}

export function saveCheckpoint(dir: string, ckpt: Checkpoint): string {
  const path = join(dir, `checkpoint-gen${ckpt.generation}.json`)
  atomicWriteJson(path, ckpt)
  atomicWriteJson(join(dir, 'checkpoint-latest.json'), ckpt)
  return path
}

export function loadCheckpoint(path: string): Checkpoint {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Checkpoint
  if (!raw.lastRankedSnapshot) raw.lastRankedSnapshot = []
  return raw
}

export function saveImmutableIndividual(
  dir: string,
  entry: ArchiveEntry,
): void {
  const path = join(dir, 'hall_of_fame', `${entry.id}.json`)
  if (existsSync(path)) return // 変更不能: 既存があれば書かない
  atomicWriteJson(path, entry)
}

export function defaultRunDir(cwd: string, runId: string): string {
  return join(cwd, 'training', 'ga_runs', runId)
}
