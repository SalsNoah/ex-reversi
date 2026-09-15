import { fixedReferenceGenes, type Individual } from './genes.ts'
import type { OpponentSpec } from './matchRunner.ts'
import type { GaRng } from './rng.ts'

export type PanelEntry = {
  panelId: string
  spec: OpponentSpec
  source: string
}

export type ArchiveEntry = {
  id: string
  generation: number
  genes: number[]
  geneFormatVersion: string
  scoreRate: number
  savedAt: string
}

/** 固定比較用4体 */
export function fixedPanelEntries(): PanelEntry[] {
  const refs = fixedReferenceGenes()
  return [
    {
      panelId: 'fixed-random',
      spec: { kind: 'builtin', id: 'random' },
      source: 'builtin_random',
    },
    {
      panelId: 'fixed-max_flip',
      spec: { kind: 'builtin', id: 'max_flip' },
      source: 'builtin_max_flip',
    },
    {
      panelId: 'fixed-corner',
      spec: { kind: 'gene', id: 'fixed-corner', genes: refs.cornerPos },
      source: 'fixed_corner_pos',
    },
    {
      panelId: 'fixed-mobility',
      spec: { kind: 'gene', id: 'fixed-mobility', genes: refs.mobility },
      source: 'fixed_mobility',
    },
  ]
}

/**
 * 世代開始前に対戦パネル12体を確定する。
 * 評価途中では変更しない。
 */
export function buildGenerationPanel(options: {
  rankedPrev: Individual[] | null
  archive: ArchiveEntry[]
  seedRefs: ArchiveEntry[]
  rng: GaRng
  pastTop: number
  pastOther: number
  archiveCount: number
  pinned?: ArchiveEntry[]
}): { panel: PanelEntry[]; notes: string[] } {
  const notes: string[] = []
  const panel: PanelEntry[] = []
  const used = new Set<string>()

  const add = (entry: PanelEntry) => {
    if (used.has(entry.panelId)) return false
    used.add(entry.panelId)
    panel.push(entry)
    return true
  }

  // 前世代から
  if (options.rankedPrev && options.rankedPrev.length > 0) {
    for (let i = 0; i < options.pastTop && i < options.rankedPrev.length; i += 1) {
      const ind = options.rankedPrev[i]!
      add({
        panelId: `prev-${ind.id}`,
        spec: { kind: 'gene', id: ind.id, genes: ind.genes.slice() },
        source: `prev_top_${i}`,
      })
    }
    const rest = options.rankedPrev.slice(options.pastTop)
    for (let k = 0; k < options.pastOther && rest.length > 0; k += 1) {
      const pick = rest[options.rng.nextInt(0, rest.length)]!
      add({
        panelId: `prev-other-${pick.id}`,
        spec: { kind: 'gene', id: pick.id, genes: pick.genes.slice() },
        source: 'prev_other',
      })
    }
  } else {
    notes.push('no_prev_generation_use_seed_refs')
  }

  // 現行アプリ代表など、世代を通して残す相手
  if (options.pinned && options.pinned.length > 0) {
    for (const p of options.pinned) {
      add({
        panelId: `pinned-${p.id}`,
        spec: { kind: 'gene', id: p.id, genes: p.genes.slice() },
        source: `pinned_g${p.generation}`,
      })
    }
    notes.push(`pinned=${options.pinned.length}`)
  }

  // アーカイブから（新しい世代に偏らず）
  if (options.archive.length > 0) {
    const byGen = new Map<number, ArchiveEntry[]>()
    for (const a of options.archive) {
      const list = byGen.get(a.generation) ?? []
      list.push(a)
      byGen.set(a.generation, list)
    }
    const gens = [...byGen.keys()].sort((a, b) => a - b)
    let added = 0
    // 古い世代から交互に拾う
    let gi = 0
    while (added < options.archiveCount && gens.length > 0) {
      const g = gens[gi % gens.length]!
      const list = byGen.get(g)!
      if (list.length === 0) {
        gens.splice(gi % gens.length, 1)
        continue
      }
      const pick = list[options.rng.nextInt(0, list.length)]!
      if (
        add({
          panelId: `arch-${pick.id}`,
          spec: { kind: 'gene', id: pick.id, genes: pick.genes.slice() },
          source: `archive_g${pick.generation}`,
        })
      ) {
        added += 1
      }
      // 同じ個体の再抽選を減らす
      const idx = list.findIndex((x) => x.id === pick.id)
      if (idx >= 0) list.splice(idx, 1)
      gi += 1
    }
  }

  // 不足は初期参照で補完
  for (const ref of options.seedRefs) {
    if (panel.length >= 8) break
    add({
      panelId: `seedref-${ref.id}`,
      spec: { kind: 'gene', id: ref.id, genes: ref.genes.slice() },
      source: 'seed_reference',
    })
  }

  // 固定4
  for (const f of fixedPanelEntries()) add(f)

  // まだ12未満なら固定の複製ではなく seed refs / archive を追加
  let filler = 0
  while (panel.length < 12 && options.seedRefs.length > 0 && filler < 20) {
    const ref = options.seedRefs[filler % options.seedRefs.length]!
    add({
      panelId: `fill-${ref.id}-${filler}`,
      spec: { kind: 'gene', id: `${ref.id}-fill${filler}`, genes: ref.genes.slice() },
      source: 'fill_seed_ref',
    })
    filler += 1
  }

  notes.push(`panel_size=${panel.length}`)
  return { panel, notes }
}

/** 育成選抜に使わない固定検証相手 */
export function validationOpponents(extra: PanelEntry[] = []): PanelEntry[] {
  const refs = fixedReferenceGenes()
  const base: PanelEntry[] = [
    ...fixedPanelEntries(),
    {
      panelId: 'holdout-stone',
      spec: {
        kind: 'gene',
        id: 'holdout-stone',
        genes: (() => {
          const g = refs.cornerPos.slice()
          // 石数寄りに少し変えた固定個体（パネル固定4とは別）
          for (let i = 0; i < 12; i += 1) g[i] = i === 0 ? 1 : 0.05
          for (let i = 12; i < 24; i += 1) g[i] = i % 12 === 0 ? 1 : 0.05
          for (let i = 24; i < 36; i += 1) g[i] = i % 12 === 0 ? 1 : 0.05
          return g
        })(),
      },
      source: 'validation_holdout',
    },
  ]
  const used = new Set(base.map((p) => p.panelId))
  for (const e of extra) {
    if (used.has(e.panelId)) continue
    used.add(e.panelId)
    base.push(e)
  }
  return base
}
