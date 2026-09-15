import { describe, expect, it } from 'vitest'
import { resolveBgmCue } from './cue.ts'
import { SFX_IDS, SFX_PATCHES, sfxForStone } from './sfx.ts'
import {
  expandTrack,
  getTrack,
  midiToFreq,
  STEPS_PER_BAR,
  TRACK_IDS,
  TRACKS,
} from './tracks.ts'

describe('BGM cue', () => {
  it('選択画面は select、対戦は battle', () => {
    expect(
      resolveBgmCue({
        screen: 'title',
        pausedMatch: false,
        hidden: false,
      }),
    ).toEqual({ track: 'select', paused: false, stage: 'normal' })

    expect(
      resolveBgmCue({
        screen: 'countdown',
        pausedMatch: false,
        hidden: false,
      }),
    ).toEqual({ track: 'battle', paused: false, stage: 'countdown' })

    expect(
      resolveBgmCue({
        screen: 'playing',
        pausedMatch: false,
        hidden: false,
      }),
    ).toEqual({ track: 'battle', paused: false, stage: 'normal' })
  })

  it('結果画面は勝ちと負けで別曲にする', () => {
    expect(
      resolveBgmCue({
        screen: 'result',
        pausedMatch: false,
        hidden: false,
        outcome: 'black_win',
      }).track,
    ).toBe('resultWin')

    expect(
      resolveBgmCue({
        screen: 'result',
        pausedMatch: false,
        hidden: false,
        outcome: 'white_win',
      }).track,
    ).toBe('resultLose')

    expect(
      resolveBgmCue({
        screen: 'result',
        pausedMatch: false,
        hidden: false,
        outcome: 'draw',
      }).track,
    ).toBe('resultDraw')
  })

  it('一時停止中とページ非表示中は再生を止める', () => {
    expect(
      resolveBgmCue({
        screen: 'playing',
        pausedMatch: true,
        hidden: false,
      }).paused,
    ).toBe(true)

    expect(
      resolveBgmCue({
        screen: 'title',
        pausedMatch: false,
        hidden: true,
      }).paused,
    ).toBe(true)

    expect(
      resolveBgmCue({
        screen: 'countdown',
        pausedMatch: false,
        hidden: false,
      }).paused,
    ).toBe(false)
  })
})

describe('BGM tracks', () => {
  it('画面役割ごとにテンポと密度が分かれる', () => {
    expect(TRACKS.select.bpm).toBeLessThan(90)
    expect(TRACKS.battle.bpm).toBeGreaterThan(120)
    expect(TRACKS.battle.bpm).toBeLessThanOrEqual(140)
    expect(TRACKS.select.bars).toBeGreaterThanOrEqual(16)
    expect(TRACKS.battle.bars).toBeGreaterThanOrEqual(16)
    expect(TRACKS.resultWin.introBars).toBeGreaterThan(0)
    expect(TRACKS.resultWin.bpm).toBeGreaterThan(TRACKS.resultLose.bpm)
    expect(TRACKS.resultWin.drums.length).toBeGreaterThan(
      TRACKS.resultLose.drums.length,
    )
    expect(TRACKS.select.tones.some((tone) => tone.midi >= 60)).toBe(true)
    expect(
      TRACKS.battle.tones.filter((t) => t.bus === 'lead' && t.wave === 'triangle')
        .length,
    ).toBeGreaterThan(
      TRACKS.battle.tones.filter((t) => t.bus === 'lead' && t.wave === 'square')
        .length,
    )
  })

  it('ループ内の音符だけを展開する', () => {
    for (const id of TRACK_IDS) {
      const track = getTrack(id)
      const events = expandTrack(track)
      const total = track.bars * STEPS_PER_BAR
      expect(events.length).toBe(track.tones.length + track.drums.length)
      expect(events.every((event) => event.step >= 0 && event.step < total)).toBe(
        true,
      )
      expect(events.some((event) => event.kind === 'tone')).toBe(true)
      expect(events.some((event) => event.kind === 'kick')).toBe(true)
    }
  })

  it('A4 は 440Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 8)
  })
})

describe('SE', () => {
  it('黒と白の着手で別のSEを使う', () => {
    expect(sfxForStone('black')).toBe('placeBlack')
    expect(sfxForStone('white')).toBe('placeWhite')
    expect(SFX_IDS).toContain('ui')
  })

  it('UIは短いクリック、着手は調性内で区別できる', () => {
    expect(SFX_PATCHES.ui.durSec).toBeLessThan(0.1)
    expect(SFX_PATCHES.ui.attackSec).toBeLessThan(0.01)
    expect(SFX_PATCHES.ui.tickGain).toBeGreaterThan(0)
    expect(SFX_PATCHES.placeBlack.bodyHz).toBeLessThan(
      SFX_PATCHES.placeWhite.bodyHz,
    )
    expect(SFX_PATCHES.placeBlack.filterHz).toBeLessThan(
      SFX_PATCHES.placeWhite.filterHz,
    )
    expect(SFX_PATCHES.placeBlack.durSec).toBeLessThan(0.25)
    expect(SFX_PATCHES.placeWhite.chimeHz).toBeGreaterThan(
      SFX_PATCHES.placeBlack.chimeHz,
    )
  })
})
