import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createMatch } from '../game/index.ts'
import { ResultScreen } from './ResultScreen.tsx'

function finishedMatch() {
  return {
    ...createMatch({ seed: 1, cooldownMs: 700 }),
    phase: 'finished' as const,
    outcome: 'white_win' as const,
    endReason: 'board_full' as const,
  }
}

describe('ResultScreen ライフ', () => {
  it('ライフが無いと再戦できない', () => {
    const html = renderToStaticMarkup(
      <ResultScreen
        match={finishedMatch()}
        canRematch={false}
        onRematch={() => {}}
        onBackToTitle={() => {}}
      />,
    )
    expect(html).toContain('ライフがありません。日付が変わると復活します')
    expect(html).toContain('disabled')
    expect(html).toContain('開始画面に戻る')
  })

  it('ライフが残っていれば再戦できる', () => {
    const html = renderToStaticMarkup(
      <ResultScreen
        match={finishedMatch()}
        canRematch
        onRematch={() => {}}
        onBackToTitle={() => {}}
      />,
    )
    expect(html).not.toContain('ライフがありません')
    expect(html).not.toContain('disabled')
  })
})
