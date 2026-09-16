import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TitleScreen } from './TitleScreen.tsx'

describe('TitleScreen', () => {
  it('イプシロンを先頭の選択肢として出せる', () => {
    const html = renderToStaticMarkup(
      <TitleScreen initialCpuType="epsilon" canStart onStart={() => {}} />,
    )
    expect(html).toContain('value="epsilon"')
    expect(html).toContain('checked')
    // 過去の名前付き個体は消さず、新しい順に並べる（仕様 2.9）
    const order = ['epsilon', 'delta', 'gamma', 'beta', 'alpha'].map((id) =>
      html.indexOf(`value="${id}"`),
    )
    expect(order.every((at) => at >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('15世代から5世代ごとのGA育成を出せる', () => {
    const html = renderToStaticMarkup(
      <TitleScreen initialCpuType="ga_best" canStart onStart={() => {}} />,
    )
    expect(html).toContain('GA育成（第15世代）')
    expect(html).toContain('GA育成（第100世代）')
    expect(html).toContain('GA育成（第90世代・最強）')
    expect(html).toContain('value="ga_g15"')
    expect(html).toContain('value="ga_g100"')
    expect(html).toContain('checked')
  })

  it('ライフが無いと開始できない', () => {
    const html = renderToStaticMarkup(
      <TitleScreen initialCpuType="random" canStart={false} onStart={() => {}} />,
    )
    expect(html).toContain('ライフがありません。日付が変わると復活します')
    expect(html).toContain('disabled')
  })
})
