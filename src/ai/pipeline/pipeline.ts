/**
 * 自己対戦 → 学習 → 評価 → Champion 選抜 の自動ループ。
 *
 *   Champion 同士（+ 多様性のための相手）で自己対戦
 *     → 棋譜を貯める
 *     → Policy / Value を再学習して挑戦者を作る
 *     → 挑戦者 vs Champion を SPRT で判定
 *     → 勝ったときだけ Champion を差し替える
 *
 * 弱くなった世代は捨てて Champion を維持する。人手の判断は入らない。
 *
 * 最初の Champion は「静的評価 MCTS」（Phase 4 で既存最強を 75% で上回った構成）。
 * ここから学習を始めるので、ランダム初期化より早く立ち上がる。
 */
import { existsSync, rmSync } from 'node:fs'
import {
  DEFAULT_SPRT,
  type SprtBounds,
} from '../arena/stats.ts'
import { formatSeries, playSeries, type SeriesResult } from '../arena/arena.ts'
import {
  engineAgentSpec,
  heuristicChampionSpec,
  nnEngineSpec,
  type EngineSpec,
} from '../engine/engine.ts'
import { PvNetwork } from '../nn/network.ts'
import {
  appendHistory,
  ensureDirs,
  generationTag,
  loadNetwork,
  modelPath,
  readChampion,
  readHistory,
  saveNetwork,
  selfplayDir,
  writeChampion,
  type ChampionRecord,
} from '../nn/modelStore.ts'
import { runParallelSelfPlay } from '../selfplay/parallel.ts'
import { selfPlayEngineSpec, type OpponentEntry } from '../selfplay/selfplay.ts'
import { train, type TrainOptions } from '../train/trainer.ts'
import { join } from 'node:path'

export type PipelineOptions = {
  iterations: number
  /** 1 世代ぶんの自己対戦数 */
  games: number
  /** 自己対戦の探索量（小さくして数を稼ぐ） */
  selfPlaySims: number
  /** 採否判定の探索量（挑戦者と Champion で同じ） */
  evalSims: number
  /** 採否判定の最大局数（SPRT で早く止まる） */
  evalGames: number
  /**
   * 固定基準との対戦局数（0 で無効）。
   * Champion 同士の比較だけでは絶対的な進捗が分からないので、
   * 毎世代、既存最強（時間対応αβ）と同じ条件で測る。
   */
  referenceGames: number
  referenceOpponentId: string
  workers?: number
  masterSeed: number
  /** 学習に使う直近の世代数 */
  windowGenerations: number
  /** Champion 以外と当てる割合 */
  mixRate: number
  epochs: number
  batchSize: number
  lr: number
  valueWeight: number
  weightDecay: number
  sprt?: SprtBounds
  /** 古いシャードを消す */
  pruneShards?: boolean
  log?: (line: string) => void
}

export const DEFAULT_PIPELINE: Omit<PipelineOptions, 'iterations'> = {
  games: 600,
  selfPlaySims: 96,
  evalSims: 160,
  evalGames: 200,
  referenceGames: 40,
  referenceOpponentId: 'legacy_strategy',
  masterSeed: 20260915,
  windowGenerations: 4,
  mixRate: 0.25,
  epochs: 2,
  batchSize: 128,
  lr: 0.002,
  valueWeight: 1,
  weightDecay: 1e-5,
}

export type IterationResult = {
  generation: number
  accepted: boolean
  series: SeriesResult
  samples: number
  policyLoss: number
  valueLoss: number
  selfPlayMs: number
  trainMs: number
}

function championSpec(record: ChampionRecord, simulations: number): EngineSpec {
  if (record.kind === 'nn' && record.modelPath) {
    return nnEngineSpec({
      id: `champion_${generationTag(record.generation)}`,
      label: `Champion ${generationTag(record.generation)}`,
      modelPath: record.modelPath,
      simulations,
    })
  }
  return heuristicChampionSpec(simulations)
}

/**
 * 多様性のための相手（§17 の過学習対策）。
 * 直近の挑戦者も入れる。Champion が静的評価のままでも、
 * 学習中のネット自身が指した局面がデータに入るようにするため。
 */
function buildOpponents(
  generation: number,
  simulations: number,
  log: (line: string) => void,
): OpponentEntry[] {
  const out: OpponentEntry[] = [
    { spec: { id: 'random', label: 'ランダム', kind: 'heuristic' }, weight: 0.5 },
    {
      spec: heuristicChampionSpec(Math.max(8, Math.floor(simulations / 4))),
      weight: 1,
    },
  ]
  // 直近の世代（採否を問わず最新 1 つ + 採用済みの 2 つ）
  const wanted = new Set<number>()
  if (generation > 1) wanted.add(generation - 1)
  for (const h of readHistory().filter((h) => h.accepted).slice(-2)) {
    wanted.add(h.generation)
  }
  for (const g of [...wanted].sort((a, b) => a - b)) {
    const path = modelPath(g)
    if (!existsSync(path)) continue
    out.push({
      spec: nnEngineSpec({
        id: `past_${generationTag(g)}`,
        label: `過去世代 ${generationTag(g)}`,
        modelPath: path,
        simulations,
      }),
      weight: 1.5,
    })
  }
  log(`  相手プール: ${out.map((o) => o.spec.id).join(', ')}`)
  return out
}

export async function runPipeline(
  options: PipelineOptions,
): Promise<IterationResult[]> {
  ensureDirs()
  const log = options.log ?? ((line: string) => console.log(line))
  const results: IterationResult[] = []

  let champion =
    readChampion() ??
    ({
      v: 1,
      kind: 'heuristic',
      generation: 0,
      modelPath: null,
      simulations: options.evalSims,
      note: '静的評価MCTS（学習前の出発点）',
      updatedAt: new Date().toISOString(),
    } satisfies ChampionRecord)
  if (!readChampion()) writeChampion(champion)

  const history = readHistory()
  let generation = history.length > 0 ? history[history.length - 1]!.generation : 0

  for (let iter = 0; iter < options.iterations; iter += 1) {
    generation += 1
    const tag = generationTag(generation)
    log('')
    log(`=== ${tag} =========================================`)
    log(
      `Champion: ${champion.kind === 'nn' ? generationTag(champion.generation) : '静的評価MCTS'}`,
    )

    // --- 1. 自己対戦 ---
    const spSpec = selfPlayEngineSpec(
      championSpec(champion, options.selfPlaySims),
      options.selfPlaySims,
    )
    const opponents = buildOpponents(generation, options.selfPlaySims, log)
    const outPrefix = join(selfplayDir(), tag)
    const spStart = performance.now()
    let lastReport = 0
    const sp = await runParallelSelfPlay({
      champion: spSpec,
      opponents,
      mixRate: options.mixRate,
      games: options.games,
      masterSeed: deriveIterSeed(options.masterSeed, generation, 1),
      outPrefix,
      workers: options.workers,
      temperatureMoves: 24,
      temperature: 1,
      varyThinkDelay: true,
      onProgress(done, total) {
        const now = performance.now()
        if (now - lastReport < 5000) return
        lastReport = now
        log(`  自己対戦 ${done}/${total}`)
      },
      onWorkerFailure(index, attempt, reason) {
        log(`  ! ワーカー${index} が落ちた（${attempt + 1}回目）: ${reason}`)
      },
    })
    const selfPlayMs = performance.now() - spStart
    log(
      `  自己対戦 ${sp.stats.games} 局 / ${sp.stats.samples} サンプル / ` +
        `${(selfPlayMs / 1000).toFixed(1)}s（${sp.workers} ワーカー、` +
        `${(sp.stats.games / (selfPlayMs / 1000)).toFixed(1)} 局/秒）`,
    )
    if (sp.failedWorkers.length > 0) {
      log(
        `  ! ワーカー ${sp.failedWorkers.join(', ')} を切り捨てて続行` +
          `（この世代は対局数が減っている）`,
      )
    }

    // --- 2. 学習 ---
    // 起点は「前世代の挑戦者」。Champion が静的評価のままでも学習は積み上がる
    const shards = collectShards(generation, options.windowGenerations)
    const previous = generation > 1 ? modelPath(generation - 1) : null
    const net =
      previous && existsSync(previous)
        ? loadNetwork(previous).clone()
        : champion.kind === 'nn' && champion.modelPath
          ? loadNetwork(champion.modelPath).clone()
          : PvNetwork.createInitial(deriveIterSeed(options.masterSeed, generation, 2))
    const trainOptions: TrainOptions = {
      shards,
      epochs: options.epochs,
      batchSize: options.batchSize,
      lr: options.lr,
      valueWeight: options.valueWeight,
      weightDecay: options.weightDecay,
      chunkGames: 300,
      bufferSamples: 40_000,
      seed: deriveIterSeed(options.masterSeed, generation, 3),
      onProgress(info) {
        log(
          `  学習 epoch ${info.epoch}: ${info.samples} サンプル ` +
            `方策損失 ${info.policyLoss.toFixed(4)} 価値損失 ${info.valueLoss.toFixed(4)} ` +
            `top1 ${(info.policyTop1 * 100).toFixed(1)}%`,
        )
      },
    }
    const trainResult = train(net, trainOptions)
    const path = modelPath(generation)
    saveNetwork(path, net)
    log(
      `  学習 ${trainResult.samples} サンプル / ${trainResult.steps} 更新 / ` +
        `${(trainResult.wallMs / 1000).toFixed(1)}s → ${tag}`,
    )

    // --- 3. 挑戦者 vs Champion ---
    const challenger = nnEngineSpec({
      id: `challenger_${tag}`,
      label: `挑戦者 ${tag}`,
      modelPath: path,
      simulations: options.evalSims,
    })
    const series = playSeries({
      a: engineAgentSpec(challenger),
      b: engineAgentSpec(championSpec(champion, options.evalSims)),
      games: options.evalGames,
      masterSeed: deriveIterSeed(options.masterSeed, generation, 4),
      sprt: options.sprt ?? DEFAULT_SPRT,
      sprtMinGames: 40,
    })
    log(`  ${formatSeries(series)}`)

    // --- 3b. 固定基準との対戦（絶対的な進捗の確認） ---
    let referenceRate: number | null = null
    if (options.referenceGames > 0) {
      // 既存CPU側のモジュールは循環参照を持つので、ここで遅延読み込みする
      const { getAgentSpec } = await import('../agents/index.ts')
      const reference = playSeries({
        a: engineAgentSpec(challenger),
        b: getAgentSpec(options.referenceOpponentId),
        games: options.referenceGames,
        masterSeed: deriveIterSeed(options.masterSeed, generation, 5),
      })
      referenceRate = reference.aScoreRate
      log(
        `  基準 vs ${options.referenceOpponentId}: ` +
          `得点率 ${(reference.aScoreRate * 100).toFixed(1)}% ` +
          `(${reference.aWins}勝 ${reference.bWins}敗 ${reference.draws}分) ` +
          `Elo ${reference.eloDiff >= 0 ? '+' : ''}${reference.eloDiff.toFixed(0)}`,
      )
    }

    // --- 4. 採否 ---
    const accepted =
      series.sprt?.verdict === 'accept' ||
      (series.significant && series.aScoreRate > 0.5)
    if (accepted) {
      champion = {
        v: 1,
        kind: 'nn',
        generation,
        modelPath: path,
        simulations: options.evalSims,
        note: `得点率 ${(series.aScoreRate * 100).toFixed(1)}% / Elo +${series.eloDiff.toFixed(0)}`,
        updatedAt: new Date().toISOString(),
      }
      writeChampion(champion)
      log(`  → 採用。Champion を ${tag} に更新`)
    } else {
      log('  → 不採用。Champion を維持')
    }

    appendHistory({
      generation,
      createdAt: new Date().toISOString(),
      samples: trainResult.samples,
      games: sp.stats.games,
      policyLoss: trainResult.policyLoss,
      valueLoss: trainResult.valueLoss,
      challengerScoreRate: series.aScoreRate,
      challengerElo: series.eloDiff,
      evalGames: series.games,
      pValue: series.pValue,
      sprt: series.sprt?.verdict ?? 'none',
      accepted,
      referenceScoreRate: referenceRate,
      note: accepted ? 'Champion 更新' : 'Champion 維持',
    })

    results.push({
      generation,
      accepted,
      series,
      samples: trainResult.samples,
      policyLoss: trainResult.policyLoss,
      valueLoss: trainResult.valueLoss,
      selfPlayMs,
      trainMs: trainResult.wallMs,
    })

    if (options.pruneShards) {
      pruneOldShards(generation, options.windowGenerations)
    }
  }

  return results
}

function collectShards(generation: number, window: number): string[] {
  const out: string[] = []
  const from = Math.max(1, generation - window + 1)
  for (let g = from; g <= generation; g += 1) {
    const prefix = join(selfplayDir(), generationTag(g))
    for (let k = 0; k < 64; k += 1) {
      const path = `${prefix}-w${k}.jsonl`
      if (!existsSync(path)) break
      out.push(path)
    }
  }
  return out
}

function pruneOldShards(generation: number, window: number): void {
  const drop = generation - window
  if (drop < 1) return
  const prefix = join(selfplayDir(), generationTag(drop))
  for (let k = 0; k < 64; k += 1) {
    const path = `${prefix}-w${k}.jsonl`
    if (!existsSync(path)) break
    rmSync(path)
  }
}

function deriveIterSeed(master: number, generation: number, part: number): number {
  let h = master >>> 0
  h = (Math.imul(h ^ generation, 2654435761) >>> 0) ^ 0x9e3779b9
  h = Math.imul(h ^ part, 2246822519) >>> 0
  return h >>> 0
}
