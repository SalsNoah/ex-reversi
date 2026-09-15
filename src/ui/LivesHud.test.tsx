import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LivesHud } from './LivesHud.tsx'

describe('LivesHud', () => {
  it('残りのライフ数を出す', () => {
    const html = renderToStaticMarkup(<LivesHud remaining={3} max={5} />)
    expect(html).toContain('ライフ 3 / 5')
    expect(html).toContain('lives-pip-on')
    expect(html).toContain('lives-pip-off')
    expect(html.match(/lives-pip-on/g)?.length).toBe(3)
    expect(html.match(/lives-pip-off/g)?.length).toBe(2)
  })

  it('0でも枠は5つ残す', () => {
    const html = renderToStaticMarkup(<LivesHud remaining={0} max={5} />)
    expect(html).toContain('ライフ 0 / 5')
    expect(html.match(/lives-pip-on/g)).toBeNull()
    expect(html.match(/lives-pip-off/g)?.length).toBe(5)
  })
})
