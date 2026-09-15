/**
 * GA-1 採用候補の互換エクスポート。
 * 現行の最強マイルストーンは `gaMilestones.ts` を正とする。
 */
import { strongestMilestone } from './gaMilestones.ts'

const strongest = strongestMilestone()

export const GA_BEST_META = {
  sourceId: strongest.sourceId,
  runId: strongest.runId,
  generation: strongest.generation,
  geneFormatVersion: strongest.geneFormatVersion,
  selectionScoreRate: strongest.selectionScoreRate,
  fixedEvalScoreRate: strongest.fixedEvalScoreRate,
  holdoutEvalScoreRate: strongest.holdoutEvalScoreRate,
} as const

export const GA_BEST_GENES: readonly number[] = strongest.genes
