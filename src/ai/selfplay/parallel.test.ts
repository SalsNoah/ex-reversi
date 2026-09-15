import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runParallelSelfPlay } from './parallel.ts'

/**
 * 本物のワーカーは自己対戦に数分かかるので、ここでは差し替え用の偽ワーカーを使う。
 * 確かめたいのは「1 つ落ちたときに世代ぶんの対局を捨てないか」だけ。
 */
let dir: string

/**
 * 偽ワーカー。設定を読んで stats を書き、`FAIL_ONCE` / `FAIL_ALWAYS` の指定で落ちる。
 * 落ちた回数は横のファイルに残して、やり直しを数えられるようにする。
 */
const FAKE_WORKER = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const mode = process.env.FAKE_MODE ?? 'ok'
const marker = \`\${config.shardPath}.attempts\`
const attempts = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0
writeFileSync(marker, String(attempts + 1), 'utf8')
const isTarget = config.shardPath.endsWith('-w1.jsonl')
if (isTarget && (mode === 'fail_always' || (mode === 'fail_once' && attempts === 0))) {
  console.error('わざと落とす')
  process.exit(1)
}
console.log('PROGRESS ' + config.games)
writeFileSync(config.shardPath, '', 'utf8')
writeFileSync(
  config.statsPath,
  JSON.stringify({
    games: config.games,
    samples: config.games * 10,
    moves: config.games * 5,
    blackWins: config.games,
    whiteWins: 0,
    draws: 0,
    wallMs: 1,
  }),
  'utf8',
)
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parallel-test-'))
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(join(dir, 'fake-worker.ts'), FAKE_WORKER, 'utf8')
})

afterEach(() => {
  delete process.env.FAKE_MODE
  rmSync(dir, { recursive: true, force: true })
})

function run(games: number, workers: number) {
  return runParallelSelfPlay({
    champion: { id: 'x', label: 'x', kind: 'heuristic' },
    games,
    masterSeed: 1,
    outPrefix: join(dir, 'out', 'gen'),
    workers,
    workerPath: join(dir, 'fake-worker.ts'),
  })
}

describe('自己対戦の並列実行', () => {
  it('全部成功すれば全シャードを返す', async () => {
    const r = await run(30, 3)
    expect(r.failedWorkers).toEqual([])
    expect(r.shards).toHaveLength(3)
    expect(r.stats.games).toBe(30)
    expect(r.workers).toBe(3)
  })

  it('落ちたワーカーをやり直して回復する', async () => {
    process.env.FAKE_MODE = 'fail_once'
    const r = await run(30, 3)
    expect(r.failedWorkers).toEqual([])
    expect(r.stats.games).toBe(30)
    // 進捗が二重計上されていない（やり直し前のぶんを戻している）
    expect(r.shards).toHaveLength(3)
  })

  it('やり直しても落ちるワーカーは切り捨てて、残りで続ける', async () => {
    process.env.FAKE_MODE = 'fail_always'
    const failures: string[] = []
    const r = await runParallelSelfPlay({
      champion: { id: 'x', label: 'x', kind: 'heuristic' },
      games: 30,
      masterSeed: 1,
      outPrefix: join(dir, 'out', 'gen'),
      workers: 3,
      workerPath: join(dir, 'fake-worker.ts'),
      onWorkerFailure: (index, attempt, reason) =>
        failures.push(`${index}/${attempt}/${reason}`),
    })
    // ここが本題。1 ワーカーの死亡で世代ぶんの対局を捨てない
    expect(r.failedWorkers).toEqual([1])
    expect(r.shards).toHaveLength(2)
    expect(r.stats.games).toBe(20)
    expect(r.workers).toBe(2)
    // 落ちた理由が記録に残る（原因調査のため）
    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('わざと落とす')
  })

  it('進捗の合計が対局数を超えない', async () => {
    process.env.FAKE_MODE = 'fail_once'
    const seen: number[] = []
    await runParallelSelfPlay({
      champion: { id: 'x', label: 'x', kind: 'heuristic' },
      games: 30,
      masterSeed: 1,
      outPrefix: join(dir, 'out', 'gen'),
      workers: 3,
      workerPath: join(dir, 'fake-worker.ts'),
      onProgress: (done) => seen.push(done),
    })
    expect(Math.max(...seen)).toBeLessThanOrEqual(30)
  })
})
