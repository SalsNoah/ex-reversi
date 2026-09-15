import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TitleScreen } from './TitleScreen.tsx'

describe('TitleScreen', () => {
  it('試作設定を出さない', () => {
    const html = renderToStaticMarkup(
      <TitleScreen initialCpuType="random" canStart onStart={() => {}} />,
    )
    expect(html).not.toContain('試作設定')
    expect(html).not.toContain('着手後の待ち時間')
    expect(html).toContain('CPUの選択')
    expect(html).toContain('開始')
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
