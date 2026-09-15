function formatGenes(genes: readonly number[]): string {
  const parts: string[] = []
  for (let i = 0; i < genes.length; i += 3) {
    const row = genes
      .slice(i, i + 3)
      .map((g) => String(g))
      .join(', ')
    parts.push(`      ${row},`)
  }
  return parts.join('\n')
}

export type MilestoneRecord = {
  id: string
  generation: number
  sourceId: string
  runId: string
  geneFormatVersion: string
  selectionScoreRate: number
  fixedEvalScoreRate: number
  holdoutEvalScoreRate: number
  vsChampionScoreRate: number | null
  genes: readonly number[]
}

export function renderGaMilestonesSource(
  milestones: readonly MilestoneRecord[],
): string {
  const body = milestones
    .map((m) => {
      const vs =
        m.vsChampionScoreRate === null ? 'null' : String(m.vsChampionScoreRate)
      return `  {
    id: '${m.id}',
    generation: ${m.generation},
    sourceId: '${m.sourceId}',
    runId: '${m.runId}',
    geneFormatVersion: '${m.geneFormatVersion}',
    selectionScoreRate: ${m.selectionScoreRate},
    fixedEvalScoreRate: ${m.fixedEvalScoreRate},
    holdoutEvalScoreRate: ${m.holdoutEvalScoreRate},
    vsChampionScoreRate: ${vs},
    genes: [
${formatGenes(m.genes)}
    ],
  }`
    })
    .join(',\n')

  return `/**
 * 世代マイルストーン（15世代から5世代ごと）。
 * ブラウザは学習成果物ディレクトリに実行時依存しない。
 */
export type GaMilestoneId = \`ga_g\${number}\`

export type GaMilestone = {
  id: GaMilestoneId
  generation: number
  sourceId: string
  runId: string
  geneFormatVersion: string
  selectionScoreRate: number
  fixedEvalScoreRate: number
  holdoutEvalScoreRate: number
  vsChampionScoreRate: number | null
  genes: readonly number[]
}

export const GA_MILESTONES: readonly GaMilestone[] = [
${body},
]

export function strongestMilestone(): GaMilestone {
  if (GA_MILESTONES.length === 0) {
    throw new Error('GA_MILESTONES is empty')
  }
  return [...GA_MILESTONES].sort((a, b) => {
    const as =
      (a.vsChampionScoreRate ?? 0.5) * 1000 +
      a.holdoutEvalScoreRate * 10 +
      a.fixedEvalScoreRate +
      a.generation * 0.001
    const bs =
      (b.vsChampionScoreRate ?? 0.5) * 1000 +
      b.holdoutEvalScoreRate * 10 +
      b.fixedEvalScoreRate +
      b.generation * 0.001
    return bs - as
  })[0]!
}
`
}
