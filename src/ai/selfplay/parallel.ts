/**
 * 自己対戦の並列実行。
 *
 * 12 コアの環境なので、ワーカーを CPU 数ぶん立てて別プロセスで打たせる。
 * 各ワーカーは独立したシードで独立したシャードに書くので、
 * 将来クラウドで台数を増やしても同じ形（シャードを集めるだけ）で済む。
 */
import { spawn } from 'node:child_process'
import { availableParallelism, cpus } from 'node:os'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { deriveSeed } from '../../ga/rng.ts'
import type { EngineSpec } from '../engine/engine.ts'
import type { OpponentEntry, SelfPlayStats } from './selfplay.ts'
import type { WorkerConfig } from './worker.ts'

const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url))

export type ParallelSelfPlayOptions = {
  champion: EngineSpec
  opponents?: OpponentEntry[]
  mixRate?: number
  /** 合計の対局数 */
  games: number
  masterSeed: number
  /** 出力の接頭辞。`${prefix}-w0.jsonl` のように増える */
  outPrefix: string
  workers?: number
  temperatureMoves?: number
  temperature?: number
  varyThinkDelay?: boolean
  onProgress?: (done: number, total: number) => void
  /** 落ちたワーカーをやり直す回数。既定 1 */
  retries?: number
  /** テスト用にワーカーの実体を差し替える */
  workerPath?: string
  /** ワーカーが落ちたときの通知（何が起きたか記録に残すため） */
  onWorkerFailure?: (index: number, attempt: number, reason: string) => void
}

export type ParallelSelfPlayResult = {
  shards: string[]
  stats: SelfPlayStats
  workers: number
  /** 2 回やり直しても落ちたワーカーの番号。空でなければ対局数が足りていない */
  failedWorkers: number[]
}

export function defaultWorkerCount(): number {
  const n = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
  // 1 コアは親と OS に残す
  return Math.max(1, n - 1)
}

export async function runParallelSelfPlay(
  options: ParallelSelfPlayOptions,
): Promise<ParallelSelfPlayResult> {
  const workers = Math.max(1, options.workers ?? defaultWorkerCount())
  const perWorker = Math.ceil(options.games / workers)
  const tmpDir = join(process.cwd(), 'ai-data', 'tmp')
  mkdirSync(tmpDir, { recursive: true })

  const configs: WorkerConfig[] = []
  for (let k = 0; k < workers; k += 1) {
    const games = Math.min(perWorker, options.games - k * perWorker)
    if (games <= 0) break
    const shardPath = `${options.outPrefix}-w${k}.jsonl`
    configs.push({
      champion: options.champion,
      opponents: options.opponents ?? [],
      mixRate: options.mixRate ?? 0,
      games,
      masterSeed: deriveSeed(options.masterSeed, k, 0x5eed),
      temperatureMoves: options.temperatureMoves ?? 20,
      temperature: options.temperature ?? 1,
      varyThinkDelay: options.varyThinkDelay ?? false,
      shardPath,
      statsPath: `${shardPath}.stats.json`,
      reportEvery: Math.max(1, Math.floor(games / 20)),
    })
  }

  let done = 0
  const total = configs.reduce((n, c) => n + c.games, 0)
  const progress = new Int32Array(configs.length)
  const workerPath = options.workerPath ?? WORKER_PATH
  const retries = options.retries ?? 1

  /** ワーカーを 1 回走らせる。落ちた理由を文字で返す（成功なら null） */
  function runOnce(config: WorkerConfig, index: number): Promise<string | null> {
    return new Promise((resolve) => {
      const configPath = join(tmpDir, `selfplay-w${index}.json`)
      writeFileSync(configPath, JSON.stringify(config), 'utf8')
      const child = spawn(process.execPath, [...process.execArgv, workerPath, configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // やり直しのとき進捗が二重に増えないよう、前回ぶんを戻す
      done -= progress[index]!
      progress[index] = 0
      let buffer = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line.startsWith('PROGRESS ')) {
            const value = Number(line.slice(9))
            done += value - progress[index]!
            progress[index] = value
            options.onProgress?.(done, total)
          }
          nl = buffer.indexOf('\n')
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => resolve(`spawn failed: ${err.message}`))
      child.on('exit', (code) => {
        if (code === 0) {
          if (existsSync(configPath)) unlinkSync(configPath)
          resolve(null)
          return
        }
        const tail = stderr.trim().split('\n').slice(-6).join(' / ')
        resolve(`exit ${code}${tail ? `: ${tail}` : '（出力なし。メモリ不足の可能性）'}`)
      })
    })
  }

  const failedWorkers: number[] = []
  await Promise.all(
    configs.map(async (config, index) => {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const reason = await runOnce(config, index)
        if (reason === null) return
        options.onWorkerFailure?.(index, attempt, reason)
      }
      // ここまで来たらこのシャードは捨てる。
      // 1 ワーカーのために世代ぶんの対局を失う方が損が大きい
      failedWorkers.push(index)
      done -= progress[index]!
      progress[index] = 0
    }),
  )
  if (failedWorkers.length === configs.length) {
    throw new Error('自己対戦のワーカーが全部落ちた（設定かメモリを確認すること）')
  }

  const stats: SelfPlayStats = {
    games: 0,
    samples: 0,
    moves: 0,
    blackWins: 0,
    whiteWins: 0,
    draws: 0,
    wallMs: 0,
  }
  const okShards: string[] = []
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index]!
    if (failedWorkers.includes(index) || !existsSync(config.statsPath)) continue
    const part = JSON.parse(readFileSync(config.statsPath, 'utf8')) as SelfPlayStats
    stats.games += part.games
    stats.samples += part.samples
    stats.moves += part.moves
    stats.blackWins += part.blackWins
    stats.whiteWins += part.whiteWins
    stats.draws += part.draws
    stats.wallMs = Math.max(stats.wallMs, part.wallMs)
    unlinkSync(config.statsPath)
    okShards.push(config.shardPath)
  }

  return {
    shards: okShards,
    stats,
    workers: configs.length - failedWorkers.length,
    failedWorkers: failedWorkers.sort((a, b) => a - b),
  }
}
