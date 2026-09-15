export const SFX_IDS = ['ui', 'placeBlack', 'placeWhite'] as const
export type SfxId = (typeof SFX_IDS)[number]

export type SfxPatch = {
  bodyHz: number
  bodyGain: number
  partialHz: number
  partialGain: number
  chimeHz: number
  chimeGain: number
  tickHz: number
  tickGain: number
  tickDurSec: number
  tickMode: 'highpass' | 'bandpass'
  airHz: number
  airGain: number
  bendRatio: number
  attackSec: number
  durSec: number
  filterHz: number
  bodyDurScale: number
}

export const SFX_PATCHES: Record<SfxId, SfxPatch> = {
  ui: {
    bodyHz: 660,
    bodyGain: 0.095,
    partialHz: 1320,
    partialGain: 0.038,
    chimeHz: 1568,
    chimeGain: 0.018,
    tickHz: 3200,
    tickGain: 0.032,
    tickDurSec: 0.011,
    tickMode: 'highpass',
    airHz: 6200,
    airGain: 0.008,
    bendRatio: 1.12,
    attackSec: 0.0025,
    durSec: 0.075,
    filterHz: 5200,
    bodyDurScale: 1.15,
  },
  placeBlack: {
    bodyHz: 130.81,
    bodyGain: 0.135,
    partialHz: 261.63,
    partialGain: 0.05,
    chimeHz: 392,
    chimeGain: 0.03,
    tickHz: 1700,
    tickGain: 0.046,
    tickDurSec: 0.018,
    tickMode: 'bandpass',
    airHz: 5200,
    airGain: 0.01,
    bendRatio: 0.9,
    attackSec: 0.0035,
    durSec: 0.15,
    filterHz: 2200,
    bodyDurScale: 0.95,
  },
  placeWhite: {
    bodyHz: 164.81,
    bodyGain: 0.118,
    partialHz: 329.63,
    partialGain: 0.036,
    chimeHz: 1046.5,
    chimeGain: 0.03,
    tickHz: 2600,
    tickGain: 0.058,
    tickDurSec: 0.015,
    tickMode: 'bandpass',
    airHz: 6800,
    airGain: 0.011,
    bendRatio: 0.93,
    attackSec: 0.003,
    durSec: 0.15,
    filterHz: 3800,
    bodyDurScale: 0.95,
  },
}

export function sfxForStone(player: 'black' | 'white'): SfxId {
  return player === 'black' ? 'placeBlack' : 'placeWhite'
}
