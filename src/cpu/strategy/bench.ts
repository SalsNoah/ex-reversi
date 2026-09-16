/**
 * 戦略AIの検証用 CLI（画面なし）。
 *
 *   tsx src/cpu/strategy/bench.ts verify      … ルール層との一致確認
 *   tsx src/cpu/strategy/bench.ts speed       … 1手あたりの探索ノード数と時間
 *   tsx src/cpu/strategy/bench.ts match       … GA代表との対戦
 *   tsx src/cpu/strategy/bench.ts human       … 最速で打つ人間役との対戦
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  collectFlips,
  createInitialBoard,
  createMatch,
  createRng,
  listLegalMoves,
  placeStone,
  toPublicMatchState,
} from '../../game/index.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import type { Board, Stone } from '../../game/types.ts'
import { GA_MILESTONES } from '../gaMilestones.ts'
import { getCpuAgent } from '../index.ts'
import { matchSeeds, runGaMatch, type OpponentSpec } from '../../ga/matchRunner.ts'
import type { PaceEstimate } from './pace.ts'
import {
  BLACK,
  DIRS,
  EMPTY_HEAD,
  WHITE,
  colOf,
  colorOf,
  createFastPosition,
  doMove,
  generateMoves,
  loadBoard,
  rowOf,
  undoMove,
  type FastPosition,
} from './fastBoard.ts'
import {
  MASTER_LEVEL,
  createStrategyCpu,
  decideStrategyMove,
  type StrategyLevel,
} from './strategyCpu.ts'
import { ALPHA_LEVEL, ALPHA_WEIGHT_SPEC, createAlphaCpu } from './alphaCpu.ts'
import { BETA_LEVEL, BETA_WEIGHT_SPEC, createBetaCpu } from './betaCpu.ts'
import {
  GAMMA_LEVEL,
  GAMMA_WEIGHT_SPEC,
  createGammaCpu,
} from './gammaCpu.ts'
import {
  DELTA_LEVEL,
  DELTA_WEIGHT_SPEC,
  createDeltaCpu,
} from './deltaCpu.ts'
import {
  EPSILON_LEVEL,
  EPSILON_WEIGHT_SPEC,
  createEpsilonCpu,
} from './epsilonCpu.ts'
import { runPacedMatch } from './pacedMatch.ts'
import {
  DEFAULT_WEIGHTS,
  DEFAULT_WEIGHT_SPEC,
  buildWeightTables,
  evaluate,
  scanLeaf,
  type PhaseWeights,
  type WeightSpec,
  type WeightTables,
} from './evaluate.ts'
import { countStable } from './stability.ts'
import type { CpuAgent } from '../types.ts'

function randomPlayout(seed: number, plies: number): Board {
  const rng = createRng(seed)
  let board = createInitialBoard()
  for (let k = 0; k < plies; k += 1) {
    const stone: Stone = k % 2 === 0 ? 'black' : 'white'
    const legal = listLegalMoves(board, stone)
    if (legal.length === 0) continue
    const pick = legal[rng.nextInt(0, legal.length)]
    const placed = placeStone(board, pick.row, pick.col, stone)
    if (!placed.ok) throw new Error('unexpected illegal move')
    board = placed.board
  }
  return board
}

function verify(): void {
  const pos = createFastPosition()
  const buffer = new Int32Array(128)
  let checked = 0

  for (let seed = 1; seed <= 300; seed += 1) {
    for (let plies = 0; plies <= 60; plies += 6) {
      const board = randomPlayout(seed, plies)
      loadBoard(pos, board)

      for (const stone of ['black', 'white'] as const) {
        const color = colorOf(stone)
        const expected = listLegalMoves(board, stone)
          .map((m) => `${m.row},${m.col}`)
          .sort()
        const n = generateMoves(pos, color, buffer, 0)
        const actual: string[] = []
        for (let k = 0; k < n; k += 1) {
          actual.push(`${rowOf(buffer[k])},${colOf(buffer[k])}`)
        }
        actual.sort()
        if (expected.join('|') !== actual.join('|')) {
          throw new Error(
            `movegen mismatch seed=${seed} plies=${plies} ${stone}\n` +
              `expected ${expected.join(' ')}\nactual   ${actual.join(' ')}`,
          )
        }

        for (let k = 0; k < n; k += 1) {
          const index = buffer[k]
          const row = rowOf(index)
          const col = colOf(index)
          const flips = collectFlips(board, row, col, stone).length
          const applied = doMove(pos, index, color)
          if (applied !== flips) {
            throw new Error(
              `flip count mismatch seed=${seed} ${stone} ${row},${col}: ` +
                `${applied} !== ${flips}`,
            )
          }
          const placed = placeStone(board, row, col, stone)
          if (!placed.ok) throw new Error('unexpected illegal move')
          let mismatch = ''
          for (let r = 0; r < GAME_CONFIG.boardSize; r += 1) {
            for (let c = 0; c < GAME_CONFIG.boardSize; c += 1) {
              const want = placed.board[r][c]
              const got = pos.cells[(r + 1) * 12 + (c + 1)]
              const wantCode = want === 'black' ? BLACK : want === 'white' ? WHITE : 0
              if (got !== wantCode) mismatch = `${r},${c}`
            }
          }
          if (mismatch) {
            throw new Error(`board mismatch at ${mismatch}`)
          }
          undoMove(pos, index, color, applied)
          checked += 1
        }

        // undo 後に元の盤へ戻っているか
        let empties = 0
        for (let i = pos.emptyNext[EMPTY_HEAD]; i !== EMPTY_HEAD; i = pos.emptyNext[i]) {
          empties += 1
        }
        if (empties !== pos.emptyCount) {
          throw new Error(`empty list broken: ${empties} !== ${pos.emptyCount}`)
        }
      }
    }
  }
  console.log(`verify ok: ${checked} moves matched the rule layer`)
}

function speed(args: string[]): void {
  const argv = [...args]
  // 全滅の項の重み。0 で切って所要を比べられるようにしてある
  const wipeout = takeArg(argv, '--wipeout')
  const wipeout2 = takeArg(argv, '--wipeout2')
  const budget = Number(argv[0] ?? MASTER_LEVEL.nodeBudget)
  const level = {
    ...MASTER_LEVEL,
    nodeBudget: budget,
    weights:
      wipeout === undefined && wipeout2 === undefined
        ? MASTER_LEVEL.weights
        : buildWeightTables({
            ...DEFAULT_WEIGHT_SPEC,
            ...(wipeout === undefined ? {} : { wipeout: Number(wipeout) }),
            ...(wipeout2 === undefined ? {} : { wipeout2: Number(wipeout2) }),
          }),
  }
  const samples: Array<{
    ms: number
    nodes: number
    depth: number
    empties: number
  }> = []

  for (let seed = 1; seed <= 20; seed += 1) {
    for (const plies of [0, 10, 20, 30, 40, 50, 60, 70, 76, 80]) {
      const board = randomPlayout(seed * 977, plies)
      if (listLegalMoves(board, 'white').length < 2) continue
      const match = { ...createMatch({ seed }), board }
      const publicState = toPublicMatchState(match)
      let best = Infinity
      let nodes = 0
      let depth = 0
      let ok = false
      // 背景負荷を避けるため同じ局面を 3 回読んで最小値を採る
      for (let round = 0; round < 3; round += 1) {
        const rng = createRng(12345)
        const start = performance.now()
        const info = decideStrategyMove(publicState, rng, 'white', level)
        const ms = performance.now() - start
        if (info.decision.type !== 'move') break
        ok = true
        if (ms < best) {
          best = ms
          nodes = info.nodes
          depth = info.depth
        }
      }
      if (!ok) continue
      let empties = 0
      for (const row of board) {
        for (const cell of row) if (cell === null) empties += 1
      }
      samples.push({ ms: best, nodes, depth, empties })
    }
  }

  samples.sort((a, b) => a.ms - b.ms)
  const total = samples.reduce((n, s) => n + s.ms, 0)
  const nodes = samples.reduce((n, s) => n + s.nodes, 0)
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  const worst = samples[samples.length - 1]

  console.log(`samples      : ${samples.length}`)
  console.log(`node budget  : ${budget}`)
  console.log(`mean ms      : ${(total / samples.length).toFixed(1)}`)
  console.log(`p50 ms       : ${p50.ms.toFixed(1)} (depth ${p50.depth})`)
  console.log(`p95 ms       : ${p95.ms.toFixed(1)} (depth ${p95.depth})`)
  console.log(
    `max ms       : ${worst.ms.toFixed(1)} ` +
      `(depth ${worst.depth}, 空き ${worst.empties})`,
  )
  console.log(
    `nodes/sec    : ${Math.round(nodes / (total / 1000)).toLocaleString()}`,
  )

  const buckets = [
    { label: '空き 60+', min: 60 },
    { label: '空き 40-59', min: 40 },
    { label: '空き 20-39', min: 20 },
    { label: '空き 0-19', min: 0 },
  ]
  for (const bucket of buckets) {
    const max = bucket.min === 60 ? 999 : bucket.min + 19
    const group = samples.filter(
      (s) => s.empties >= bucket.min && s.empties <= max,
    )
    if (group.length === 0) continue
    const meanMs = group.reduce((n, s) => n + s.ms, 0) / group.length
    const meanDepth = group.reduce((n, s) => n + s.depth, 0) / group.length
    console.log(
      `${bucket.label.padEnd(11)} n=${String(group.length).padStart(3)} ` +
        `平均 ${meanMs.toFixed(1)}ms 平均深さ ${meanDepth.toFixed(1)}`,
    )
  }
}

/**
 * 対戦に出す自分側。既定は画面に登録した最新の名前付き個体「ベータ」。
 * つまみを渡したときだけ、その設定の使い捨てエージェントを作る。
 */
function strategySpec(
  level?: Partial<StrategyLevel>,
): OpponentSpec & { labelId: string } {
  if (!level) return { kind: 'builtin', id: 'beta', labelId: 'beta' }
  return {
    kind: 'agent',
    id: 'beta',
    labelId: 'beta',
    agent: createStrategyCpu({
      id: 'beta',
      label: 'beta',
      level: { ...BETA_LEVEL, ...level },
    }),
  }
}

function takeArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0 || !args[i + 1]) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}

type MatchPairingReport = {
  opponentId: string
  generation: number
  sourceId: string
  games: number
  wins: number
  losses: number
  draws: number
  winRate: number
  meanStoneDiff: number
  asBlack: { wins: number; losses: number; draws: number }
  asWhite: { wins: number; losses: number; draws: number }
}

function match(args: string[]): void {
  const argv = [...args]
  const outPath = takeArg(argv, '--out')
  // 任意の個体を GA 代表に当てる。指定すると下のつまみより優先する
  const cpuId = takeArg(argv, '--cpu')
  // 相手の着手間隔の想定を変えて測るためのつまみ（既定は MASTER_LEVEL のまま）
  const oppInterval = takeArg(argv, '--opp-interval')
  const oppReaction = takeArg(argv, '--opp-reaction')
  // 全滅回避の境目・全滅の余裕の重みを変えて測るためのつまみ
  const floor = takeArg(argv, '--survival-floor')
  const survival = takeArg(argv, '--survival')
  const wipeout = takeArg(argv, '--wipeout')
  const wipeout2 = takeArg(argv, '--wipeout2')
  const anyWeight = floor || survival || wipeout || wipeout2
  // 指定したときは実測追従を切り、その想定だけで読ませる
  const levelOverride =
    oppInterval || oppReaction || anyWeight
      ? {
          ...(oppInterval || oppReaction ? { adaptPace: false } : {}),
          ...(oppInterval ? { opponentIntervalMs: Number(oppInterval) } : {}),
          ...(oppReaction ? { opponentReactionMs: Number(oppReaction) } : {}),
          ...(anyWeight
            ? {
                weights: buildWeightTables({
                  ...BETA_WEIGHT_SPEC,
                  ...(floor ? { survivalFloor: Number(floor) } : {}),
                  ...(survival ? { survival: Number(survival) } : {}),
                  ...(wipeout ? { wipeout: Number(wipeout) } : {}),
                  ...(wipeout2 ? { wipeout2: Number(wipeout2) } : {}),
                }),
              }
            : {}),
        }
      : undefined
  const games = Number(argv[0] ?? 6)
  const only = argv[1]
  const targets = GA_MILESTONES.filter((m) => !only || m.id === only)
  if (targets.length === 0) {
    throw new Error(only ? `milestone not found: ${only}` : 'no GA milestones')
  }
  const masterSeed = 20260915

  let totalWin = 0
  let totalLoss = 0
  let totalDraw = 0
  const pairings: MatchPairingReport[] = []
  const wallStart = performance.now()

  for (const milestone of targets) {
    let win = 0
    let loss = 0
    let draw = 0
    let diffSum = 0
    const asBlack = { wins: 0, losses: 0, draws: 0 }
    const asWhite = { wins: 0, losses: 0, draws: 0 }
    for (let g = 0; g < games; g += 1) {
      const strategyIsBlack = g % 2 === 0
      const side: Stone = strategyIsBlack ? 'black' : 'white'
      const { gameSeed, decisionSeed } = matchSeeds(
        masterSeed,
        0,
        'strategy',
        milestone.id,
        side,
        g,
      )
      const geneSpec: OpponentSpec & { labelId: string } = {
        kind: 'gene',
        id: milestone.id,
        genes: [...milestone.genes],
        labelId: milestone.id,
      }
      const ourSpec = cpuId
        ? agentSpec(cpuId, freshAgent(cpuId))
        : strategySpec(levelOverride)
      const result = runGaMatch({
        matchId: `bench-${milestone.id}-g${g}`,
        seed: gameSeed,
        black: strategyIsBlack ? ourSpec : geneSpec,
        white: strategyIsBlack ? geneSpec : ourSpec,
        decisionSeed,
      })
      if (result.abnormal) {
        throw new Error(`abnormal match ${result.matchId}`)
      }
      const diff = strategyIsBlack
        ? result.stoneDiffForBlack
        : -result.stoneDiffForBlack
      diffSum += diff
      const color = strategyIsBlack ? asBlack : asWhite
      if (diff > 0) {
        win += 1
        color.wins += 1
      } else if (diff < 0) {
        loss += 1
        color.losses += 1
      } else {
        draw += 1
        color.draws += 1
      }
      if ((g + 1) % 20 === 0 || g + 1 === games) {
        console.error(
          `[strategy] ${milestone.id} ${g + 1}/${games} ${win}W ${loss}L ${draw}D`,
        )
      }
    }
    totalWin += win
    totalLoss += loss
    totalDraw += draw
    const decided = win + loss
    const pairing: MatchPairingReport = {
      opponentId: milestone.id,
      generation: milestone.generation,
      sourceId: milestone.sourceId,
      games,
      wins: win,
      losses: loss,
      draws: draw,
      winRate: decided > 0 ? win / decided : 0,
      meanStoneDiff: diffSum / games,
      asBlack,
      asWhite,
    }
    pairings.push(pairing)
    console.log(
      `${milestone.id.padEnd(8)} ${String(win).padStart(3)}W ` +
        `${String(loss).padStart(3)}L ${String(draw).padStart(2)}D  ` +
        `平均石差 ${(diffSum / games).toFixed(1)}`,
    )
  }

  const played = totalWin + totalLoss + totalDraw
  const elapsedSec = (performance.now() - wallStart) / 1000
  const decidedTotal = totalWin + totalLoss
  console.log('---')
  console.log(
    `合計 ${totalWin}勝 ${totalLoss}敗 ${totalDraw}分 / ${played}戦 ` +
      `勝率 ${((totalWin + totalDraw * 0.5) / played * 100).toFixed(1)}%`,
  )
  console.log(`所要 ${elapsedSec.toFixed(1)} 秒`)

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    const report = {
      strategyId: 'strategy',
      gamesPerOpponent: games,
      masterSeed,
      opponentIds: targets.map((m) => m.id),
      pairings,
      totals: {
        wins: totalWin,
        losses: totalLoss,
        draws: totalDraw,
        games: played,
        winRate: decidedTotal > 0 ? totalWin / decidedTotal : 0,
      },
      elapsedSec,
    }
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.error(`wrote ${outPath}`)
  }
}

function profile(): void {
  const boards = [20, 40, 60, 76].map((plies) => randomPlayout(4242, plies))
  const pos = createFastPosition()
  const buffer = new Int32Array(128)

  // 背景負荷の影響を避けるため、短い計測を何度も行い最小値を採る
  const bench = (name: string, fn: () => void, iterations: number): void => {
    let best = Infinity
    for (let round = 0; round < 15; round += 1) {
      const start = performance.now()
      for (let i = 0; i < iterations; i += 1) fn()
      const ms = performance.now() - start
      if (ms < best) best = ms
    }
    console.log(
      `${name.padEnd(16)} ${((best / iterations) * 1000).toFixed(3)} us/call`,
    )
  }

  for (const board of boards) {
    loadBoard(pos, board)
    console.log(`--- empties ${pos.emptyCount} ---`)
    bench('generateMoves', () => generateMoves(pos, WHITE, buffer, 0), 50_000)
    bench('scanLeaf', () => scanLeaf(pos), 50_000)
    bench('countStable', () => countStable(pos), 50_000)
    bench(
      'scan+stable',
      () => {
        scanLeaf(pos)
        countStable(pos)
      },
      50_000,
    )
    bench('evaluate', () => evaluate(pos, WHITE, true), 50_000)
    const move = buffer[0]
    bench(
      'doMove+undo',
      () => {
        const f = doMove(pos, move, WHITE)
        undoMove(pos, move, WHITE, f)
      },
      50_000,
    )
  }
}

function levelAgent(name: string, level: StrategyLevel): CpuAgent {
  return createStrategyCpu({ id: 'strategy', label: name, level })
}

function agentSpec(
  id: string,
  agent: CpuAgent,
): OpponentSpec & { labelId: string } {
  return { kind: 'agent', id, agent, labelId: id }
}

type DuelResult = { win: number; loss: number; draw: number; diff: number }

/**
 * 本番と同じ実時間の進行で 2 体を黒白交互に当てる。
 *
 * 下の `duel`（交互手番）とは**結果が食い違うことがある**。潜在着手 0.5 倍は
 * 交互手番でデルタに 60勝0敗だったのに、こちらでは 2勝55敗だった。
 * 本番は実時間なので、採否はこちらで決める（`docs/strategy-ai.md`）。
 */
function pacedDuel(
  agentA: CpuAgent,
  agentB: CpuAgent,
  idA: string,
  idB: string,
  games: number,
  seed: number,
  delay: number,
): DuelResult & { wipedA: number; wipedB: number } {
  let win = 0
  let loss = 0
  let draw = 0
  let diffSum = 0
  let wipedA = 0
  let wipedB = 0

  for (let g = 0; g < games; g += 1) {
    const aIsBlack = g % 2 === 0
    const { gameSeed, decisionSeed } = matchSeeds(
      seed,
      delay,
      idA,
      idB,
      aIsBlack ? 'black' : 'white',
      g,
    )
    const result = runPacedMatch({
      seed: gameSeed,
      decisionSeed,
      black: aIsBlack ? agentA : agentB,
      white: aIsBlack ? agentB : agentA,
      blackThinkDelayMs: delay,
      whiteThinkDelayMs: delay,
    })
    if (result.abnormal) throw new Error(`abnormal match #${g}`)
    const diff = aIsBlack ? -result.diffForWhite : result.diffForWhite
    diffSum += diff
    if (diff > 0) win += 1
    else if (diff < 0) loss += 1
    else draw += 1
    const stonesA = aIsBlack ? result.stones.black : result.stones.white
    const stonesB = aIsBlack ? result.stones.white : result.stones.black
    if (stonesA === 0) wipedA += 1
    if (stonesB === 0) wipedB += 1
  }
  return { win, loss, draw, diff: diffSum / games, wipedA, wipedB }
}

/** 同じ探索設定どうしを黒白交互で当てて、勝敗と平均石差を返す */
function duel(
  nameA: string,
  levelA: StrategyLevel,
  nameB: string,
  levelB: StrategyLevel,
  games: number,
  seed: number,
): DuelResult {
  let win = 0
  let loss = 0
  let draw = 0
  let diffSum = 0
  for (let g = 0; g < games; g += 1) {
    const aIsBlack = g % 2 === 0
    const { gameSeed, decisionSeed } = matchSeeds(
      seed,
      0,
      nameA,
      nameB,
      aIsBlack ? 'black' : 'white',
      g,
    )
    const specA = agentSpec(nameA, levelAgent(nameA, levelA))
    const specB = agentSpec(nameB, levelAgent(nameB, levelB))
    const result = runGaMatch({
      matchId: `duel-${nameA}-${nameB}-${g}`,
      seed: gameSeed,
      black: aIsBlack ? specA : specB,
      white: aIsBlack ? specB : specA,
      decisionSeed,
    })
    const diff = aIsBlack
      ? result.stoneDiffForBlack
      : -result.stoneDiffForBlack
    diffSum += diff
    if (diff > 0) win += 1
    else if (diff < 0) loss += 1
    else draw += 1
  }
  return { win, loss, draw, diff: diffSum / games }
}

/** 既定の全滅回避。石 1 枚での罰則は (6-1)^2 * 300 = 7500 */
const BASE_SURVIVAL_FLOOR = DEFAULT_WEIGHTS.survivalFloor
const BASE_SURVIVAL_PENALTY =
  (BASE_SURVIVAL_FLOOR - 1) ** 2 * DEFAULT_WEIGHT_SPEC.survival

type TunableTerm = keyof PhaseWeights | 'survival'

/** 名前付き個体。掃引の基準や `mix-` の土台に使う */
const NAMED_SPECS: Record<
  string,
  { spec: WeightSpec; level: StrategyLevel }
> = {
  alpha: { spec: ALPHA_WEIGHT_SPEC, level: ALPHA_LEVEL },
  beta: { spec: BETA_WEIGHT_SPEC, level: BETA_LEVEL },
  gamma: { spec: GAMMA_WEIGHT_SPEC, level: GAMMA_LEVEL },
  delta: { spec: DELTA_WEIGHT_SPEC, level: DELTA_LEVEL },
  epsilon: { spec: EPSILON_WEIGHT_SPEC, level: EPSILON_LEVEL },
}

const TUNABLE_TERMS: TunableTerm[] = [
  'corner',
  'stable',
  'mobility',
  'potential',
  'xSquare',
  'cSquare',
  'edge',
  'disc',
  'parity',
  'survival',
]

function scaleTerm(
  spec: WeightSpec,
  term: TunableTerm,
  factor: number,
): WeightSpec {
  if (term === 'survival') return { ...spec, survival: spec.survival * factor }
  return {
    ...spec,
    opening: { ...spec.opening, [term]: spec.opening[term] * factor },
    midgame: { ...spec.midgame, [term]: spec.midgame[term] * factor },
    endgame: { ...spec.endgame, [term]: spec.endgame[term] * factor },
  }
}

/**
 * 評価の重みを 1 項ずつ増減して、基準と当てる。
 *
 * 探索は飽和していて読みを増やしても勝率が動かないので、
 * 強くするなら評価側を直すしかない。まずどの項がずれているかを見る。
 *
 * **採否は `--paced` で決めること。** 既定の交互手番は速いが、
 * 本番の実時間とは結果が食い違う（潜在着手 0.5 倍が 60勝0敗 → 2勝55敗）。
 * 同じく**ノード数も本番の 14000 で測る**。3500 では 3 項が逆に出た。
 */
function tune(args: string[]): void {
  const argv = [...args]
  const nodes = Number(takeArg(argv, '--nodes') ?? 3_500)
  const seed = Number(takeArg(argv, '--seed') ?? 555_001)
  const only = takeArg(argv, '--term')
  const baseId = takeArg(argv, '--base') ?? 'default'
  const paced = argv.includes('--paced')
  const delay = GAME_CONFIG.cpuThinkDelayMs
  const games = Number(argv.filter((a) => a !== '--paced')[0] ?? 60)
  const factors = (takeArg(argv, '--factors') ?? '0.5,2')
    .split(',')
    .map(Number)

  // 掃引の基準。いまの最強の上で測りたいときは --base delta
  //
  // 名前付き個体を指定したときは、**その個体の探索設定をそのまま使う**。
  // 以前は重みだけ借りて `MASTER_LEVEL`（相手ペース追従オフ）で回しており、
  // 本番と別物を測っていた（潜在着手 0.5 倍が 60勝0敗 → 実際は 2勝55敗）。
  const picked = NAMED_SPECS[baseId]
  const baseSpec = picked?.spec ?? DEFAULT_WEIGHT_SPEC
  const base: StrategyLevel = picked
    ? { ...picked.level, nodeBudget: nodes }
    : {
        ...MASTER_LEVEL,
        nodeBudget: nodes,
        ponderStepNodes: 0,
        adaptPace: false,
        weights: DEFAULT_WEIGHTS,
      }
  const terms = only
    ? TUNABLE_TERMS.filter((t) => t === only)
    : TUNABLE_TERMS

  console.log(
    `重み 1 項ずつ ${games}戦・黒白交互・探索 ${nodes} ノード・基準 ${baseId}` +
      `・${paced ? '実時間（本番と同じ）' : '交互手番'}`,
  )
  console.log('項目        倍率  勝-負-分     平均石差')
  for (const term of terms) {
    for (const factor of factors) {
      const spec = scaleTerm(baseSpec, term, factor)
      const candidate: StrategyLevel = {
        ...base,
        weights: buildWeightTables(spec),
      }
      const name = `${term}x${factor}`
      const r = paced
        ? pacedDuel(
            levelAgent(name, candidate),
            levelAgent(baseId, base),
            name,
            baseId,
            games,
            seed,
            delay,
          )
        : duel(name, candidate, baseId, base, games, seed)
      console.log(
        `${term.padEnd(11)} x${String(factor).padEnd(4)} ` +
          `${`${r.win}-${r.loss}-${r.draw}`.padEnd(12)} ` +
          `${r.diff >= 0 ? '+' : ''}${r.diff.toFixed(1)}`,
      )
    }
  }
}

/** 探索が効いているかの確認: 同じ評価関数で持ち時間だけ変える */
function ladder(args: string[]): void {
  const games = Number(args[0] ?? 10)
  const pairs: Array<[string, StrategyLevel, string, StrategyLevel]> = [
    [
      'budget x4',
      { ...MASTER_LEVEL, nodeBudget: MASTER_LEVEL.nodeBudget * 4 },
      'default',
      MASTER_LEVEL,
    ],
    [
      'default',
      MASTER_LEVEL,
      'budget /4',
      { ...MASTER_LEVEL, nodeBudget: Math.round(MASTER_LEVEL.nodeBudget / 4) },
    ],
    [
      'default',
      MASTER_LEVEL,
      'depth2',
      { ...MASTER_LEVEL, maxDepth: 2 },
    ],
    [
      'depth2',
      { ...MASTER_LEVEL, maxDepth: 2 },
      'depth1',
      { ...MASTER_LEVEL, maxDepth: 1 },
    ],
  ]

  for (const [nameA, levelA, nameB, levelB] of pairs) {
    let win = 0
    let loss = 0
    let draw = 0
    let diffSum = 0
    for (let g = 0; g < games; g += 1) {
      const aIsBlack = g % 2 === 0
      const side: Stone = aIsBlack ? 'black' : 'white'
      const { gameSeed, decisionSeed } = matchSeeds(
        7654321,
        0,
        nameA,
        nameB,
        side,
        g,
      )
      const specA = agentSpec(nameA, levelAgent(nameA, levelA))
      const specB = agentSpec(nameB, levelAgent(nameB, levelB))
      const result = runGaMatch({
        matchId: `ladder-${nameA}-${nameB}-${g}`,
        seed: gameSeed,
        black: aIsBlack ? specA : specB,
        white: aIsBlack ? specB : specA,
        decisionSeed,
      })
      const diff = aIsBlack
        ? result.stoneDiffForBlack
        : -result.stoneDiffForBlack
      diffSum += diff
      if (diff > 0) win += 1
      else if (diff < 0) loss += 1
      else draw += 1
    }
    console.log(
      `${nameA} vs ${nameB}: ${win}勝 ${loss}敗 ${draw}分  ` +
        `平均石差 ${(diffSum / games).toFixed(1)}`,
    )
  }
}

/** 既定設定の手が、十分に深く読んだ手とどれだけ一致するか */
function agree(args: string[]): void {
  const deepFactor = Number(args[0] ?? 12)
  const deep: StrategyLevel = {
    ...MASTER_LEVEL,
    nodeBudget: MASTER_LEVEL.nodeBudget * deepFactor,
  }
  const buckets = new Map<string, { same: number; total: number }>()

  for (let seed = 1; seed <= 40; seed += 1) {
    for (const plies of [12, 24, 36, 48, 60, 72]) {
      const board = randomPlayout(seed * 3571, plies)
      if (listLegalMoves(board, 'white').length < 2) continue
      const match = { ...createMatch({ seed }), board }
      const publicState = toPublicMatchState(match)
      const fast = decideStrategyMove(
        publicState,
        createRng(1),
        'white',
        MASTER_LEVEL,
      )
      const slow = decideStrategyMove(publicState, createRng(1), 'white', deep)
      if (fast.decision.type !== 'move' || slow.decision.type !== 'move') {
        continue
      }
      const key = `手数 ${plies}`
      const bucket = buckets.get(key) ?? { same: 0, total: 0 }
      bucket.total += 1
      if (
        fast.decision.row === slow.decision.row &&
        fast.decision.col === slow.decision.col
      ) {
        bucket.same += 1
      }
      buckets.set(key, bucket)
    }
  }

  let same = 0
  let total = 0
  for (const [key, bucket] of buckets) {
    same += bucket.same
    total += bucket.total
    console.log(
      `${key.padEnd(8)} 一致 ${bucket.same}/${bucket.total} ` +
        `(${((bucket.same / bucket.total) * 100).toFixed(0)}%)`,
    )
  }
  console.log('---')
  console.log(
    `既定 vs ${deepFactor}倍読み: 一致 ${same}/${total} ` +
      `(${((same / total) * 100).toFixed(1)}%)`,
  )
}

/**
 * 相手の着手間隔の想定を変えて、速い相手・遅い相手の両方に当てる。
 * プレイヤーは待ち時間 700ms だけで打てるが、CPU は判断待ち 500ms を足した
 * 1200ms 間隔になる。固定の想定 2 通りと、対局中に測る既定を並べて比べる。
 */
function human(args: string[]): void {
  const games = Number(args[0] ?? 12)
  const blackId = args[1] ?? 'ga_best'
  const black = getCpuAgent(blackId as Parameters<typeof getCpuAgent>[0])

  const models: Array<[string, StrategyLevel]> = [
    ['実測追従(既定)', MASTER_LEVEL],
    ['固定1200ms想定', { ...MASTER_LEVEL, adaptPace: false }],
    [
      '固定700ms想定',
      {
        ...MASTER_LEVEL,
        adaptPace: false,
        opponentIntervalMs: GAME_CONFIG.cooldownMs,
        opponentReactionMs: 0,
      },
    ],
  ]
  const paces: Array<[string, number]> = [
    ['最速700ms', 0],
    ['CPU並1200ms', GAME_CONFIG.cpuThinkDelayMs],
  ]

  console.log(`黒（プレイヤー役）: ${black.label} / ${games}戦ずつ`)
  for (const [paceName, delay] of paces) {
    for (const [name, level] of models) {
      const white = levelAgent(name, level)
      let win = 0
      let loss = 0
      let draw = 0
      let diffSum = 0
      for (let g = 0; g < games; g += 1) {
        const { gameSeed, decisionSeed } = matchSeeds(
          31415926,
          0,
          'strategy',
          blackId,
          'white',
          g,
        )
        const result = runPacedMatch({
          seed: gameSeed,
          decisionSeed,
          black,
          white,
          blackThinkDelayMs: delay,
        })
        if (result.abnormal) throw new Error(`abnormal match ${name} #${g}`)
        diffSum += result.diffForWhite
        if (result.diffForWhite > 0) win += 1
        else if (result.diffForWhite < 0) loss += 1
        else draw += 1
      }
      console.log(
        `黒${paceName.padEnd(11)} 白${name.padEnd(14)} ` +
          `${String(win).padStart(3)}勝 ${String(loss).padStart(3)}敗 ` +
          `${String(draw).padStart(2)}分  平均石差 ${(diffSum / games).toFixed(1)}`,
      )
    }
  }
}

/**
 * 手番前の下読みが効いているかを、50ms ステップを回す対戦で測る。
 *
 * 下読みあり側だけが手番前のステップを使える。着手時のノード上限は両者同じなので、
 * 差はそのまま「待ち時間を読みに使えたぶん」になる。
 */
function ponderBench(args: string[]): void {
  const argv = [...args]
  const fixedPace = argv.includes('--fixed-pace')
  if (fixedPace) argv.splice(argv.indexOf('--fixed-pace'), 1)
  const seed = Number(takeArg(argv, '--seed') ?? 20260915)
  const decideNodes = Number(
    takeArg(argv, '--decide-nodes') ?? MASTER_LEVEL.nodeBudget,
  )
  const baseNodes = Number(
    takeArg(argv, '--base-nodes') ?? MASTER_LEVEL.nodeBudget,
  )
  const games = Number(argv[0] ?? 20)
  const stepNodes = Number(argv[1] ?? MASTER_LEVEL.ponderStepNodes)
  const common: StrategyLevel = { ...MASTER_LEVEL, adaptPace: !fixedPace }
  const withPonder: StrategyLevel = {
    ...common,
    nodeBudget: decideNodes,
    ponderStepNodes: stepNodes,
  }
  const without: StrategyLevel = {
    ...common,
    nodeBudget: baseNodes,
    ponderStepNodes: 0,
  }

  let win = 0
  let loss = 0
  let draw = 0
  let diffSum = 0
  const wallStart = performance.now()

  for (let g = 0; g < games; g += 1) {
    const ponderIsWhite = g % 2 === 0
    const { gameSeed, decisionSeed } = matchSeeds(
      seed,
      0,
      'ponder',
      'noponder',
      ponderIsWhite ? 'white' : 'black',
      g,
    )
    const result = runPacedMatch({
      seed: gameSeed,
      decisionSeed,
      black: levelAgent('黒', ponderIsWhite ? without : withPonder),
      white: levelAgent('白', ponderIsWhite ? withPonder : without),
      blackThinkDelayMs: GAME_CONFIG.cpuThinkDelayMs,
    })
    if (result.abnormal) throw new Error(`abnormal match #${g}`)
    const diff = ponderIsWhite ? result.diffForWhite : -result.diffForWhite
    diffSum += diff
    if (diff > 0) win += 1
    else if (diff < 0) loss += 1
    else draw += 1
    if ((g + 1) % 4 === 0) {
      console.error(`[ponder] ${g + 1}/${games} ${win}W ${loss}L ${draw}D`)
    }
  }

  console.log(
    `下読みあり: 着手 ${decideNodes} + 1ステップ ${stepNodes} ノード / ` +
      `なし: 着手 ${baseNodes} ノード / ` +
      `${games}戦・黒白交互・seed ${seed}${fixedPace ? '・ペース固定' : ''}`,
  )
  console.log(
    `下読みあり ${win}勝 ${loss}敗 ${draw}分  平均石差 ${(diffSum / games).toFixed(1)}`,
  )
  console.log(`所要 ${((performance.now() - wallStart) / 1000).toFixed(1)} 秒`)
}

/**
 * 戦略系は着手ペースの推定を実体ごとに持つので、両側に同じ id を置くときは別々に作る。
 * `getCpuAgent` は同じ実体を返すため、そのまま両側に置くと推定が混ざる。
 */
function freshAgent(id: string): CpuAgent {
  if (id === 'beta') return createBetaCpu()
  if (id === 'gamma') return createGammaCpu()
  if (id === 'delta') return createDeltaCpu()
  if (id === 'epsilon') return createEpsilonCpu()
  if (id === 'alpha') return createAlphaCpu()
  if (id === 'strategy') {
    return createStrategyCpu({ id: 'strategy', label: '戦略AI', level: MASTER_LEVEL })
  }
  // 相手が速いほど全滅回避の境目を上げる版。alpharatio-<最速時の境目>
  //
  // 「相手が自分の何倍打てるか」の連続関数で境目を 6→上限 まで動かす。
  // 同速以下なら比は 1 以下＝境目 6 ＝アルファと完全に同じ。
  // 石 1 枚での罰則はどの比でも約 7500 になるよう重みを合わせる。
  //
  // **アルファには入れていない。** 最速の max_flip には 56.7%→85.0% と効くが、
  // 同じ速さの GA 第100世代に 100%→18.3% と崩れる（docs/strategy-ai.md）。
  // 残してあるのは、次に別の形を試すときの比較の基準にするため。
  if (id.startsWith('alpharatio')) {
    const maxFloor = Number(id.split('-')[1] ?? 14)
    const selfIntervalMs = GAME_CONFIG.cooldownMs + GAME_CONFIG.cpuThinkDelayMs
    const maxRatio = selfIntervalMs / GAME_CONFIG.cooldownMs
    const cache = new Map<number, WeightTables>()
    // 推定間隔は試合が進むと上に流れる（相手が打てない時間も分母の時間に入るため）。
    // 相手の「速さ」としては最も速かったときの値を使う。遅くなったように見えても、
    // 相手がその速さで打てること自体は変わらない。
    //
    // 測る前は「相手は最速」と見る。全滅させられるのは序盤の数手なので、
    // 観測が溜まるのを待つと間に合わない（実測: 初期想定だけ直しても効かない）。
    // 取り違えたときの損は非対称で、遅い相手を速いと見ても数手ぶん慎重になるだけ。
    let fastestMs: number | null = null
    const weightsFor = (pace: PaceEstimate): WeightTables => {
      if (!pace.measured) fastestMs = null
      else if (fastestMs === null) fastestMs = pace.intervalMs
      else fastestMs = Math.min(fastestMs, pace.intervalMs)
      // 未観測の間だけ最速と見る。観測が入ったらそちらに従う
      const intervalMs = fastestMs ?? GAME_CONFIG.cooldownMs
      const cached = cache.get(intervalMs)
      if (cached) return cached
      const ratio = selfIntervalMs / Math.max(1, intervalMs)
      const t = Math.min(1, Math.max(0, (ratio - 1) / (maxRatio - 1)))
      const survivalFloor =
        BASE_SURVIVAL_FLOOR + (maxFloor - BASE_SURVIVAL_FLOOR) * t
      const built = buildWeightTables({
        ...ALPHA_WEIGHT_SPEC,
        survivalFloor,
        survival: BASE_SURVIVAL_PENALTY / (survivalFloor - 1) ** 2,
      })
      cache.set(intervalMs, built)
      return built
    }
    return createStrategyCpu({
      id: 'alpha',
      label: `アルファ(最速時の比で境目 6→${maxFloor})`,
      level: { ...ALPHA_LEVEL, weightsForPace: weightsFor },
    })
  }
  // 全滅までの余裕を見る項の重みを変えた版。alphawipe-<重み>。0 で切る
  if (id.startsWith('alphawipe-')) {
    const weight = Number(id.split('-')[1])
    return createStrategyCpu({
      id: 'alpha',
      label: weight === 0 ? 'アルファ(全滅の余裕なし)' : `アルファ(全滅の余裕×${weight})`,
      level: {
        ...ALPHA_LEVEL,
        weights: buildWeightTables({ ...ALPHA_WEIGHT_SPEC, wipeout: weight }),
      },
    })
  }
  // ベータに「相手の 2 手で全滅」を足した版。betawipe2-<重み>。0 ならベータそのもの
  if (id.startsWith('betawipe2-')) {
    const weight = Number(id.split('-')[1])
    return createStrategyCpu({
      id: 'beta',
      label: weight === 0 ? 'ベータ' : `ベータ+2手先の全滅×${weight}`,
      level: {
        ...BETA_LEVEL,
        weights: buildWeightTables({ ...BETA_WEIGHT_SPEC, wipeout2: weight }),
      },
    })
  }
  // 全滅回避の境目と重みを変えた版。alphafloor-<境目>-<重み>
  // 既定は 6 枚未満・重み 300 で、速い相手には遅すぎて間に合わない
  if (id.startsWith('alphafloor-')) {
    const [, floor, weight] = id.split('-')
    return createStrategyCpu({
      id: 'alpha',
      label: `アルファ(全滅回避 ${floor}枚未満×${weight})`,
      level: {
        ...ALPHA_LEVEL,
        weights: buildWeightTables({
          ...ALPHA_WEIGHT_SPEC,
          survivalFloor: Number(floor),
          survival: Number(weight),
        }),
      },
    })
  }
  // 相手の速さで着手可能数の重みを切り替える版。速い相手への対策の検証用。
  // alphapace-<速い相手のときの倍率>-<切り替える間隔ms>
  if (id.startsWith('alphapace-')) {
    const [, factor, threshold] = id.split('-')
    const fast = buildWeightTables(
      scaleTerm(ALPHA_WEIGHT_SPEC, 'mobility', Number(factor)),
    )
    const thresholdMs = Number(threshold)
    return createStrategyCpu({
      id: 'alpha',
      label: `アルファ(${thresholdMs}ms未満なら着手可能数×${factor})`,
      level: {
        ...ALPHA_LEVEL,
        weightsForPace: (pace) =>
          pace.intervalMs < thresholdMs ? fast : ALPHA_LEVEL.weights,
      },
    })
  }
  // 測り始めるまでの初期想定だけ変えた版（測り始めたら実測に従う）
  if (id.startsWith('alphaopen-')) {
    const intervalMs = Number(id.split('-')[1])
    return createStrategyCpu({
      id: 'alpha',
      label: `アルファ(初期${intervalMs}ms)`,
      level: {
        ...ALPHA_LEVEL,
        opponentIntervalMs: intervalMs,
        opponentReactionMs: Math.max(0, intervalMs - GAME_CONFIG.cooldownMs),
      },
    })
  }
  // 相手ペースを測らず決め打ちする版。推定が効いているかの切り分けに使う
  if (id.startsWith('alphafix-')) {
    const intervalMs = Number(id.split('-')[1])
    return createStrategyCpu({
      id: 'alpha',
      label: `アルファ(${intervalMs}ms固定)`,
      level: {
        ...ALPHA_LEVEL,
        adaptPace: false,
        opponentIntervalMs: intervalMs,
        opponentReactionMs: Math.max(0, intervalMs - GAME_CONFIG.cooldownMs),
      },
    })
  }
  // ベータから 1 項だけ動かした版。betaterm-<項>-<倍率>
  if (id.startsWith('betaterm-')) {
    const [, term, factor] = id.split('-')
    return createStrategyCpu({
      id: 'beta',
      label: `ベータ(${term}×${factor})`,
      level: {
        ...BETA_LEVEL,
        weights: buildWeightTables(
          scaleTerm(BETA_WEIGHT_SPEC, term as TunableTerm, Number(factor)),
        ),
      },
    })
  }
  // ガンマから 1 項だけ動かした版。gammaterm-<項>-<倍率>
  if (id.startsWith('gammaterm-')) {
    const [, term, factor] = id.split('-')
    return createStrategyCpu({
      id: 'gamma',
      label: `ガンマ(${term}×${factor})`,
      level: {
        ...GAMMA_LEVEL,
        weights: buildWeightTables(
          scaleTerm(GAMMA_WEIGHT_SPEC, term as TunableTerm, Number(factor)),
        ),
      },
    })
  }
  // 複数項をまとめて動かした版。mix-<基準>-<項>:<倍率>,<項>:<倍率>,…
  // 例: mix-gamma-mobility:2,disc:0.5
  if (id.startsWith('mix-')) {
    const [, baseId, list] = id.split('-')
    const picked = NAMED_SPECS[baseId]
    if (!picked) throw new Error(`unknown mix base: ${baseId}`)
    let spec = picked.spec
    for (const part of list.split(',')) {
      // `項:倍率` は掛け算、`項=値` は絶対値（全滅の余裕など倍率に意味がない項）
      if (part.includes('=')) {
        const [key, value] = part.split('=')
        spec = { ...spec, [key]: Number(value) }
        continue
      }
      const [term, factor] = part.split(':')
      spec = scaleTerm(spec, term as TunableTerm, Number(factor))
    }
    return createStrategyCpu({
      id: baseId,
      label: `${baseId}(${list})`,
      level: { ...picked.level, weights: buildWeightTables(spec) },
    })
  }
  // ガンマに 2 手先の全滅を足した版。gammawipe2-<重み>
  if (id.startsWith('gammawipe2-')) {
    const weight = Number(id.split('-')[1])
    return createStrategyCpu({
      id: 'gamma',
      label: weight === 0 ? 'ガンマ' : `ガンマ+2手先の全滅×${weight}`,
      level: {
        ...GAMMA_LEVEL,
        weights: buildWeightTables({ ...GAMMA_WEIGHT_SPEC, wipeout2: weight }),
      },
    })
  }
  // アルファから 1 点だけ戻した比較用。どの変更が効いているかの切り分けに使う
  if (id.startsWith('alpha-')) {
    const [, term, factor] = id.split('-')
    return createStrategyCpu({
      id: 'alpha',
      label: `アルファ(${term}×${factor})`,
      level: {
        ...ALPHA_LEVEL,
        weights: buildWeightTables(
          scaleTerm(ALPHA_WEIGHT_SPEC, term as TunableTerm, Number(factor)),
        ),
      },
    })
  }
  return getCpuAgent(id as Parameters<typeof getCpuAgent>[0])
}

/**
 * `freshAgent` の 2 体を黒白交互で当てる。速さは両者そろえる。
 *
 * `pace` は「黒＝プレイヤー・白＝CPU」を固定するので色の偏りが乗る。
 * 設定変更が本来の用途（落ち着いた相手）で損をしていないかは、こちらで見る。
 */
function versus(args: string[]): void {
  const argv = [...args]
  const seed = Number(takeArg(argv, '--seed') ?? 20260915)
  const delay = Number(takeArg(argv, '--delay') ?? GAME_CONFIG.cpuThinkDelayMs)
  const games = Number(argv[0] ?? 60)
  const idA = argv[1] ?? 'alphafloor-14-45'
  const idB = argv[2] ?? 'alpha'

  const agentA = freshAgent(idA)
  const agentB = freshAgent(idB)
  const r = pacedDuel(agentA, agentB, idA, idB, games, seed, delay)

  console.log(
    `${agentA.label} vs ${agentB.label} / ${games}戦・黒白交互 / ` +
      `双方の判断待ち ${delay}ms / seed ${seed}`,
  )
  console.log(
    `${r.win}勝 ${r.loss}敗 ${r.draw}分（${((r.win / games) * 100).toFixed(1)}%） ` +
      `平均石差 ${r.diff.toFixed(1)} / 全滅 ${r.wipedA}:${r.wipedB}`,
  )
}

/** 黒の 1 手で返せる白石の最大枚数。空きマスを全部試す（遅いが `scanLeaf` の重みに依存しない） */
function maxWhiteFlips(pos: FastPosition): number {
  const { cells, emptyNext } = pos
  let best = 0
  for (let i = emptyNext[EMPTY_HEAD]; i !== EMPTY_HEAD; i = emptyNext[i]) {
    let total = 0
    for (let d = 0; d < 8; d += 1) {
      const dir = DIRS[d]
      let j = i + dir
      let run = 0
      while (cells[j] === WHITE) {
        run += 1
        j += dir
      }
      if (run !== 0 && cells[j] === BLACK) total += run
    }
    if (total > best) best = total
  }
  return best
}

/** 黒が何手続けて打てば白を 0 枚にできるか。届かなければ `Infinity` */
function movesToWipeWhite(pos: FastPosition, limit: number): number {
  if (pos.white === 0) return 0
  if (maxWhiteFlips(pos) >= pos.white) return 1
  if (limit <= 1) return Infinity
  const buf = new Int32Array(128)
  const count = generateMoves(pos, BLACK, buf, 0)
  let best = Infinity
  for (let k = 0; k < count; k += 1) {
    const move = buf[k]
    const flips = doMove(pos, move, BLACK)
    const found = movesToWipeWhite(pos, limit - 1)
    undoMove(pos, move, BLACK, flips)
    if (found + 1 < best) best = found + 1
  }
  return best
}

/**
 * 全滅で負けた試合を再現し、負けが何手先まで見えていれば防げたかを測る。
 *
 * `docs/strategy-ai.md`「2 手先の全滅」の数字はこれで出している。
 * 自分の着手の直後の盤面を集め、負けを決めた 1 手（致命手）と
 * 同じ試合のふつうの手を並べて、どの条件なら前者だけを拾えるかを見る。
 */
function wipeoutDiag(args: string[]): void {
  const argv = [...args]
  const whiteId = takeArg(argv, '--white') ?? 'strategy'
  const delay = Number(takeArg(argv, '--delay') ?? 0)
  const seed = Number(takeArg(argv, '--seed') ?? 20260915)
  const depth = Number(takeArg(argv, '--depth') ?? 3)
  const games = Number(argv[0] ?? 60)

  const black = freshAgent('max_flip')
  const white = freshAgent(whiteId)
  const pos = createFastPosition()
  const buf = new Int32Array(128)

  // 何手先まで読めば全滅と分かるか。致命手とふつうの手で別々に数える
  const fatalAt = new Map<number, number>()
  const plainAt = new Map<number, number>()
  const bump = (into: Map<number, number>, n: number): void => {
    into.set(n, (into.get(n) ?? 0) + 1)
  }
  let wiped = 0
  let fatal = 0
  let plain = 0
  // 致命手の何手前まで遡れば、全滅に届かない手があったか
  const escapeAt: number[] = []

  for (let g = 0; g < games; g += 1) {
    const { gameSeed, decisionSeed } = matchSeeds(
      seed,
      delay,
      whiteId,
      'max_flip',
      'white',
      g,
    )
    const boards: Array<{ board: Board; whiteMoved: boolean }> = []
    const result = runPacedMatch({
      seed: gameSeed,
      decisionSeed,
      black,
      white,
      blackThinkDelayMs: delay,
      observe: (step) => {
        boards.push({
          board: step.board.map((row) => [...row]),
          whiteMoved: step.white !== undefined,
        })
      },
    })
    // 誤爆率は勝った試合も含めて数える。負けた試合だけ見ると分母が偏る
    const lost = result.stones.white === 0
    if (lost) wiped += 1

    // 白が打ったステップの「打つ前」と「打ったあと」
    const own: Array<{ before: Board; after: Board }> = []
    for (let i = 0; i < boards.length; i += 1) {
      if (!boards[i].whiteMoved || !boards[i + 1]) continue
      own.push({ before: boards[i].board, after: boards[i + 1].board })
    }
    if (own.length === 0) continue

    for (let k = 0; k < own.length; k += 1) {
      loadBoard(pos, own[k].after)
      if (pos.white === 0) continue
      // 確定石が 1 つでもあれば全滅はありえない
      if (countStable(pos).white > 0) continue
      loadBoard(pos, own[k].after) // countStable は盤を書き換える
      const need = movesToWipeWhite(pos, depth)
      if (lost && k === own.length - 1) {
        fatal += 1
        bump(fatalAt, need)
      } else {
        plain += 1
        bump(plainAt, need)
      }
    }

    if (!lost) continue
    // 致命手から遡り、「全滅に届かない手」があった最後の地点を探す
    let back = -1
    for (let k = own.length - 1; k >= 0 && back < 0; k -= 1) {
      loadBoard(pos, own[k].before)
      const count = generateMoves(pos, WHITE, buf, 0)
      for (let m = 0; m < count && back < 0; m += 1) {
        const flips = doMove(pos, buf[m], WHITE)
        if (movesToWipeWhite(pos, depth) > depth) back = own.length - 1 - k
        undoMove(pos, buf[m], WHITE, flips)
      }
    }
    escapeAt.push(back)
  }

  const pct = (n: number, total: number): string =>
    total === 0 ? '   -  ' : `${((n / total) * 100).toFixed(1).padStart(5)}%`

  console.log(
    `白 ${white.label} vs 黒 ${black.label}（判断待ち ${delay}ms）/ ${games}戦 / seed ${seed}`,
  )
  console.log(`全滅で負けた試合: ${wiped}/${games}`)
  console.log(`致命手 ${fatal} 局面 / ふつうの自着手 ${plain} 局面（確定石 0 のみ）`)
  console.log('')
  console.log('黒が全滅させるのに要る手数  致命手            ふつうの手')
  for (let n = 1; n <= depth; n += 1) {
    const f = fatalAt.get(n) ?? 0
    const p = plainAt.get(n) ?? 0
    console.log(
      `${String(n).padStart(20)} 手  ` +
        `${String(f).padStart(4)}/${String(fatal).padEnd(5)} ${pct(f, fatal)}  ` +
        `${String(p).padStart(4)}/${String(plain).padEnd(5)} ${pct(p, plain)}`,
    )
  }
  const fOut = fatalAt.get(Infinity) ?? 0
  const pOut = plainAt.get(Infinity) ?? 0
  console.log(
    `${String(depth).padStart(18)} 手超  ` +
      `${String(fOut).padStart(4)}/${String(fatal).padEnd(5)} ${pct(fOut, fatal)}  ` +
      `${String(pOut).padStart(4)}/${String(plain).padEnd(5)} ${pct(pOut, plain)}`,
  )
  console.log('')
  const trail = new Map<number, number>()
  for (const n of escapeAt) trail.set(n, (trail.get(n) ?? 0) + 1)
  console.log(
    '逃げ道があった最後の地点: ' +
      [...trail]
        .sort((a, b) => a[0] - b[0])
        .map(([n, c]) => (n < 0 ? `なし:${c}` : `${n}手前:${c}`))
        .join('  '),
  )
}

/**
 * 相手の着手の速さを振って、このゲーム固有の負け方を探す。
 *
 * 黒（プレイヤー役）の判断待ちを 0ms（クールタイムが明けた瞬間に打つ）から
 * 無操作 3 秒に引っかかる手前まで動かし、白（アルファ）の成績を速度ごとに見る。
 * 勝敗だけでなく、着手回数の比・全滅・時間切れ終局・無操作の自動着手も出す。
 * 勝率が落ちる帯があれば、そこがこのゲーム固有の穴。
 */
function paceSweep(args: string[]): void {
  const argv = [...args]
  const whiteId = takeArg(argv, '--white') ?? 'alpha'
  const seed = Number(takeArg(argv, '--seed') ?? 20260915)
  const delaysArg = takeArg(argv, '--delays')
  const games = Number(argv[0] ?? 40)
  const blackId = argv[1] ?? 'max_flip'
  const delays = delaysArg
    ? delaysArg.split(',').map((s) => Number(s))
    : [0, 150, 350, 500, 800, 1200, 1800, 2400]

  const black = freshAgent(blackId)
  const white = freshAgent(whiteId)

  console.log(
    `白 ${white.label} vs 黒 ${black.label} / 速度ごとに ${games}戦 / seed ${seed}`,
  )
  console.log(
    '黒の判断待ち  勝-負-分      勝率   平均石差  着手 黒:白   全滅  時間切れ  黒の自動着手',
  )

  for (const delay of delays) {
    let win = 0
    let loss = 0
    let draw = 0
    let diffSum = 0
    let blackMoveSum = 0
    let whiteMoveSum = 0
    let wipedOut = 0
    let timeUp = 0
    let blackIdleSum = 0
    let whiteIdleSum = 0

    for (let g = 0; g < games; g += 1) {
      const { gameSeed, decisionSeed } = matchSeeds(
        seed,
        delay,
        whiteId,
        blackId,
        'white',
        g,
      )
      const result = runPacedMatch({
        seed: gameSeed,
        decisionSeed,
        black,
        white,
        blackThinkDelayMs: delay,
      })
      if (result.abnormal) throw new Error(`abnormal match delay=${delay} #${g}`)
      diffSum += result.diffForWhite
      if (result.diffForWhite > 0) win += 1
      else if (result.diffForWhite < 0) loss += 1
      else draw += 1
      blackMoveSum += result.moves.black
      whiteMoveSum += result.moves.white
      if (result.stones.white === 0) wipedOut += 1
      if (result.timeUp) timeUp += 1
      blackIdleSum += result.idleMoves.black
      whiteIdleSum += result.idleMoves.white
    }

    const interval = GAME_CONFIG.cooldownMs + delay
    console.log(
      `${String(delay).padStart(5)}ms(${String(interval).padStart(4)}間隔) ` +
        `${String(win).padStart(3)}-${String(loss).padStart(3)}-${String(draw).padStart(2)} ` +
        `${((win / games) * 100).toFixed(1).padStart(6)}% ` +
        `${(diffSum / games).toFixed(1).padStart(8)} ` +
        `${(blackMoveSum / games).toFixed(1).padStart(6)}:${(whiteMoveSum / games).toFixed(1).padStart(5)} ` +
        `${String(wipedOut).padStart(5)} ` +
        `${String(timeUp).padStart(8)} ` +
        `${(blackIdleSum / games).toFixed(1).padStart(9)}`,
    )
    if (whiteIdleSum > 0) {
      console.log(
        `  ! 白が無操作 3 秒で自動着手された: ${whiteIdleSum} 回（打てるのに打っていない）`,
      )
    }
  }
}

/** 下読み 1 ステップの実時間。着手のステップを重くしていないかの確認 */
function ponderSpeed(args: string[]): void {
  const stepNodes = Number(args[0] ?? MASTER_LEVEL.ponderStepNodes)
  const level: StrategyLevel = { ...MASTER_LEVEL, ponderStepNodes: stepNodes }
  const samples: number[] = []
  let deepest = 0

  for (let seed = 1; seed <= 20; seed += 1) {
    for (const plies of [0, 10, 20, 30, 40, 50, 60, 70, 76, 80]) {
      const board = randomPlayout(seed * 977, plies)
      if (listLegalMoves(board, 'white').length < 2) continue
      const publicState = toPublicMatchState({ ...createMatch({ seed }), board })
      const agent = createStrategyCpu({ id: 'strategy', label: 'p', level })
      // 判断待ち 500ms ぶんの 10 ステップを回す
      for (let step = 10; step >= 1; step -= 1) {
        const start = performance.now()
        agent.ponder?.(publicState, 'white', step * GAME_CONFIG.stepMs)
        samples.push(performance.now() - start)
      }
      const info = decideStrategyMove(publicState, createRng(1), 'white', level)
      if (info.depth > deepest) deepest = info.depth
    }
  }

  samples.sort((a, b) => a - b)
  const total = samples.reduce((n, s) => n + s, 0)
  console.log(`下読み ${samples.length} ステップ（上限 ${stepNodes} ノード）`)
  console.log(`平均 ${(total / samples.length).toFixed(1)}ms`)
  console.log(`p95  ${samples[Math.floor(samples.length * 0.95)].toFixed(1)}ms`)
  console.log(`最大 ${samples[samples.length - 1].toFixed(1)}ms`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'verify') verify()
else if (command === 'speed') speed(rest)
else if (command === 'match') match(rest)
else if (command === 'human') human(rest)
else if (command === 'ladder') ladder(rest)
else if (command === 'agree') agree(rest)
else if (command === 'profile') profile()
else if (command === 'ponder') ponderBench(rest)
else if (command === 'ponder-speed') ponderSpeed(rest)
else if (command === 'tune') tune(rest)
else if (command === 'pace') paceSweep(rest)
else if (command === 'wipeout') wipeoutDiag(rest)
else if (command === 'versus') versus(rest)
else {
  console.error(
    'usage: bench.ts <verify|speed|match [N] [id] [--cpu ID] [--out PATH]|' +
      'human [N] [blackId]|ladder|agree|profile|' +
      'ponder [N] [stepNodes]|ponder-speed [stepNodes]|' +
      'tune [N] [--nodes X] [--term NAME] [--base alpha|beta|gamma|delta] ' +
      '[--factors a,b] [--paced]|' +
      'pace [N] [blackId] [--white ID] [--delays a,b,c] [--seed S]|' +
      'wipeout [N] [--white ID] [--delay MS] [--depth D] [--seed S]|' +
      'versus [N] [idA] [idB] [--delay MS] [--seed S]>',
  )
  process.exit(1)
}
