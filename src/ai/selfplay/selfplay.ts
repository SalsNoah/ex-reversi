/**
 * 自己対戦によるデータ生成。
 *
 * - Champion（現時点で最強のエンジン）同士を基本にする
 * - 過学習対策として、一定割合で「過去世代」「探索量を落とした版」「ランダム」と当てる
 * - 序盤は訪問数の抽選（温度）と root の Dirichlet ノイズで手を散らす
 * - 各意思決定点の探索分布・推定値・時間状態を棋譜に残す（時間状態はシードから再現）
 *
 * 実時計・UI・ファイル I/O には依存しない（書き出しは呼び出し側）。
 */
import { createRng, type Rng } from '../../game/rng.ts'
import { deriveSeed } from '../../ga/rng.ts'
import { buildEngine, type Engine, type EngineSpec } from '../engine/engine.ts'
import { randomAgent } from '../agents/baselines.ts'
import { GAME_CONFIG } from '../../game/config.ts'
import {
  SIDE_BLACK,
  SIDE_WHITE,
  createFastMatch,
  runFastMatch,
  type FastAgent,
  type FastMatchConfig,
} from '../sim/fastMatch.ts'
import type { SelfPlayRecord, SelfPlaySample } from './record.ts'

export type OpponentEntry = {
  spec: EngineSpec
  /** 抽選の重み */
  weight: number
}

export type SelfPlayOptions = {
  /** 主役。両側の既定 */
  champion: EngineSpec
  /** 相手として混ぜるもの（省略時は Champion 同士のみ） */
  opponents?: OpponentEntry[]
  /** 相手を Champion 以外にする確率 */
  mixRate?: number
  games: number
  masterSeed: number
  /** 抽選で手を選ぶ意思決定点の数（序盤の多様性） */
  temperatureMoves?: number
  temperature?: number
  /** 試合ごとに判断待ちを振る（本番は片側 0ms の可能性があるため） */
  varyThinkDelay?: boolean
  onGame?: (record: SelfPlayRecord, index: number) => void
}

export type SelfPlayStats = {
  games: number
  samples: number
  moves: number
  blackWins: number
  whiteWins: number
  draws: number
  wallMs: number
}

/** 探索側の直前の root 情報 */
type Pending = {
  used: boolean
  actions: Int32Array
  visits: Int32Array
  count: number
  value: number
  sims: number
  depth: number
  nodes: number
}

function createPending(): Pending {
  return {
    used: false,
    actions: new Int32Array(101),
    visits: new Int32Array(101),
    count: 0,
    value: 0,
    sims: 0,
    depth: 0,
    nodes: 0,
  }
}

/**
 * 記録つきエンジン。decide のたびに root の訪問分布を控える。
 * MCTS の節点配列は重いので試合をまたいで使い回す。
 */
function recordingAgent(
  spec: EngineSpec,
  pending: Pending,
  control: { decisions: number; temperatureMoves: number; temperature: number },
): FastAgent {
  const holder = { rng: null as Rng | null }
  const proxy: Rng = {
    next: () => holder.rng!.next(),
    nextInt: (min, max) => holder.rng!.nextInt(min, max),
  }
  let engine: Engine | null = null

  return {
    id: spec.id,
    onMatchStart() {
      engine?.evaluator?.reset()
    },
    decide(match, side, rng) {
      holder.rng = rng
      if (!engine) engine = buildEngine(spec, proxy)
      const mcts = engine.mcts
      mcts.setTemperature(
        control.decisions < control.temperatureMoves ? control.temperature : 0,
      )
      const action = mcts.search(match, side, rng)

      pending.used = true
      pending.count = mcts.rootActionCount
      pending.actions.set(mcts.rootActions.subarray(0, pending.count))
      pending.visits.set(mcts.rootVisits.subarray(0, pending.count))
      pending.value = mcts.lastStats.rootValue
      pending.sims = mcts.lastStats.simulations
      pending.depth = mcts.lastStats.maxDepthReached
      pending.nodes = mcts.lastStats.nodes
      return action
    },
  }
}

/** ランダム相手は MCTS を持たないので、別枠で包む */
function plainAgent(spec: EngineSpec, pending: Pending): FastAgent {
  return {
    id: spec.id,
    decide(match, side, rng) {
      pending.used = false
      return randomAgent.decide(match, side, rng)
    },
  }
}

export const RANDOM_ENGINE_ID = 'random'

function pickOpponent(
  options: SelfPlayOptions,
  rng: Rng,
): EngineSpec {
  const list = options.opponents
  if (!list || list.length === 0) return options.champion
  if (rng.next() >= (options.mixRate ?? 0)) return options.champion
  let total = 0
  for (const e of list) total += e.weight
  if (total <= 0) return options.champion
  let r = rng.next() * total
  for (const e of list) {
    r -= e.weight
    if (r <= 0) return e.spec
  }
  return list[list.length - 1]!.spec
}

/** 判断待ちの振り方。本番は人間側 0ms なので、そのぶんも学習させる */
function pickThinkDelay(rng: Rng, vary: boolean): [number, number] {
  const base = GAME_CONFIG.cpuThinkDelayMs
  if (!vary) return [base, base]
  const r = rng.next()
  if (r < 0.7) return [base, base]
  if (r < 0.85) return [base, 0]
  return [0, base]
}

export function runSelfPlay(options: SelfPlayOptions): SelfPlayStats {
  const wallStart = performance.now()
  const match = createFastMatch({ seed: 1 })
  const pending: [Pending, Pending] = [createPending(), createPending()]
  const control = {
    decisions: 0,
    temperatureMoves: options.temperatureMoves ?? 20,
    temperature: options.temperature ?? 1,
  }

  // エンジンごとにエージェントを作り置き（節点配列の再確保を避ける）
  const agentCache = new Map<string, [FastAgent, FastAgent]>()
  const agentFor = (spec: EngineSpec, side: number): FastAgent => {
    let pair = agentCache.get(spec.id)
    if (!pair) {
      const make = (s: number): FastAgent =>
        spec.id === RANDOM_ENGINE_ID
          ? plainAgent(spec, pending[s]!)
          : recordingAgent(spec, pending[s]!, control)
      pair = [make(SIDE_BLACK), make(SIDE_WHITE)]
      agentCache.set(spec.id, pair)
    }
    return pair[side]!
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

  for (let g = 0; g < options.games; g += 1) {
    const gameSeed = deriveSeed(options.masterSeed, g, 0x5e1f)
    const decisionSeed = deriveSeed(gameSeed, 0x33)
    const setupRng = createRng(deriveSeed(gameSeed, 0x77))

    const opponent = pickOpponent(options, setupRng)
    const championIsBlack = setupRng.next() < 0.5
    const blackSpec = championIsBlack ? options.champion : opponent
    const whiteSpec = championIsBlack ? opponent : options.champion
    const think = pickThinkDelay(setupRng, options.varyThinkDelay ?? false)
    const config: Partial<FastMatchConfig> = { thinkDelayMs: think }

    const steps: Array<[number, number]> = []
    const samples: SelfPlaySample[] = []
    control.decisions = 0
    pending[SIDE_BLACK]!.used = false
    pending[SIDE_WHITE]!.used = false

    const result = runFastMatch({
      seed: gameSeed,
      decisionSeed,
      black: agentFor(blackSpec, SIDE_BLACK),
      white: agentFor(whiteSpec, SIDE_WHITE),
      config,
      match,
      hooks: {
        onStep(_match, actionBlack, actionWhite) {
          const index = steps.length
          steps.push([actionBlack, actionWhite])
          for (const side of [SIDE_BLACK, SIDE_WHITE]) {
            const p = pending[side]!
            if (!p.used) continue
            p.used = false
            if (p.count === 0) continue
            const chosen = side === SIDE_BLACK ? actionBlack : actionWhite
            // 探索の結論が無操作強制で差し替わった場合に印を付ける
            const searched = containsAction(p, chosen)
            samples.push({
              i: index,
              s: side,
              a: [...p.actions.subarray(0, p.count)],
              n: [...p.visits.subarray(0, p.count)],
              v: round3(p.value),
              sims: p.sims,
              d: p.depth,
              k: p.nodes,
              ...(searched ? {} : { f: 1 as const }),
            })
          }
          control.decisions += 1
        },
      },
    })

    // 意思決定点で decide が呼ばれない側があるので、取り残しを消す
    pending[SIDE_BLACK]!.used = false
    pending[SIDE_WHITE]!.used = false

    const record: SelfPlayRecord = {
      v: 1,
      seed: gameSeed,
      decisionSeed,
      think,
      eng: [blackSpec.id, whiteSpec.id],
      steps,
      samples,
      outcome: result.outcome,
      endReason: result.endReason,
      black: result.black,
      white: result.white,
      elapsedMs: result.elapsedMs,
      moves: result.moveCount,
    }

    stats.games += 1
    stats.samples += samples.length
    stats.moves += result.moveCount
    if (result.outcome === 0) stats.blackWins += 1
    else if (result.outcome === 1) stats.whiteWins += 1
    else stats.draws += 1

    options.onGame?.(record, g)
  }

  stats.wallMs = performance.now() - wallStart
  return stats
}

function containsAction(p: Pending, action: number): boolean {
  for (let k = 0; k < p.count; k += 1) {
    if (p.actions[k] === action) return true
  }
  return false
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** 自己対戦向けの探索設定（ノイズと抽選を入れる） */
export function selfPlayEngineSpec(base: EngineSpec, simulations: number): EngineSpec {
  return {
    ...base,
    mcts: {
      ...base.mcts,
      simulations,
      dirichletAlpha: 0.6,
      dirichletWeight: 0.25,
    },
  }
}
