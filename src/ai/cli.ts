/**
 * AI育成・評価の入口。
 *
 * 使い方:
 *   tsx src/ai/cli.ts agents
 *   tsx src/ai/cli.ts bench
 *   tsx src/ai/cli.ts match <idA> <idB> [--games 200] [--seed 20260915] [--sprt]
 *   tsx src/ai/cli.ts roundrobin --ids a,b,c [--games 100]
 *   tsx src/ai/cli.ts pipeline [--iterations 5] [--games 600]
 *   tsx src/ai/cli.ts selfplay [--games 200] [--sims 96]
 *   tsx src/ai/cli.ts train --shards ai-data/selfplay/gen0001-w0.jsonl
 *   tsx src/ai/cli.ts ladder [--sims 160]
 *   tsx src/ai/cli.ts status
 *
 * エージェントIDは `<種類>@<探索量>` でも書ける:
 *   heur@256 / rollout@256 / gen3@160 / champion@160
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  formatSeries,
  playRoundRobin,
  playSeries,
  type AgentSpec,
} from './arena/arena.ts'
import { DEFAULT_SPRT } from './arena/stats.ts'
import { getAgentSpec, listAgentIds, BASELINE_IDS } from './agents/index.ts'
import {
  createFastMatch,
  runFastMatch,
  type FastMatchConfig,
} from './sim/fastMatch.ts'
import { maxFlipAgent, randomAgent } from './agents/baselines.ts'
import {
  engineAgentSpec,
  heuristicChampionSpec,
  nnEngineSpec,
  type EngineSpec,
} from './engine/engine.ts'
import {
  ensureDirs,
  generationTag,
  listGenerations,
  modelPath,
  readChampion,
  readHistory,
  saveNetwork,
  selfplayDir,
} from './nn/modelStore.ts'
import { PvNetwork } from './nn/network.ts'
import { DEFAULT_PIPELINE, runPipeline } from './pipeline/pipeline.ts'
import { runParallelSelfPlay, defaultWorkerCount } from './selfplay/parallel.ts'
import { selfPlayEngineSpec } from './selfplay/selfplay.ts'
import { train } from './train/trainer.ts'

import {
  assertAllFlagsUsed,
  flag,
  num,
  parseArgs,
  raw,
  str,
  type Args,
} from './args.ts'

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function outDir(): string {
  return join(process.cwd(), 'docs', 'ai-output')
}

/**
 * `heur@256` `gen3@160` `champion@160` を解釈する。
 * `@` が無いか名簿にある ID はそのまま名簿から引く。
 */
function resolveAgentSpec(raw: string, defaultSims: number): AgentSpec {
  const at = raw.indexOf('@')
  const name = at === -1 ? raw : raw.slice(0, at)
  const sims = at === -1 ? defaultSims : Number(raw.slice(at + 1))
  if (!Number.isFinite(sims) || sims <= 0) {
    throw new Error(`探索量が読めない: ${raw}`)
  }

  const engine = engineSpecFor(name, sims)
  if (engine) return engineAgentSpec(engine)
  return getAgentSpec(name)
}

function engineSpecFor(name: string, sims: number): EngineSpec | null {
  if (name === 'heur') return heuristicChampionSpec(sims)
  if (name === 'rollout') {
    return { id: `rollout_${sims}`, label: `プレイアウトMCTS ${sims}`, kind: 'rollout', mcts: { simulations: sims } }
  }
  if (name === 'champion') {
    const champion = readChampion()
    if (!champion) throw new Error('Champion がまだ無い（先に pipeline を回す）')
    if (champion.kind !== 'nn' || !champion.modelPath) {
      return heuristicChampionSpec(sims)
    }
    return nnEngineSpec({
      id: `champion_${sims}`,
      label: `Champion ${generationTag(champion.generation)} ${sims}`,
      modelPath: champion.modelPath,
      simulations: sims,
    })
  }
  const gen = /^gen0*(\d+)$/.exec(name)
  if (gen) {
    const generation = Number(gen[1])
    const path = modelPath(generation)
    if (!existsSync(path)) throw new Error(`モデルが無い: ${path}`)
    return nnEngineSpec({
      id: `${generationTag(generation)}_${sims}`,
      label: `${generationTag(generation)} ${sims}`,
      modelPath: path,
      simulations: sims,
    })
  }
  return null
}

// --- コマンド -------------------------------------------------------------

function cmdAgents(): void {
  console.log('登録されているAI:')
  for (const id of listAgentIds()) {
    const spec = getAgentSpec(id)
    console.log(`  ${id.padEnd(22)} ${spec.label}`)
  }
}

function cmdBench(args: Args): void {
  const games = num(args, 'games', 5000)
  assertAllFlagsUsed(args)
  const reuse = createFastMatch({ seed: 1 })

  const run = (
    label: string,
    black: typeof randomAgent,
    white: typeof randomAgent,
    count: number,
  ): void => {
    runFastMatch({ seed: 1, decisionSeed: 1, black, white, match: reuse })
    const t0 = performance.now()
    let decisions = 0
    let moves = 0
    for (let i = 0; i < count; i += 1) {
      const r = runFastMatch({
        seed: 1000 + i,
        decisionSeed: 2000 + i,
        black,
        white,
        match: reuse,
      })
      decisions += r.decisions
      moves += r.moveCount
    }
    const ms = performance.now() - t0
    console.log(
      `${label.padEnd(26)} ${(count / (ms / 1000)).toFixed(0).padStart(7)} games/s` +
        `  ${(decisions / (ms / 1000) / 1000).toFixed(1).padStart(6)}k decisions/s` +
        `  平均 ${(moves / count).toFixed(1)} 手 / ${(decisions / count).toFixed(1)} 判断点`,
    )
  }

  console.log(`高速シミュレータ速度（1コア、${games} 試合ずつ）`)
  run('random vs random', randomAgent, randomAgent, games)
  run('max_flip vs max_flip', maxFlipAgent, maxFlipAgent, games)
  run('max_flip vs random', maxFlipAgent, randomAgent, games)
}

function configFromArgs(args: Args): Partial<FastMatchConfig> | undefined {
  const think = raw(args, 'think-delay')
  if (think === undefined || think === true) return undefined
  const value = Number(think)
  return { thinkDelayMs: [value, value] }
}

function cmdMatch(args: Args): void {
  const [idA, idB] = args.positional
  if (!idA || !idB) {
    throw new Error('使い方: match <idA> <idB> [--games N] [--seed S] [--sprt]')
  }
  const sims = num(args, 'sims', 256)
  const a = resolveAgentSpec(idA, sims)
  const b = resolveAgentSpec(idB, sims)
  const games = num(args, 'games', 200)
  const seed = num(args, 'seed', 20260915)
  const useSprt = flag(args, 'sprt')
  assertAllFlagsUsed(args)

  console.log(`${a.label} vs ${b.label}（最大 ${games} 局、シード ${seed}）`)
  let lastReport = 0
  const result = playSeries({
    a,
    b,
    games,
    masterSeed: seed,
    config: configFromArgs(args),
    sprt: useSprt ? DEFAULT_SPRT : null,
    onProgress(done, total) {
      const now = performance.now()
      if (now - lastReport < 3000) return
      lastReport = now
      process.stdout.write(`\r  ${done}/${total} 局...`)
    },
  })
  process.stdout.write('\r'.padEnd(40) + '\r')
  console.log(formatSeries(result))
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  writeJson(join(outDir(), `match-${safe(idA)}-vs-${safe(idB)}.json`), result)
}

function cmdRoundRobin(args: Args): void {
  const idsRaw = str(args, 'ids', BASELINE_IDS.join(','))
  const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  const games = num(args, 'games', 100)
  const seed = num(args, 'seed', 20260915)
  const sims = num(args, 'sims', 256)
  const players: AgentSpec[] = ids.map((id) => resolveAgentSpec(id, sims))
  assertAllFlagsUsed(args)

  console.log(`総当たり ${players.length} 体 × 各カード ${games} 局（シード ${seed}）`)
  let lastReport = 0
  const report = playRoundRobin({
    players,
    gamesPerPair: games,
    masterSeed: seed,
    config: configFromArgs(args),
    anchorId: ids.includes('random') ? 'random' : undefined,
    onProgress(done, total, aId, bId) {
      const now = performance.now()
      if (now - lastReport < 3000 && done < total) return
      lastReport = now
      process.stdout.write(`\r  ${aId} vs ${bId}  ${done}/${total} 局...`)
    },
    onSeries(result, index, total) {
      process.stdout.write('\r'.padEnd(50) + '\r')
      console.log(`  [${index}/${total}] ${formatSeries(result)}`)
    },
  })

  console.log('')
  console.log('順位（Bradley–Terry で当てはめた Elo / random を 0 とする）')
  console.log('  ' + 'ID'.padEnd(22) + 'Elo'.padStart(8) + '得点率'.padStart(10) + '試合'.padStart(8))
  for (const row of report.elo) {
    console.log(
      '  ' +
        row.id.padEnd(22) +
        row.elo.toFixed(0).padStart(8) +
        `${(row.scoreRate * 100).toFixed(1)}%`.padStart(10) +
        String(row.games).padStart(8),
    )
  }
  console.log('')
  console.log(`合計 ${report.totalGames} 局 / ${(report.wallMs / 1000).toFixed(1)} 秒`)
  writeJson(join(outDir(), 'roundrobin-latest.json'), report)
}

// --- 学習パイプライン -----------------------------------------------------

async function cmdPipeline(args: Args): Promise<void> {
  const iterations = num(args, 'iterations', 5)
  const options = {
    ...DEFAULT_PIPELINE,
    iterations,
    games: num(args, 'games', DEFAULT_PIPELINE.games),
    selfPlaySims: num(args, 'selfplay-sims', DEFAULT_PIPELINE.selfPlaySims),
    evalSims: num(args, 'eval-sims', DEFAULT_PIPELINE.evalSims),
    evalGames: num(args, 'eval-games', DEFAULT_PIPELINE.evalGames),
    workers: num(args, 'workers', defaultWorkerCount()),
    masterSeed: num(args, 'seed', DEFAULT_PIPELINE.masterSeed),
    epochs: num(args, 'epochs', DEFAULT_PIPELINE.epochs),
    lr: num(args, 'lr', DEFAULT_PIPELINE.lr),
    mixRate: num(args, 'mix-rate', DEFAULT_PIPELINE.mixRate),
    windowGenerations: num(args, 'window', DEFAULT_PIPELINE.windowGenerations),
    referenceGames: num(args, 'reference-games', DEFAULT_PIPELINE.referenceGames),
    pruneShards: flag(args, 'prune'),
  }
  assertAllFlagsUsed(args)
  console.log(
    `自己対戦${options.games}局 × ${iterations}世代 / 探索 自己対戦${options.selfPlaySims}・評価${options.evalSims} / ` +
      `ワーカー ${options.workers}`,
  )
  const results = await runPipeline(options)
  console.log('')
  console.log('世代の記録')
  for (const r of results) {
    console.log(
      `  ${generationTag(r.generation)} ${r.accepted ? '採用' : '不採用'} ` +
        `対Champion ${(r.series.aScoreRate * 100).toFixed(1)}% ` +
        `Elo ${r.series.eloDiff >= 0 ? '+' : ''}${r.series.eloDiff.toFixed(0)} ` +
        `方策損失 ${r.policyLoss.toFixed(4)} 価値損失 ${r.valueLoss.toFixed(4)}`,
    )
  }
  writeJson(join(outDir(), 'pipeline-latest.json'), readHistory())
}

async function cmdSelfPlay(args: Args): Promise<void> {
  ensureDirs()
  const games = num(args, 'games', 200)
  const sims = num(args, 'sims', 96)
  const tag = str(args, 'tag', 'manual')
  const championId = str(args, 'champion', 'champion')
  const base = engineSpecFor(championId, sims) ?? heuristicChampionSpec(sims)
  const seed = num(args, 'seed', 20260915)
  const workers = num(args, 'workers', defaultWorkerCount())
  const temperatureMoves = num(args, 'temperature-moves', 24)
  assertAllFlagsUsed(args)
  let lastReport = 0
  const result = await runParallelSelfPlay({
    champion: selfPlayEngineSpec(base, sims),
    games,
    masterSeed: seed,
    outPrefix: join(selfplayDir(), tag),
    workers,
    temperatureMoves,
    varyThinkDelay: true,
    onProgress(done, total) {
      const now = performance.now()
      if (now - lastReport < 3000) return
      lastReport = now
      process.stdout.write(`\r  ${done}/${total} 局...`)
    },
  })
  process.stdout.write('\r'.padEnd(40) + '\r')
  console.log(
    `${result.stats.games} 局 / ${result.stats.samples} サンプル / ` +
      `黒${result.stats.blackWins}-白${result.stats.whiteWins}-引${result.stats.draws} / ` +
      `${(result.stats.wallMs / 1000).toFixed(1)}s`,
  )
  console.log(`シャード: ${result.shards.length} 本`)
}

function cmdTrain(args: Args): void {
  ensureDirs()
  const shards = str(args, 'shards', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (shards.length === 0) throw new Error('--shards にJSONLを指定する')
  const seed = num(args, 'seed', 1)
  const epochs = num(args, 'epochs', 2)
  const batchSize = num(args, 'batch', 128)
  const lr = num(args, 'lr', 0.002)
  const valueWeight = num(args, 'value-weight', 1)
  const weightDecay = num(args, 'weight-decay', 1e-5)
  const out = str(args, 'out', join('ai-data', 'models', 'manual.json'))
  assertAllFlagsUsed(args)

  const net = PvNetwork.createInitial(seed)
  const result = train(net, {
    shards,
    epochs,
    batchSize,
    lr,
    valueWeight,
    weightDecay,
    chunkGames: 300,
    bufferSamples: 40_000,
    seed,
    onProgress(info) {
      console.log(
        `  epoch ${info.epoch}: ${info.samples} サンプル ` +
          `方策損失 ${info.policyLoss.toFixed(4)} 価値損失 ${info.valueLoss.toFixed(4)} ` +
          `top1 ${(info.policyTop1 * 100).toFixed(1)}%`,
      )
    },
  })
  saveNetwork(out, net)
  console.log(
    `${result.samples} サンプル / ${result.steps} 更新 / ${(result.wallMs / 1000).toFixed(1)}s → ${out}`,
  )
}

/** 世代総当たり。どの世代がどれだけ強くなったかを勝率で追う */
function cmdLadder(args: Args): void {
  const sims = num(args, 'sims', 160)
  const games = num(args, 'games', 60)
  const seed = num(args, 'seed', 20260915)
  const generations = listGenerations()
  const ids = [
    'random',
    'legacy_ga_best',
    'legacy_strategy',
    `heur@${sims}`,
    ...generations.map((g) => `gen${g}@${sims}`),
  ]
  const players = ids.map((id) => resolveAgentSpec(id, sims))
  assertAllFlagsUsed(args)
  console.log(`世代ラダー ${players.length} 体 × 各カード ${games} 局（探索 ${sims}）`)
  const report = playRoundRobin({
    players,
    gamesPerPair: games,
    masterSeed: seed,
    anchorId: 'random',
    onSeries(result, index, total) {
      console.log(`  [${index}/${total}] ${formatSeries(result)}`)
    },
  })
  console.log('')
  console.log('順位（Elo / random を 0 とする）')
  for (const row of report.elo) {
    console.log(
      '  ' +
        row.id.padEnd(24) +
        row.elo.toFixed(0).padStart(8) +
        `${(row.scoreRate * 100).toFixed(1)}%`.padStart(10),
    )
  }
  writeJson(join(outDir(), 'ladder-latest.json'), report)
}

function cmdStatus(): void {
  const champion = readChampion()
  console.log(
    champion
      ? `Champion: ${champion.kind === 'nn' ? generationTag(champion.generation) : '静的評価MCTS'}` +
          ` / 探索 ${champion.simulations} / ${champion.note}`
      : 'Champion: 未設定',
  )
  console.log(`保存済みモデル: ${listGenerations().map(generationTag).join(', ') || 'なし'}`)
  const history = readHistory()
  if (history.length === 0) return
  console.log('')
  console.log('世代'.padEnd(10) + '採否'.padEnd(8) + '得点率'.padStart(8) + 'Elo'.padStart(8) + '局数'.padStart(8) + ' 方策損失  価値損失')
  for (const h of history) {
    console.log(
      generationTag(h.generation).padEnd(10) +
        (h.accepted ? '採用' : '不採用').padEnd(8) +
        `${(h.challengerScoreRate * 100).toFixed(1)}%`.padStart(8) +
        `${h.challengerElo >= 0 ? '+' : ''}${h.challengerElo.toFixed(0)}`.padStart(8) +
        String(h.evalGames).padStart(8) +
        `  ${h.policyLoss.toFixed(4)}   ${h.valueLoss.toFixed(4)}`,
    )
  }
}

// --- 実行 -----------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'help'
  const args = parseArgs(argv.slice(1))

  switch (command) {
    case 'agents':
      cmdAgents()
      break
    case 'bench':
      cmdBench(args)
      break
    case 'match':
      cmdMatch(args)
      break
    case 'roundrobin':
      cmdRoundRobin(args)
      break
    case 'pipeline':
      await cmdPipeline(args)
      break
    case 'selfplay':
      await cmdSelfPlay(args)
      break
    case 'train':
      cmdTrain(args)
      break
    case 'ladder':
      cmdLadder(args)
      break
    case 'status':
      cmdStatus()
      break
    default:
      console.log(
        [
          '使い方:',
          '  tsx src/ai/cli.ts agents',
          '  tsx src/ai/cli.ts bench [--games 5000]',
          '  tsx src/ai/cli.ts match <idA> <idB> [--games 200] [--sims 256] [--sprt]',
          '  tsx src/ai/cli.ts roundrobin [--ids a,b,c] [--games 100] [--sims 256]',
          '  tsx src/ai/cli.ts pipeline [--iterations 5] [--games 600] [--workers N]',
          '  tsx src/ai/cli.ts selfplay [--games 200] [--sims 96] [--tag manual]',
          '  tsx src/ai/cli.ts train --shards a.jsonl,b.jsonl [--epochs 2] [--out path]',
          '  tsx src/ai/cli.ts ladder [--sims 160] [--games 60]',
          '  tsx src/ai/cli.ts status',
          '',
          'エージェントID: heur@256 / rollout@256 / gen3@160 / champion@160 / 名簿のID',
        ].join('\n'),
      )
  }
}

await main()
