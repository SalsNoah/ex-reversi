/**
 * 強さ評価の統計。
 *
 * 「Loss が下がった」は強さの指標にしない。勝率と、その差が偶然かどうかだけを見る。
 *
 * - Wilson 信頼区間: 得点率の区間推定（少数試合で正規近似より素直）
 * - 二項検定: 引き分けを除いた勝敗数が偏りかどうか（符号検定）
 * - GSPRT: 採用/棄却を早期に決める逐次検定（Champion 選抜に使う）
 * - Bradley–Terry: 総当たり結果から Elo を当てはめる
 */

/**
 * 得点率 p を Elo 差に直す（p=0.5 → 0）。
 * 全勝・全敗は無限になるので、表示と集計が壊れないよう ±800 で止める。
 */
export const ELO_CAP = 800

export function eloFromScoreRate(p: number): number {
  if (p <= 0) return -ELO_CAP
  if (p >= 1) return ELO_CAP
  const elo = -400 * Math.log10(1 / p - 1)
  if (elo > ELO_CAP) return ELO_CAP
  if (elo < -ELO_CAP) return -ELO_CAP
  return elo
}

/** Elo 差を期待得点率に直す */
export function scoreRateFromElo(elo: number): number {
  return 1 / (1 + Math.pow(10, -elo / 400))
}

export type Interval = { low: number; high: number }

/**
 * Wilson score 区間。successes は引き分けを 0.5 と数えた得点でも良い。
 * z=1.96 で 95%。
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96,
): Interval {
  if (total <= 0) return { low: 0, high: 1 }
  const p = successes / total
  const z2 = z * z
  const denom = 1 + z2 / total
  const center = (p + z2 / (2 * total)) / denom
  const half =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom
  return {
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  }
}

function logGamma(x: number): number {
  // Lanczos 近似
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
    )
  }
  const z = x - 1
  let a = 0.99999999999980993
  const t = z + 7.5
  for (let i = 0; i < g.length; i += 1) {
    a += g[i]! / (z + i + 1)
  }
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
}

/**
 * p=0.5 の両側二項検定（符号検定）。
 * wins / losses は引き分けを除いた数。戻り値は p 値。
 */
export function binomialTestTwoSided(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  const ln2 = Math.LN2
  const logPmf = (k: number): number => logChoose(n, k) - n * ln2
  const target = logPmf(wins)
  // 同じか、より起こりにくい結果の確率をすべて足す
  let sum = 0
  const eps = 1e-9
  for (let k = 0; k <= n; k += 1) {
    const lp = logPmf(k)
    if (lp <= target + eps) sum += Math.exp(lp)
  }
  return Math.min(1, sum)
}

export type SprtBounds = {
  /** H0: この Elo 差以下（採用しない） */
  elo0: number
  /** H1: この Elo 差以上（採用する） */
  elo1: number
  alpha: number
  beta: number
}

export const DEFAULT_SPRT: SprtBounds = {
  elo0: 0,
  elo1: 20,
  alpha: 0.05,
  beta: 0.05,
}

/**
 * GSPRT の対数尤度比。W/D/L は検定側（新モデル）から見た数。
 * Fishtest と同じ得点分散モデルを使う。
 */
export function llrGsprt(
  wins: number,
  draws: number,
  losses: number,
  bounds: SprtBounds = DEFAULT_SPRT,
): number {
  const n = wins + draws + losses
  if (n === 0) return 0
  const w = wins / n
  const d = draws / n
  const l = losses / n
  const s = w + d / 2
  // 得点の分散（標本）
  const variance =
    w * (1 - s) * (1 - s) + d * (0.5 - s) * (0.5 - s) + l * s * s
  if (variance <= 0) return 0
  const varOfMean = variance / n
  const s0 = scoreRateFromElo(bounds.elo0)
  const s1 = scoreRateFromElo(bounds.elo1)
  return ((s1 - s0) * (2 * s - s0 - s1)) / (2 * varOfMean)
}

export type SprtVerdict = 'accept' | 'reject' | 'continue'

export function sprtDecision(
  wins: number,
  draws: number,
  losses: number,
  bounds: SprtBounds = DEFAULT_SPRT,
): { verdict: SprtVerdict; llr: number; lower: number; upper: number } {
  const llr = llrGsprt(wins, draws, losses, bounds)
  const lower = Math.log(bounds.beta / (1 - bounds.alpha))
  const upper = Math.log((1 - bounds.beta) / bounds.alpha)
  let verdict: SprtVerdict = 'continue'
  if (llr >= upper) verdict = 'accept'
  else if (llr <= lower) verdict = 'reject'
  return { verdict, llr, lower, upper }
}

export type PairwiseRecord = {
  aId: string
  bId: string
  aWins: number
  bWins: number
  draws: number
}

/**
 * Bradley–Terry を MM 法で当てはめて Elo を出す。
 * 引き分けは双方に 0.5 勝として数える。基準は全体平均 0。
 */
export function fitBradleyTerryElo(
  records: readonly PairwiseRecord[],
  options?: { iterations?: number; anchorId?: string; anchorElo?: number },
): Map<string, number> {
  const iterations = options?.iterations ?? 400
  const ids = new Set<string>()
  for (const r of records) {
    ids.add(r.aId)
    ids.add(r.bId)
  }
  const idList = [...ids]
  const strength = new Map<string, number>()
  for (const id of idList) strength.set(id, 1)

  // 得点（勝ち1・引分0.5）と対戦数を集計
  const wonBy = new Map<string, number>()
  const games = new Map<string, Map<string, number>>()
  for (const id of idList) {
    wonBy.set(id, 0)
    games.set(id, new Map())
  }
  for (const r of records) {
    const total = r.aWins + r.bWins + r.draws
    if (total === 0) continue
    wonBy.set(r.aId, wonBy.get(r.aId)! + r.aWins + r.draws / 2)
    wonBy.set(r.bId, wonBy.get(r.bId)! + r.bWins + r.draws / 2)
    const ga = games.get(r.aId)!
    const gb = games.get(r.bId)!
    ga.set(r.bId, (ga.get(r.bId) ?? 0) + total)
    gb.set(r.aId, (gb.get(r.aId) ?? 0) + total)
  }

  // 全勝・全敗は発散するので、わずかな仮想引き分けで安定させる
  const PRIOR = 0.5
  for (const id of idList) {
    wonBy.set(id, wonBy.get(id)! + PRIOR)
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    for (const id of idList) {
      const si = strength.get(id)!
      let denom = 2 * PRIOR / (si + 1)
      for (const [opp, n] of games.get(id)!) {
        denom += n / (si + strength.get(opp)!)
      }
      if (denom > 0) {
        strength.set(id, wonBy.get(id)! / denom)
      }
    }
    // 幾何平均を 1 に正規化（スケール不定性を除く）
    let logSum = 0
    for (const id of idList) logSum += Math.log(strength.get(id)!)
    const shift = Math.exp(-logSum / idList.length)
    for (const id of idList) {
      strength.set(id, strength.get(id)! * shift)
    }
  }

  const elo = new Map<string, number>()
  for (const id of idList) {
    elo.set(id, (400 / Math.LN10) * Math.log(strength.get(id)!))
  }

  const anchorId = options?.anchorId
  if (anchorId && elo.has(anchorId)) {
    const shift = (options?.anchorElo ?? 0) - elo.get(anchorId)!
    for (const id of idList) elo.set(id, elo.get(id)! + shift)
  }
  return elo
}
