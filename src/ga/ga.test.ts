import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInitialBoard, listLegalMoves, placeStone } from '../game/board.ts'
import { createMatch, createRng, toPublicMatchState } from '../game/index.ts'
import { GAME_CONFIG } from '../game/config.ts'
import {
  attachWaitFeatures,
  computeBoardFeatures,
  phaseProgress,
} from './features.ts'
import {
  clampGene,
  handcraftedIndividuals,
  interpolateWeights,
  randomGenes,
  scoreFeatures,
} from './genes.ts'
import { decideWithGenesSimple as decideWithGenes } from './geneCpu.ts'
import {
  mutateChild,
  rankByFitness,
  uniformCrossover,
} from './operators.ts'
import { createGaRng, createGaRngFromState, deriveSeed } from './rng.ts'
import { runGaMatch } from './matchRunner.ts'
import { SMOKE_GA_CONFIG, GENE_LENGTH, FEATURE_COUNT } from './constants.ts'
import { runGaTraining } from './train.ts'
import { defaultRunDir, loadCheckpoint } from './checkpoint.ts'
import { fixedReferenceGenes } from './genes.ts'
import { buildSeededPopulation } from './seedPopulation.ts'
import { buildGenerationPanel } from './panel.ts'

describe('ga features', () => {
  it('初期盤の進行度は0', () => {
    expect(phaseProgress(createInitialBoard())).toBe(0)
  })

  it('特徴量は12個で正規化範囲に収まる（初期盤・黒視点）', () => {
    const board = createInitialBoard()
    const f = computeBoardFeatures(board, 'black')
    expect(f).toHaveLength(FEATURE_COUNT)
    // 石数差0
    expect(f[0]).toBe(0)
    // 角差0
    expect(f[1]).toBe(0)
    expect(f[2]).toBeGreaterThan(0) // 自分合法手
    expect(f[3]).toBeGreaterThan(0) // 相手合法手
    expect(f[9]).toBe(0)
    expect(f[10]).toBe(0)
    expect(f[11]).toBe(0)
  })

  it('黒白入れ替えで自分/相手の意味が反転する', () => {
    let board = createInitialBoard()
    const move = listLegalMoves(board, 'black')[0]!
    const placed = placeStone(board, move.row, move.col, 'black')
    expect(placed.ok).toBe(true)
    if (!placed.ok) return
    board = placed.board
    const asBlack = computeBoardFeatures(board, 'black')
    const asWhite = computeBoardFeatures(board, 'white')
    expect(asBlack[0]).toBeCloseTo(-asWhite[0], 10)
    expect(asBlack[1]).toBeCloseTo(-asWhite[1], 10)
    expect(asBlack[2]).toBeCloseTo(asWhite[3], 10)
    expect(asBlack[3]).toBeCloseTo(asWhite[2], 10)
  })

  it('WAIT特徴はWAIT時のみ公開時間情報を付ける', () => {
    const board = createInitialBoard()
    const base = computeBoardFeatures(board, 'black')
    const wait = attachWaitFeatures(base, {
      isWait: true,
      opponentCooldownMs: 350,
      remainingMatchMs: 90_000,
    })
    expect(wait[9]).toBe(1)
    expect(wait[10]).toBeCloseTo(350 / GAME_CONFIG.cooldownMs, 10)
    expect(wait[11]).toBeCloseTo(90_000 / GAME_CONFIG.matchDurationMs, 10)
    const move = attachWaitFeatures(base, {
      isWait: false,
      opponentCooldownMs: 350,
      remainingMatchMs: 90_000,
    })
    expect(move[9]).toBe(0)
    expect(move[10]).toBe(0)
    expect(move[11]).toBe(0)
  })
})

describe('ga genes interpolate', () => {
  it('進行度0/0.5/1でearly/mid/late、中間は線形', () => {
    const genes: number[] = []
    for (let i = 0; i < FEATURE_COUNT; i += 1) genes.push(0)
    for (let i = 0; i < FEATURE_COUNT; i += 1) genes.push(1)
    for (let i = 0; i < FEATURE_COUNT; i += 1) genes.push(2)
    expect(interpolateWeights(genes, 0)[0]).toBe(0)
    expect(interpolateWeights(genes, 0.5)[0]).toBe(1)
    expect(interpolateWeights(genes, 1)[0]).toBe(2)
    expect(interpolateWeights(genes, 0.25)[0]).toBeCloseTo(0.5, 10)
    expect(interpolateWeights(genes, 0.75)[0]).toBeCloseTo(1.5, 10)
  })

  it('36遺伝子と12特徴の内積', () => {
    const genes = Array.from({ length: GENE_LENGTH }, () => 0)
    genes[0] = 2
    genes[12] = 2
    genes[24] = 2
    const feats = Array.from({ length: FEATURE_COUNT }, () => 0)
    feats[0] = 0.5
    expect(scoreFeatures(feats, interpolateWeights(genes, 0))).toBe(1)
  })
})

describe('ga geneCpu', () => {
  it('同じ遺伝子・シードで行動が再現する', () => {
    const genes = handcraftedIndividuals(0)[1]!.genes
    const match = createMatch({ seed: 1 })
    const pub = toPublicMatchState(match)
    const a = decideWithGenes(genes, pub, 'black', createRng(99))
    const b = decideWithGenes(genes, pub, 'black', createRng(99))
    expect(a).toEqual(b)
  })

  it('仮評価で公開盤面を変更しない', () => {
    const genes = handcraftedIndividuals(0)[0]!.genes
    const match = createMatch({ seed: 2 })
    const pub = toPublicMatchState(match)
    const before = JSON.stringify(pub.board)
    decideWithGenes(genes, pub, 'black', createRng(3))
    expect(JSON.stringify(pub.board)).toBe(before)
  })

  it('合法手があるときWAITも候補に入る（WAIT重みが極端ならWAIT）', () => {
    const genes = Array.from({ length: GENE_LENGTH }, () => 0)
    // 全フェーズで WAIT フラグを大きく
    for (let p = 0; p < 3; p += 1) genes[p * 12 + 9] = 10
    const match = createMatch({ seed: 3 })
    const pub = toPublicMatchState(match)
    const d = decideWithGenes(genes, pub, 'black', createRng(1))
    expect(d.type).toBe('wait')
  })
})

describe('ga match idle auto-move', () => {
  it('WAITし続ける個体も無操作3秒で着手し試合が進む', () => {
    const genes = Array.from({ length: GENE_LENGTH }, () => 0)
    for (let p = 0; p < 3; p += 1) genes[p * 12 + 9] = 10
    const spec = {
      kind: 'gene' as const,
      id: 'wait',
      genes,
      labelId: 'wait',
    }
    const r = runGaMatch({
      matchId: 'idle-wait',
      seed: 11,
      black: spec,
      white: { ...spec, id: 'wait-w', labelId: 'wait-w' },
      decisionSeed: 3,
    })
    expect(r.abnormal).toBe(false)
    expect(r.moveHash).not.toBe('e3b0c44298fc1c14')
    expect(r.elapsedMs).toBeGreaterThanOrEqual(GAME_CONFIG.idleAutoMoveMs)
  })
})

describe('ga operators', () => {
  it('交叉・変異で親の遺伝子を書き換えない', () => {
    const rng = createGaRng(7)
    const parents = handcraftedIndividuals(0)
    const a = parents[0]!
    const b = parents[1]!
    const aBefore = a.genes.slice()
    const bBefore = b.genes.slice()
    const child = mutateChild(
      uniformCrossover(a, b, rng, 'c1', 1),
      rng,
      0.2,
      0.15,
    )
    expect(a.genes).toEqual(aBefore)
    expect(b.genes).toEqual(bBefore)
    expect(child.genes).toHaveLength(GENE_LENGTH)
    expect(child.genes.every((g) => g >= -3 && g <= 3)).toBe(true)
  })

  it('変異0件でも少なくとも1遺伝子が変わるよう強制される', () => {
    const rng = createGaRng(11)
    const genes = randomGenes(rng)
    const child = {
      id: 'x',
      generation: 1,
      parentIds: [],
      genes,
      geneFormatVersion: '1.0.0',
      origin: 'offspring' as const,
    }
    // geneProb=0 → 強制1個
    const mutated = mutateChild(child, createGaRng(12), 0.5, 0)
    expect(mutated.genes).not.toEqual(genes)
  })

  it('エリート遺伝子はコピーで次世代へ残せる', () => {
    const elite = handcraftedIndividuals(0)[2]!
    const copy = elite.genes.slice()
    expect(copy).toEqual(elite.genes)
    copy[0] = clampGene(copy[0]! + 1)
    expect(elite.genes[0]).not.toBe(copy[0])
  })

  it('同点順位はシード付きで再現する', () => {
    const pop = handcraftedIndividuals(0).map((ind) => ({
      ...ind,
      fitness: {
        primaryScore: 1,
        primaryGames: 2,
        extraScore: 0,
        extraGames: 0,
        scoreRate: 0.5,
        wins: 1,
        draws: 0,
        losses: 1,
        totalStoneDiff: 0,
        byOpponent: {},
      },
    }))
    const r1 = rankByFitness(pop, createGaRng(100)).map((i) => i.id)
    const r2 = rankByFitness(pop, createGaRng(100)).map((i) => i.id)
    expect(r1).toEqual(r2)
  })
})

describe('ga match + train', () => {
  it('双方700ms/500msで試合が終了し再現する', () => {
    const genes = fixedReferenceGenes().cornerPos
    const spec = {
      kind: 'gene' as const,
      id: 'a',
      genes,
      labelId: 'a',
    }
    const r1 = runGaMatch({
      matchId: 'm1',
      seed: 42,
      black: spec,
      white: { ...spec, id: 'b', labelId: 'b' },
      decisionSeed: 99,
    })
    const r2 = runGaMatch({
      matchId: 'm1',
      seed: 42,
      black: spec,
      white: { ...spec, id: 'b', labelId: 'b' },
      decisionSeed: 99,
    })
    expect(r1.abnormal).toBe(false)
    expect(r1.outcome).toEqual(r2.outcome)
    expect(r1.moveHash).toEqual(r2.moveHash)
    expect(r1.elapsedMs).toBeLessThanOrEqual(GAME_CONFIG.matchDurationMs)
  })

  it('世代交代後も人口が一致し、中断再開が一致する', () => {
    const seed = deriveSeed(12345, 1)
    const runA = `ga-test-full-${seed}-${process.pid}`
    const runB = `ga-test-resume-${seed}-${process.pid}`
    const baseCwd = process.cwd()
    rmSync(defaultRunDir(baseCwd, runA), { recursive: true, force: true, maxRetries: 10 })
    rmSync(defaultRunDir(baseCwd, runB), { recursive: true, force: true, maxRetries: 10 })

    const cfg = {
      ...SMOKE_GA_CONFIG,
      populationSize: 6,
      parentPool: 3,
      elites: 2,
      offspring: 3,
      immigrants: 1,
      generations: 1,
      matchSafetyCap: 5000,
    }

    const full = runGaTraining({
      runId: runA,
      masterSeed: seed,
      config: cfg,
      cwd: baseCwd,
    })
    expect(full.population).toHaveLength(cfg.populationSize)

    const partial = runGaTraining({
      runId: runB,
      masterSeed: seed,
      config: cfg,
      cwd: baseCwd,
      maxMatches: 20,
    })
    expect(partial.stoppedReason).toBe('match_cap')
    runGaTraining({
      runId: runB,
      masterSeed: seed,
      config: cfg,
      cwd: baseCwd,
      resumePath: join(defaultRunDir(baseCwd, runB), 'checkpoint-latest.json'),
    })

    const fullCk = loadCheckpoint(
      join(defaultRunDir(baseCwd, runA), 'checkpoint-latest.json'),
    )
    const resumeCk = loadCheckpoint(
      join(defaultRunDir(baseCwd, runB), 'checkpoint-latest.json'),
    )
    expect(resumeCk.completedMatches).toBe(fullCk.completedMatches)
    expect(resumeCk.lastRankedSnapshot.map((x) => x.scoreRate)).toEqual(
      fullCk.lastRankedSnapshot.map((x) => x.scoreRate),
    )
    expect(resumeCk.population.map((p) => p.genes)).toEqual(
      fullCk.population.map((p) => p.genes),
    )

    const hofDir = join(defaultRunDir(baseCwd, runA), 'hall_of_fame')
    const files = readdirSync(hofDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    const loaded = JSON.parse(
      readFileSync(join(hofDir, files[0]!), 'utf8'),
    ) as { genes: number[]; id: string }
    const m = runGaMatch({
      matchId: 'reload',
      seed: 1,
      black: {
        kind: 'gene',
        id: loaded.id,
        genes: loaded.genes,
        labelId: loaded.id,
      },
      white: {
        kind: 'builtin',
        id: 'random',
        labelId: 'random',
      },
      decisionSeed: 2,
    })
    expect(m.abnormal).toBe(false)

    const path = join(hofDir, files[0]!)
    const before = readFileSync(path, 'utf8')
    writeFileSync(path + '.bak', before)
    expect(readFileSync(path, 'utf8')).toBe(before)

    rmSync(defaultRunDir(baseCwd, runA), { recursive: true, force: true, maxRetries: 10 })
    rmSync(defaultRunDir(baseCwd, runB), { recursive: true, force: true, maxRetries: 10 })
  }, 300_000)

  it('完了済みランを世代上限を上げて再開すると次世代に進む', () => {
    const seed = deriveSeed(777, 3)
    const runId = `ga-test-extend-${seed}`
    const cwd = process.cwd()
    rmSync(defaultRunDir(cwd, runId), { recursive: true, force: true, maxRetries: 10 })
    const cfg = {
      ...SMOKE_GA_CONFIG,
      populationSize: 6,
      parentPool: 3,
      elites: 2,
      offspring: 3,
      immigrants: 1,
      generations: 1,
      matchSafetyCap: 5000,
    }
    const first = runGaTraining({
      runId,
      masterSeed: seed,
      config: cfg,
      cwd,
    })
    expect(first.phase).toBe('done')
    expect(first.generation).toBe(0)
    const resumed = runGaTraining({
      runId,
      masterSeed: seed,
      config: cfg,
      cwd,
      resumePath: join(defaultRunDir(cwd, runId), 'checkpoint-latest.json'),
      configOverride: { generations: 2 },
    })
    expect(resumed.generation).toBe(1)
    expect(resumed.phase).toBe('done')
    expect(resumed.completedMatches).toBeGreaterThan(first.completedMatches)
    rmSync(defaultRunDir(cwd, runId), { recursive: true, force: true, maxRetries: 10 })
  }, 300_000)
})

describe('ga rng restore', () => {
  it('状態復元後の乱数列が続く', () => {
    const a = createGaRng(42)
    const seq1 = [a.next(), a.next(), a.nextGaussian()]
    const b = createGaRngFromState(a.getState())
    const c = createGaRng(42)
    c.next()
    c.next()
    c.nextGaussian()
    expect(b.next()).toBe(c.next())
    void seq1
  })
})

describe('ga continue seed', () => {
  it('種個体の遺伝子が初期集団に残り、変異個体も含まれる', () => {
    const rng = createGaRng(99)
    const seed = handcraftedIndividuals(20)[1]!
    const pop = buildSeededPopulation(
      {
        ...SMOKE_GA_CONFIG,
        populationSize: 16,
        immigrants: 2,
      },
      rng,
      [seed],
      21,
    )
    expect(pop).toHaveLength(16)
    expect(pop.some((p) => p.genes.every((g, i) => g === seed.genes[i]))).toBe(
      true,
    )
    expect(pop.some((p) => p.origin === 'offspring')).toBe(true)
    expect(pop.every((p) => p.generation === 21)).toBe(true)
  })

  it('ピン留め相手がパネルに入りサイズ12を超えない', () => {
    const rng = createGaRng(3)
    const pinned = {
      id: 'champ',
      generation: 20,
      genes: fixedReferenceGenes().cornerPos.slice(),
      geneFormatVersion: '1.0.0',
      scoreRate: 1,
      savedAt: 't',
    }
    const built = buildGenerationPanel({
      rankedPrev: null,
      archive: [],
      seedRefs: [],
      rng,
      pastTop: 2,
      pastOther: 2,
      archiveCount: 3,
      pinned: [pinned],
    })
    expect(built.panel.some((p) => p.panelId === 'pinned-champ')).toBe(true)
    expect(built.panel.length).toBeLessThanOrEqual(12)
  })

  it('続き育成の初期チェックポイントは開始世代と種を持つ', () => {
    const seed = deriveSeed(4242, 2)
    const runId = `ga-test-continue-${seed}`
    const cwd = process.cwd()
    rmSync(defaultRunDir(cwd, runId), { recursive: true, force: true, maxRetries: 10 })
    const champion = handcraftedIndividuals(20)[1]!
    const cfg = {
      ...SMOKE_GA_CONFIG,
      populationSize: 6,
      parentPool: 3,
      elites: 2,
      offspring: 3,
      immigrants: 1,
      generations: 31,
      matchSafetyCap: 0,
    }
    const out = runGaTraining({
      runId,
      masterSeed: seed,
      config: cfg,
      cwd,
      maxMatches: 0,
      seedIndividuals: [champion],
      startGeneration: 21,
      pinnedArchive: [
        {
          id: champion.id,
          generation: 20,
          genes: champion.genes.slice(),
          geneFormatVersion: champion.geneFormatVersion,
          scoreRate: 0,
          savedAt: 't',
        },
      ],
    })
    expect(out.generation).toBe(21)
    expect(out.population).toHaveLength(6)
    expect(
      out.population.some((p) =>
        p.genes.every((g, i) => g === champion.genes[i]),
      ),
    ).toBe(true)
    expect(out.pinnedArchive?.[0]?.id).toBe(champion.id)
    rmSync(defaultRunDir(cwd, runId), { recursive: true, force: true, maxRetries: 10 })
  })
})
