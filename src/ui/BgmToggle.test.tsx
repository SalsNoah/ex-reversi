import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BgmToggle } from './BgmToggle.tsx'
import { BGM_MUTED_DEFAULT } from './useBgm.ts'

describe('BGM default', () => {
  it('初期状態はミュートしない', () => {
    expect(BGM_MUTED_DEFAULT).toBe(false)
  })

  it('初期表示はBGMオン', () => {
    const html = renderToStaticMarkup(
      <BgmToggle muted={BGM_MUTED_DEFAULT} onToggle={() => {}} />,
    )
    expect(html).toContain('BGMオン')
    expect(html).toContain('aria-pressed="true"')
    expect(html).not.toContain('BGMオフ')
    expect(html).not.toContain('タップでBGM')
  })

  it('ミュート中はBGMオフと出す', () => {
    const html = renderToStaticMarkup(
      <BgmToggle muted onToggle={() => {}} />,
    )
    expect(html).toContain('BGMオフ')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('BGMオン')
  })
})
