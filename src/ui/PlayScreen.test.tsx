import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createMatch } from '../game/index.ts'
import { PlayScreen } from './PlayScreen.tsx'

describe('PlayScreen ゲージ', () => {
  it('行動ゲージの下に無操作の自動着手ゲージを別色で出す', () => {
    const html = renderToStaticMarkup(
      <PlayScreen
        match={{
          ...createMatch({ seed: 1, cooldownMs: 700 }),
          cooldowns: { black: 0, white: 350 },
        }}
        settings={{ seed: 1, cooldownMs: 700, cpuType: 'random' }}
        lastMove={null}
        countdownRemainingMs={0}
        playerIdleRemainingMs={1500}
        cpuIdleRemainingMs={750}
        isCountdown={false}
        onCellClick={() => {}}
        onPause={() => {}}
        onResume={() => {}}
        onAbort={() => {}}
      />,
    )

    expect(html).toContain('gauge-stack')
    expect(html).toContain('gauge-cooldown')
    expect(html).toContain('gauge-idle')
    expect(html).toContain('aria-label="自動着手ゲージ"')
    expect(html).not.toContain('自動まであと')

    const playerCard = html.slice(
      html.indexOf('side-player'),
      html.indexOf('hud-timer'),
    )
    expect(playerCard.indexOf('gauge-cooldown')).toBeLessThan(
      playerCard.indexOf('gauge-idle'),
    )
    expect(playerCard).toMatch(/gauge-idle[\s\S]*?width:50%/)

    const cpuCard = html.slice(html.indexOf('side-cpu'))
    expect(cpuCard.indexOf('gauge-cooldown')).toBeLessThan(
      cpuCard.indexOf('gauge-idle'),
    )
    expect(cpuCard).toMatch(/gauge-idle[\s\S]*?width:75%/)
  })

  it('無操作タイマーが止まっている間は自動着手ゲージを空にする', () => {
    const html = renderToStaticMarkup(
      <PlayScreen
        match={{
          ...createMatch({ seed: 1, cooldownMs: 700 }),
          cooldowns: { black: 700, white: 0 },
        }}
        settings={{ seed: 1, cooldownMs: 700, cpuType: 'random' }}
        lastMove={null}
        countdownRemainingMs={0}
        playerIdleRemainingMs={null}
        cpuIdleRemainingMs={null}
        isCountdown={false}
        onCellClick={() => {}}
        onPause={() => {}}
        onResume={() => {}}
        onAbort={() => {}}
      />,
    )

    expect(html).toMatch(/gauge-idle[\s\S]*?width:0%/)
    expect(html).not.toContain('自動まであと')
  })

  it('対戦中の合法手マスはアニメなしでもすぐ押せる', () => {
    const html = renderToStaticMarkup(
      <PlayScreen
        match={createMatch({ seed: 1, cooldownMs: 700 })}
        settings={{ seed: 1, cooldownMs: 700, cpuType: 'random' }}
        lastMove={null}
        countdownRemainingMs={0}
        playerIdleRemainingMs={1500}
        cpuIdleRemainingMs={null}
        isCountdown={false}
        onCellClick={() => {}}
        onPause={() => {}}
        onResume={() => {}}
        onAbort={() => {}}
      />,
    )

    const legalButtons = html.match(/<button[^>]*cell-legal[^>]*>/g) ?? []
    expect(legalButtons.length).toBeGreaterThan(0)
    for (const button of legalButtons) {
      expect(button).not.toContain('disabled')
    }
  })
})
