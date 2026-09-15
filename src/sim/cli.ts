import { GAME_CONFIG } from '../game/config.ts'
import {
  defaultOutDir,
  formatBenchmarkMarkdown,
  runBenchmark,
  writeBenchmarkOutputs,
} from './benchmark.ts'
import { runCpuMatch } from './cpuMatch.ts'

function parseArgs(argv: string[]): {
  command: string
  matchesPerPair: number
  seedBase: number
} {
  const command = argv[0] ?? 'smoke'
  let matchesPerPair = command === 'benchmark' ? 25 : 2
  let seedBase = 1000
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--matches' && argv[i + 1]) {
      matchesPerPair = Number(argv[++i])
    } else if (arg === '--seed-base' && argv[i + 1]) {
      seedBase = Number(argv[++i])
    }
  }
  return { command, matchesPerPair, seedBase }
}

function main(): void {
  const { command, matchesPerPair, seedBase } = parseArgs(
    process.argv.slice(2),
  )

  if (command !== 'smoke' && command !== 'benchmark') {
    console.error(`未知のコマンド: ${command}`)
    console.error('使い方: cli.ts smoke|benchmark [--matches N] [--seed-base N]')
    process.exitCode = 1
    return
  }

  if (command === 'smoke') {
    console.log('=== sim:smoke（少数試合）===')
    const sample = runCpuMatch({
      seed: seedBase,
      cooldownMs: GAME_CONFIG.cooldownMs,
      blackThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
      whiteThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
      agents: { black: 'max_flip', white: 'random' },
      recordRequests: true,
    })
    console.log(
      JSON.stringify(
        {
          seed: sample.seed,
          outcome: sample.outcome,
          endReason: sample.endReason,
          truncated: sample.truncated,
          stones: sample.stoneCounts,
          successfulMoves: sample.successfulMoves,
          elapsedMs: sample.elapsedMs,
          steps: sample.stepCount,
          wallMs: Number(sample.wallMs.toFixed(2)),
          simultaneousConflicts: sample.simultaneousConflicts,
          otherIllegalRequests: sample.otherIllegalRequests,
          recordedRequests: sample.requestRecords?.length ?? 0,
        },
        null,
        2,
      ),
    )
  }

  const report = runBenchmark({
    matchesPerPair,
    seedBase,
    cooldownMs: GAME_CONFIG.cooldownMs,
    thinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
    recordReplayForSeeds: [seedBase, seedBase + 1],
  })

  const out = writeBenchmarkOutputs(report, defaultOutDir())
  console.log(`書き出し: ${out.jsonPath}`)
  console.log(`書き出し: ${out.mdPath}`)
  console.log(formatBenchmarkMarkdown(report))
}

main()
