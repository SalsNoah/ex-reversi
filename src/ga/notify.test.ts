import { describe, expect, it } from 'vitest'
import {
  campaignTargetGenerations,
  formatGenerationNotice,
  phaseLabel,
  shouldShowDesktopNotify,
} from './notify.ts'
import { noticeFromCheckpoint, latestCompletedGeneration } from './status.ts'

describe('ga generation notify', () => {
  it('長時間再学習の目標世代は400', () => {
    expect(campaignTargetGenerations('ga1-train-004', 21)).toBe(400)
    expect(campaignTargetGenerations('ga1-train-003', 101)).toBe(100)
  })

  it('現状の世代通知文に世代と目標が入る', () => {
    const { title, body } = formatGenerationNotice({
      runId: 'ga1-train-004',
      generation: 2,
      phase: 'primary',
      completedMatches: 2880,
      campaignTarget: 400,
      chunkEndGeneration: 20,
      bestScoreRate: 0.844,
      kind: 'current',
    })
    expect(title).toBe('オセロAI学習')
    expect(body).toContain('第2世代を実行中（目標400）')
    expect(body).toContain('一次評価')
    expect(body).toContain('試合 2880')
  })

  it('世代完了の通知は「今N世代目が終わった」', () => {
    const { body } = formatGenerationNotice({
      runId: 'ga1-train-004',
      generation: 2,
      phase: 'breed',
      completedMatches: 2688,
      campaignTarget: 400,
      chunkEndGeneration: 20,
      bestScoreRate: 0.844,
      kind: 'generation-done',
    })
    expect(body).toContain('今2世代目が終わった（目標400）')
    expect(body).toContain('得点率 0.844')
  })

  it('位相ラベルを日本語にする', () => {
    expect(phaseLabel('primary')).toBe('一次評価')
    expect(phaseLabel('extra')).toBe('追加評価')
  })

  it('自動テスト中はデスクトップ通知を出さない', () => {
    expect(shouldShowDesktopNotify()).toBe(false)
  })

  it('チェックポイントから通知内容を組み立てる', () => {
    const notice = noticeFromCheckpoint(
      {
        runId: 'ga1-train-004',
        generation: 2,
        phase: 'primary',
        completedMatches: 2800,
        config: { generations: 21 },
        lastRankedSnapshot: [{ scoreRate: 0.8 }],
      },
      'current',
    )
    expect(notice.campaignTarget).toBe(400)
    expect(notice.chunkEndGeneration).toBe(20)
    expect(notice.bestScoreRate).toBe(0.8)
  })

  it('評価中なら終わった世代はひとつ前、breed/doneなら今の世代', () => {
    expect(
      latestCompletedGeneration({
        exists: true,
        generation: 2,
        phase: 'extra',
      }),
    ).toBe(1)
    expect(
      latestCompletedGeneration({
        exists: true,
        generation: 2,
        phase: 'breed',
      }),
    ).toBe(2)
    expect(
      latestCompletedGeneration({
        exists: true,
        generation: 1,
        phase: 'primary',
      }),
    ).toBe(null)
  })
})
