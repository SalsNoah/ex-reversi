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
} from './fastBoard.ts'
import {
  MASTER_LEVEL,
  createStrategyCpu,
  decideStrategyMove,
  type StrategyLevel,
} from './strategyCpu.ts'
import { ALPHA_LEVEL, ALPHA_WEIGHT_SPEC, createAlphaCpu } from './alphaCpu.ts'
import { BETA_LEVEL, createBetaCpu } from './betaCpu.ts'
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
  // 全滅の余裕を見る項の重み。0 で切って所要を比べられるようにしてある
  const wipeout = takeArg(argv, '--wipeout')
  const budget = Number(argv[0] ?? MASTER_LEVEL.nodeBudget)
  const level = {
    ...MASTER_LEVEL,
    nodeBudget: budget,
    weights:
      wipeout === undefined
        ? MASTER_LEVEL.weights
        : buildWeightTables({
            ...DEFAULT_WEIGHT_SPEC,
            wipeout: Number(wipeout),
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
  // 相手の着手間隔の想定を変えて測るためのつまみ（既定は MASTER_LEVEL のまま）
  const oppInterval = takeArg(argv, '--opp-interval')
  const oppReaction = takeArg(argv, '--opp-reaction')
  // 全滅回避の境目・全滅の余裕の重みを変えて測るためのつまみ
  const floor = takeArg(argv, '--survival-floor')
  const survival = takeArg(argv, '--survival')
  const wipeout = takeArg(argv, '--wipeout')
  // 指定したときは実測追従を切り、その想定だけで読ませる
  const levelOverride =
    oppInterval || oppReaction || floor || survival || wipeout
      ? {
          ...(oppInterval || oppReaction ? { adaptPace: false } : {}),
          ...(oppInterval ? { opponentIntervalMs: Number(oppInterval) } : {}),
          ...(oppReaction ? { opponentReactionMs: Number(oppReaction) } : {}),
          ...(floor || survival || wipeout
            ? {
                weights: buildWeightTables({
                  ...ALPHA_WEIGHT_SPEC,
                  ...(floor ? { survivalFloor: Number(floor) } : {}),
                  ...(survival ? { survival: Number(survival) } : {}),
                  ...(wipeout ? { wipeout: Number(wipeout) } : {}),
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
      const result = runGaMatch({
        matchId: `bench-${milestone.id}-g${g}`,
        seed: gameSeed,
        black: strategyIsBlack ? strategySpec(levelOverride) : geneSpec,
        white: strategyIsBlack ? geneSpec : strategySpec(levelOverride),
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
 * 評価の重みを 1 項ずつ増減して、既定と当てる。
 *
 * 探索は飽和していて読みを増やしても勝率が動かないので、
 * 強くするなら評価側を直すしかない。まずどの項がずれているかを見る。
 * 探索量を下げても強さがほぼ変わらないことを確かめたうえで、
 * 試合数を稼ぐために軽い設定で回す。
 */
function tune(args: string[]): void {
  const argv = [...args]
  const nodes = Number(takeArg(argv, '--nodes') ?? 3_500)
  const seed = Number(takeArg(argv, '--seed') ?? 555_001)
  const only = takeArg(argv, '--term')
  const games = Number(argv[0] ?? 60)
  const factors = (takeArg(argv, '--factors') ?? '0.5,2')
    .split(',')
    .map(Number)

  const base: StrategyLevel = {
    ...MASTER_LEVEL,
    nodeBudget: nodes,
    ponderStepNodes: 0,
    adaptPace: false,
  }
  const terms = only
    ? TUNABLE_TERMS.filter((t) => t === only)
    : TUNABLE_TERMS

  console.log(`重み 1 項ずつ ${games}戦・黒白交互・探索 ${nodes} ノード`)
  console.log('項目        倍率  勝-負-分     平均石差')
  for (const term of terms) {
    for (const factor of factors) {
      const spec = scaleTerm(DEFAULT_WEIGHT_SPEC, term, factor)
      const candidate: StrategyLevel = {
        ...base,
        weights: buildWeightTables(spec),
      }
      const r = duel(
        `${term}x${factor}`,
        candidate,
        'default',
        base,
        games,
        seed,
      )
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

  console.log(
    `${agentA.label} vs ${agentB.label} / ${games}戦・黒白交互 / ` +
      `双方の判断待ち ${delay}ms / seed ${seed}`,
  )
  console.log(
    `${win}勝 ${loss}敗 ${draw}分（${((win / games) * 100).toFixed(1)}%） ` +
      `平均石差 ${(diffSum / games).toFixed(1)} / 全滅 ${wipedA}:${wipedB}`,
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
else if (command === 'versus') versus(rest)
else {
  console.error(
    'usage: bench.ts <verify|speed|match [N] [id] [--out PATH]|' +
      'human [N] [blackId]|ladder|agree|profile|' +
      'ponder [N] [stepNodes]|ponder-speed [stepNodes]|' +
      'tune [N] [--nodes X] [--term NAME]|' +
      'pace [N] [blackId] [--white ID] [--delays a,b,c] [--seed S]|' +
      'versus [N] [idA] [idB] [--delay MS] [--seed S]>',
  )
  process.exit(1)
}
