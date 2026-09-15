import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRunDir, loadCheckpoint } from './checkpoint.ts'
import {
  campaignTargetGenerations,
  notifyTrainingProgress,
  type TrainingNotice,
} from './notify.ts'

export function noticeFromCheckpoint(
  ckpt: {
    runId: string
    generation: number
    phase: string
    completedMatches: number
    config: { generations: number }
    lastRankedSnapshot: Array<{ scoreRate: number }>
  },
  kind: TrainingNotice['kind'],
): TrainingNotice {
  return {
    runId: ckpt.runId,
    generation: ckpt.generation,
    phase: ckpt.phase,
    completedMatches: ckpt.completedMatches,
    campaignTarget: campaignTargetGenerations(
      ckpt.runId,
      ckpt.config.generations,
    ),
    chunkEndGeneration: Math.max(0, ckpt.config.generations - 1),
    bestScoreRate: ckpt.lastRankedSnapshot[0]?.scoreRate ?? null,
    kind,
  }
}

export type TrainingStatusSnapshot = TrainingNotice & {
  exists: boolean
  path: string
}

export function readTrainingStatus(
  cwd: string,
  runId: string,
): TrainingStatusSnapshot {
  const path = join(defaultRunDir(cwd, runId), 'checkpoint-latest.json')
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      runId,
      generation: 0,
      phase: 'none',
      completedMatches: 0,
      campaignTarget: campaignTargetGenerations(runId, 0),
      chunkEndGeneration: 0,
      bestScoreRate: null,
      kind: 'current',
    }
  }
  const ckpt = loadCheckpoint(path)
  return {
    exists: true,
    path,
    ...noticeFromCheckpoint(ckpt, 'current'),
  }
}

/** いま終わっている世代。評価中ならその前の世代。まだ1世代も終わっていなければ null */
export function latestCompletedGeneration(status: {
  exists: boolean
  generation: number
  phase: string
}): number | null {
  if (!status.exists) return null
  if (status.phase === 'done' || status.phase === 'breed') {
    return status.generation
  }
  const previous = status.generation - 1
  return previous >= 1 ? previous : null
}

export function watchTrainingStatus(options: {
  cwd: string
  runId: string
  intervalMs: number
  notify: boolean
  log: (line: string) => void
}): void {
  let lastNotified: number | null | undefined
  const tick = (first: boolean) => {
    try {
      const status = readTrainingStatus(options.cwd, options.runId)
      if (!status.exists) {
        options.log(`[ga] status missing ${status.path}`)
        return
      }
      const completed = latestCompletedGeneration(status)
      options.log(
        `[ga] status gen=${status.generation}/${status.campaignTarget} phase=${status.phase} matches=${status.completedMatches} done=${completed ?? '-'}`,
      )
      if (
        options.notify &&
        !first &&
        completed !== null &&
        completed !== lastNotified
      ) {
        const kind =
          status.phase === 'done' && completed === status.generation
            ? 'finished'
            : 'generation-done'
        notifyTrainingProgress({
          ...status,
          generation: completed,
          kind,
        })
      }
      lastNotified = completed
    } catch (err) {
      options.log(
        `[ga] status read failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  tick(true)
  setInterval(() => tick(false), options.intervalMs)
}
