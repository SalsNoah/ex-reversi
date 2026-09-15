/** GA-1 仕様バージョン（docs/ga-design.md と同期） */
export const GA_SPEC_VERSION = '1.0.0'
export const GENE_FORMAT_VERSION = '1.0.0'
export const FEATURE_COUNT = 12
export const PHASE_COUNT = 3
export const GENE_LENGTH = FEATURE_COUNT * PHASE_COUNT // 36

export const GENE_INIT_MIN = -1
export const GENE_INIT_MAX = 1
export const GENE_CLAMP_MIN = -3
export const GENE_CLAMP_MAX = 3

export const DEFAULT_GA_CONFIG = {
  populationSize: 64,
  parentPool: 16,
  elites: 8,
  offspring: 48,
  immigrants: 8,
  generations: 50,
  tournamentSize: 3,
  crossoverUniformProb: 0.5,
  mutationGeneProb: 0.15,
  mutationSigma: 0.2,
  panelPastTop: 2,
  panelPastOther: 2,
  panelArchive: 4,
  panelFixed: 4,
  /** 一次評価: 各相手×黒白あたりの試合数 */
  primaryGamesPerOpponentSide: 1,
  /** 追加評価（上位）: 各相手×黒白あたりの試合数 */
  extraGamesPerOpponentSide: 1,
  matchSafetyCap: 120_000,
} as const

export const SMOKE_GA_CONFIG = {
  populationSize: 16,
  parentPool: 4,
  elites: 2,
  offspring: 12,
  immigrants: 2,
  generations: 3,
  tournamentSize: 3,
  crossoverUniformProb: 0.5,
  mutationGeneProb: 0.15,
  mutationSigma: 0.2,
  panelPastTop: 1,
  panelPastOther: 1,
  panelArchive: 2,
  panelFixed: 4,
  primaryGamesPerOpponentSide: 1,
  extraGamesPerOpponentSide: 1,
  matchSafetyCap: 5_000,
} as const

export type GaRunConfig = {
  populationSize: number
  parentPool: number
  elites: number
  offspring: number
  immigrants: number
  generations: number
  tournamentSize: number
  crossoverUniformProb: number
  mutationGeneProb: number
  mutationSigma: number
  panelPastTop: number
  panelPastOther: number
  panelArchive: number
  panelFixed: number
  primaryGamesPerOpponentSide: number
  extraGamesPerOpponentSide: number
  matchSafetyCap: number
}
