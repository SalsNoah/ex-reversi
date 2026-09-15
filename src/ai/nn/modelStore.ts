/**
 * モデルと Champion の置き場。
 *
 * ai-data/
 *   champion.json          いま最強とみなしているエンジン（自己対戦の親）
 *   history.json           世代ごとの採否と勝率の記録
 *   models/gen0003.json    世代ごとの重み
 *   selfplay/gen0003-*.jsonl  自己対戦の棋譜
 *
 * ai-data/ は git 管理外。採用したモデルは別途 src へ焼き込む。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { PvNetwork, type SerializedNetwork } from './network.ts'

export function dataDir(): string {
  return join(process.cwd(), 'ai-data')
}

export function modelsDir(): string {
  return join(dataDir(), 'models')
}

export function selfplayDir(): string {
  return join(dataDir(), 'selfplay')
}

export function ensureDirs(): void {
  mkdirSync(modelsDir(), { recursive: true })
  mkdirSync(selfplayDir(), { recursive: true })
}

export function generationTag(generation: number): string {
  return `gen${String(generation).padStart(4, '0')}`
}

export function modelPath(generation: number): string {
  return join(modelsDir(), `${generationTag(generation)}.json`)
}

export function saveNetwork(path: string, net: PvNetwork): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(net.toJson()), 'utf8')
}

const loadCache = new Map<string, PvNetwork>()

/**
 * 同じパスは読み直さない（対戦ごとにエージェントを作り直すため）。
 *
 * 重みは読むだけなので使い回すが、前向き計算の作業領域は必ず別にする。
 * 同じモデルを両側に置いたとき、片方の中間結果をもう片方が壊すのを防ぐ。
 */
export function loadNetwork(path: string): PvNetwork {
  let cached = loadCache.get(path)
  if (!cached) {
    const data = JSON.parse(readFileSync(path, 'utf8')) as SerializedNetwork
    cached = PvNetwork.fromJson(data)
    loadCache.set(path, cached)
  }
  return cached.shareWeights()
}

// --- Champion ------------------------------------------------------------

/** 自己対戦・比較の主役。学習前は静的評価 MCTS が Champion になる */
export type ChampionRecord = {
  v: 1
  /** heuristic のときモデル無し */
  kind: 'heuristic' | 'nn'
  generation: number
  modelPath: string | null
  simulations: number
  note: string
  updatedAt: string
}

export function championPath(): string {
  return join(dataDir(), 'champion.json')
}

export function readChampion(): ChampionRecord | null {
  const path = championPath()
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as ChampionRecord
}

export function writeChampion(record: ChampionRecord): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(championPath(), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

// --- 世代記録 ------------------------------------------------------------

export type GenerationLog = {
  generation: number
  createdAt: string
  /** 学習に使った局面数 */
  samples: number
  games: number
  policyLoss: number
  valueLoss: number
  /** 挑戦者 vs Champion */
  challengerScoreRate: number
  challengerElo: number
  evalGames: number
  pValue: number
  sprt: string
  accepted: boolean
  /** 固定基準（既存最強）との得点率。絶対的な進捗を見るため */
  referenceScoreRate?: number | null
  note: string
}

export function historyPath(): string {
  return join(dataDir(), 'history.json')
}

export function readHistory(): GenerationLog[] {
  const path = historyPath()
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf8')) as GenerationLog[]
}

export function appendHistory(entry: GenerationLog): void {
  const all = readHistory()
  all.push(entry)
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(historyPath(), `${JSON.stringify(all, null, 2)}\n`, 'utf8')
}

/** 保存済みの世代番号（昇順） */
export function listGenerations(): number[] {
  const dir = modelsDir()
  if (!existsSync(dir)) return []
  const out: number[] = []
  for (const name of readdirSync(dir)) {
    const m = /^gen(\d+)\.json$/.exec(name)
    if (m) out.push(Number(m[1]))
  }
  return out.sort((a, b) => a - b)
}
