/**
 * 自己対戦ワーカー。親から渡された設定ファイルを読んで 1 シャードぶん打つ。
 *
 * 別プロセスにしているのは、CPU バウンドなので GC とヒープを分けたいから。
 * 使い方: tsx src/ai/selfplay/worker.ts <設定JSONのパス>
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runSelfPlay, type OpponentEntry, type SelfPlayStats } from './selfplay.ts'
import type { EngineSpec } from '../engine/engine.ts'

export type WorkerConfig = {
  champion: EngineSpec
  opponents: OpponentEntry[]
  mixRate: number
  games: number
  masterSeed: number
  temperatureMoves: number
  temperature: number
  varyThinkDelay: boolean
  shardPath: string
  statsPath: string
  /** 進捗表示の間隔（局）。0 で出さない */
  reportEvery: number
}

const FLUSH_GAMES = 100

export function runWorker(config: WorkerConfig): SelfPlayStats {
  mkdirSync(dirname(config.shardPath), { recursive: true })
  writeFileSync(config.shardPath, '', 'utf8')

  let pending: string[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    appendFileSync(config.shardPath, `${pending.join('\n')}\n`, 'utf8')
    pending = []
  }

  const stats = runSelfPlay({
    champion: config.champion,
    opponents: config.opponents,
    mixRate: config.mixRate,
    games: config.games,
    masterSeed: config.masterSeed,
    temperatureMoves: config.temperatureMoves,
    temperature: config.temperature,
    varyThinkDelay: config.varyThinkDelay,
    onGame(record, index) {
      pending.push(JSON.stringify(record))
      if (pending.length >= FLUSH_GAMES) flush()
      if (config.reportEvery > 0 && (index + 1) % config.reportEvery === 0) {
        process.stdout.write(`PROGRESS ${index + 1}\n`)
      }
    },
  })
  flush()

  writeFileSync(config.statsPath, JSON.stringify(stats), 'utf8')
  return stats
}

function main(): void {
  const path = process.argv[2]
  if (!path) throw new Error('usage: worker.ts <config.json>')
  const config = JSON.parse(readFileSync(path, 'utf8')) as WorkerConfig
  const stats = runWorker(config)
  process.stdout.write(`DONE ${JSON.stringify(stats)}\n`)
}

// 親から直接 import された場合は実行しない
if (process.argv[1] && process.argv[1].endsWith('worker.ts')) main()
