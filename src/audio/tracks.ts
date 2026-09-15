export const TRACK_IDS = [
  'select',
  'battle',
  'resultWin',
  'resultLose',
  'resultDraw',
] as const
export type TrackId = (typeof TRACK_IDS)[number]

export const STEPS_PER_BAR = 16

export type ToneBus = 'bass' | 'lead' | 'pad'
export type DrumKind = 'kick' | 'snare' | 'hat'
export type ToneWave = 'sine' | 'square' | 'sawtooth' | 'triangle'

export type ToneHit = {
  step: number
  len: number
  midi: number
  wave: ToneWave
  gain: number
  bus: ToneBus
}

export type DrumHit = {
  step: number
  kind: DrumKind
  gain: number
}

export type TrackDef = {
  id: TrackId
  bpm: number
  bars: number
  /** 先頭の一発物小節数。ループは introBars 以降だけ。 */
  introBars?: number
  tones: ToneHit[]
  drums: DrumHit[]
}

export type ScheduledEvent =
  | {
      step: number
      durSteps: number
      kind: 'tone'
      midi: number
      wave: ToneWave
      gain: number
      bus: ToneBus
    }
  | {
      step: number
      durSteps: number
      kind: DrumKind
      gain: number
    }

/** 全曲で共有する電脳パレット（A ドリア／マイナー系） */
const E2 = 40
const F2 = 41
const G2 = 43
const A2 = 45
const C3 = 48
const D2 = 38
const D3 = 50
const E3 = 52
const F3 = 53
const G3 = 55
const GS3 = 56
const A3 = 57
const B3 = 59
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const GS4 = 68
const A4 = 69
const B4 = 71
const C5 = 72
const D5 = 74
const E5 = 76
const G5 = 79
const A5 = 81
const C6 = 84

function barTones(
  bar: number,
  wave: ToneWave,
  gain: number,
  bus: ToneBus,
  notes: Array<[stepInBar: number, len: number, midi: number]>,
): ToneHit[] {
  return notes.map(([step, len, midi]) => ({
    step: bar * STEPS_PER_BAR + step,
    len,
    midi,
    wave,
    gain,
    bus,
  }))
}

function drumsOn(
  bars: number,
  stepsInBar: number[],
  kind: DrumKind,
  gain: number,
  startBar = 0,
): DrumHit[] {
  const hits: DrumHit[] = []
  for (let bar = 0; bar < bars; bar += 1) {
    for (const step of stepsInBar) {
      hits.push({
        step: (startBar + bar) * STEPS_PER_BAR + step,
        kind,
        gain,
      })
    }
  }
  return hits
}

/** 電脳ロビー: ゆったり・中域が聞こえる安心感 */
function selectTrack(): TrackDef {
  const tones: ToneHit[] = []
  const padRootsA = [A2, F2, G2, A2, A2, C3, G2, A2]
  const padRootsB = [D2, D2, F2, G2, C3, C3, G2, A2]
  const padRoots = [...padRootsA, ...padRootsB]

  for (let bar = 0; bar < 16; bar += 1) {
    const root = padRoots[bar]!
    const padLen = 19
    const third =
      bar === 8 || bar === 9 ? root + 15 : root + 19
    tones.push(
      ...barTones(bar, 'sine', 0.16, 'bass', [[0, 16, root]]),
      ...barTones(bar, 'sine', 0.042, 'pad', [[0, padLen, root + 7]]),
      ...barTones(bar, 'sine', 0.05, 'pad', [[0, padLen, root + 12]]),
      ...barTones(bar, 'sine', 0.038, 'pad', [[0, padLen, third]]),
    )
  }

  const motif: Array<[number, number, number]> = [
    [0, 4, E4],
    [4, 4, A4],
    [8, 4, G4],
    [12, 4, E4],
  ]
  const motifB: Array<[number, number, number]> = [
    [0, 4, D4],
    [4, 4, G4],
    [8, 4, A4],
    [12, 4, C5],
  ]
  for (const bar of [0, 1, 4, 5, 8, 9, 12]) {
    tones.push(...barTones(bar, 'triangle', 0.09, 'lead', motif))
  }
  for (const bar of [2, 6, 10, 13]) {
    tones.push(...barTones(bar, 'triangle', 0.085, 'lead', motifB))
  }
  tones.push(
    ...barTones(14, 'triangle', 0.075, 'lead', [
      [0, 8, C5],
      [8, 8, B4],
    ]),
    ...barTones(15, 'triangle', 0.1, 'lead', [
      [0, 6, E4],
      [6, 4, G4],
      [10, 6, A4],
    ]),
  )

  for (const bar of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]) {
    const pulse: Array<[number, number, number]> = [
      [0, 2, A4],
      [6, 1, E5],
      [8, 2, E5],
    ]
    if (bar % 4 === 2) pulse.push([14, 1, C6])
    tones.push(...barTones(bar, 'triangle', 0.048, 'lead', pulse))
  }

  return {
    id: 'select',
    bpm: 78,
    bars: 16,
    tones,
    drums: [
      ...drumsOn(16, [0], 'kick', 0.19),
      ...drumsOn(16, [6, 14], 'hat', 0.05),
      ...drumsOn(16, [8], 'snare', 0.055),
    ],
  }
}

/** リアルタイム決闘: 鼓動はあるが耳が疲れない駆動 */
function battleTrack(): TrackDef {
  const bassPulse: Array<[number, number, number]> = [
    [0, 2, A2],
    [2, 2, A2],
    [4, 2, A2],
    [6, 2, C3],
    [8, 2, A2],
    [10, 2, G2],
    [12, 2, A2],
    [14, 2, E2],
  ]
  const bassLift: Array<[number, number, number]> = [
    [0, 2, F2],
    [2, 2, F2],
    [4, 2, G2],
    [6, 2, G2],
    [8, 2, A2],
    [10, 2, C3],
    [12, 2, D3],
    [14, 2, E3],
  ]
  const bassDrive: Array<[number, number, number]> = [
    [0, 2, F2],
    [2, 2, F2],
    [4, 2, C3],
    [6, 2, C3],
    [8, 2, G2],
    [10, 2, G2],
    [12, 2, D3],
    [14, 2, E3],
  ]

  const leadA: Array<Array<[number, number, number]>> = [
    [
      [0, 2, A4],
      [4, 2, C5],
      [8, 4, E4],
      [12, 4, D4],
    ],
    [
      [0, 4, E4],
      [4, 4, G4],
      [8, 4, A4],
      [12, 4, E4],
    ],
    [
      [0, 2, G4],
      [2, 2, A4],
      [4, 4, C5],
      [8, 8, E4],
    ],
    [
      [0, 4, D4],
      [4, 4, E4],
      [8, 4, G4],
      [12, 4, A4],
    ],
    [
      [0, 2, A4],
      [4, 2, C5],
      [8, 4, E5],
      [12, 4, C5],
    ],
    [
      [0, 4, D5],
      [4, 4, C5],
      [8, 4, A4],
      [12, 4, G4],
    ],
    [
      [0, 2, E4],
      [2, 2, G4],
      [4, 4, A4],
      [8, 4, G4],
      [12, 4, E4],
    ],
    [
      [0, 8, A4],
      [8, 4, G4],
      [12, 4, E4],
    ],
  ]

  const leadB: Array<[number, number, number]> = [
    [0, 3, E5],
    [3, 3, D5],
    [6, 2, C5],
    [8, 3, A4],
    [11, 3, C5],
    [14, 2, E5],
  ]
  const leadB2: Array<[number, number, number]> = [
    [0, 2, C5],
    [2, 2, D5],
    [4, 4, E5],
    [8, 2, D5],
    [10, 2, C5],
    [12, 4, A4],
  ]
  const leadB3: Array<[number, number, number]> = [
    [0, 2, A4],
    [2, 2, C5],
    [4, 2, E5],
    [6, 2, G5],
    [8, 4, E5],
    [12, 4, D5],
  ]
  const leadB4: Array<[number, number, number]> = [
    [0, 4, G5],
    [4, 2, E5],
    [6, 2, D5],
    [8, 4, C5],
    [12, 4, E5],
  ]
  const leadBLow = leadB.map(
    ([s, l, m]) => [s, l, m - 5] as [number, number, number],
  )

  const padPairs: Array<[number, number]> = [
    [A3, E4],
    [A3, D4],
    [G3, D4],
    [A3, E4],
    [A3, E4],
    [F3, C4],
    [A3, E4],
    [G3, D4],
    [A3, E4],
    [G3, D4], // Round3: was A3+E4
    [G3, D4],
    [A3, E4],
    [F3, C4], // Round2
    [G3, D4],
    [A3, E4],
    [A3, E4],
  ]

  const tones: ToneHit[] = []

  const bassFor = (bar: number): Array<[number, number, number]> => {
    if (bar <= 7) {
      if (bar === 2 || bar === 5 || bar === 7) return bassLift
      return bassPulse
    }
    if (bar === 8 || bar === 10 || bar === 12) return bassDrive
    if (bar === 9 || bar === 11) return bassPulse
    if (bar === 13 || bar === 14) return bassLift
    return bassLift
  }

  for (let bar = 0; bar < 16; bar += 1) {
    tones.push(
      ...barTones(bar, 'sawtooth', bar >= 8 ? 0.12 : 0.11, 'bass', bassFor(bar)),
    )
  }

  for (let bar = 0; bar < 16; bar += 1) {
    const [low, high] = padPairs[bar]!
    const padLen = 19
    if (bar === 5) {
      tones.push(
        ...barTones(bar, 'sine', 0.055, 'pad', [
          [0, 11, F3],
          [8, 11, E4],
        ]),
      )
    } else {
      tones.push(
        ...barTones(bar, 'sine', 0.055, 'pad', [
          [0, padLen, low],
          [0, padLen, high],
        ]),
      )
    }
  }

  for (let bar = 0; bar < 8; bar += 1) {
    tones.push(...barTones(bar, 'triangle', 0.07 + bar * 0.001, 'lead', leadA[bar]!))
  }

  // B section leads
  tones.push(...barTones(8, 'triangle', 0.078, 'lead', leadB))
  tones.push(...barTones(9, 'triangle', 0.075, 'lead', leadBLow))
  tones.push(...barTones(10, 'triangle', 0.078, 'lead', leadB2))
  // bar 11 rest
  tones.push(...barTones(12, 'triangle', 0.08, 'lead', leadB3))
  tones.push(...barTones(13, 'triangle', 0.078, 'lead', leadB2))
  tones.push(...barTones(14, 'triangle', 0.08, 'lead', leadB4))
  tones.push(
    ...barTones(15, 'triangle', 0.085, 'lead', [
      [0, 2, A4],
      [2, 2, C5],
      [4, 2, E5],
      [6, 2, A5],
      [8, 4, E5],
      [12, 4, A4],
    ]),
  )

  return {
    id: 'battle',
    bpm: 138,
    bars: 16,
    tones,
    drums: [
      ...drumsOn(15, [0, 8], 'kick', 0.26),
      ...drumsOn(15, [4, 12], 'kick', 0.11),
      ...drumsOn(15, [4, 12], 'snare', 0.16),
      ...drumsOn(8, [2, 6, 10, 14], 'hat', 0.09, 0),
      ...drumsOn(7, [2, 6, 10, 14], 'hat', 0.085, 8),
      ...drumsOn(7, [0, 4, 8, 12], 'hat', 0.042, 8),
      ...drumsOn(1, [2, 6, 10, 14], 'hat', 0.095, 15),
      ...drumsOn(1, [0, 4, 8, 12], 'hat', 0.055, 15),
      { step: 15 * 16 + 0, kind: 'kick', gain: 0.2 },
      { step: 15 * 16 + 0, kind: 'snare', gain: 0.1 },
      { step: 15 * 16 + 4, kind: 'snare', gain: 0.12 },
      { step: 15 * 16 + 8, kind: 'kick', gain: 0.24 },
      { step: 15 * 16 + 8, kind: 'snare', gain: 0.13 },
      { step: 15 * 16 + 10, kind: 'snare', gain: 0.13 },
      { step: 15 * 16 + 12, kind: 'snare', gain: 0.15 },
      { step: 15 * 16 + 14, kind: 'snare', gain: 0.17 },
      { step: 15 * 16 + 14, kind: 'kick', gain: 0.22 },
    ],
  }
}

/** 勝利の余韻: ファンファーレ付きで明るく上がる */
function resultWinTrack(): TrackDef {
  const tones: ToneHit[] = []

  // Intro fanfare (bars 0-1)
  tones.push(
    ...barTones(0, 'sine', 0.15, 'bass', [
      [0, 8, A2],
      [8, 8, F2],
    ]),
    ...barTones(0, 'triangle', 0.12, 'lead', [
      [0, 1, A4],
      [1, 1, C5],
      [2, 1, E5],
      [3, 2, A5],
      [6, 2, G5],
      [8, 4, A5],
      [12, 4, E5],
    ]),
    ...barTones(0, 'square', 0.055, 'lead', [
      [3, 2, A5],
      [8, 4, A5],
    ]),
    ...barTones(1, 'sine', 0.15, 'bass', [
      [0, 8, G2],
      [8, 8, A2],
    ]),
    ...barTones(1, 'triangle', 0.12, 'lead', [
      [0, 2, E5],
      [2, 2, G5],
      [4, 4, A5],
      [8, 8, A5],
    ]),
    ...barTones(1, 'square', 0.055, 'lead', [[4, 4, A5], [8, 8, A5]]),
  )

  const loopBass: Array<Array<[number, number, number]>> = [
    [
      [0, 8, A2],
      [8, 8, C3],
    ],
    [
      [0, 8, E3],
      [8, 8, A2],
    ],
    [
      [0, 8, F2],
      [8, 8, G2],
    ],
    [[0, 16, A2]],
    [
      [0, 8, C3],
      [8, 8, G2],
    ],
    [
      [0, 8, F2],
      [8, 8, E2],
    ],
    [
      [0, 8, D3],
      [8, 8, G2],
    ],
    [
      [0, 8, E2],
      [8, 8, A2],
    ],
  ]

  const padMap: Array<[number, number]> = [
    [A3, E4],
    [C4, E4],
    [A3, C4],
    [A3, E4],
    [C4, E4],
    [A3, C4],
    [B3, D4],
    [A3, E4], // bar9 resolved half handled separately
  ]

  const loopLeads: Array<Array<[number, number, number]>> = [
    [
      [0, 4, A4],
      [4, 4, C5],
      [8, 4, E5],
      [12, 4, G4],
    ],
    [
      [0, 4, E4],
      [4, 4, G4],
      [8, 4, A4],
      [12, 4, C5],
    ],
    [
      [0, 4, C5],
      [4, 4, D5],
      [8, 4, E5],
      [12, 4, G4],
    ],
    [
      [0, 8, A4],
      [8, 4, E4],
      [12, 4, A4],
    ],
    [
      [0, 2, E5],
      [2, 2, D5],
      [4, 4, C5],
      [8, 4, A4],
      [12, 4, C5],
    ],
    [
      [0, 4, E5],
      [4, 4, C5],
      [8, 4, B4],
      [12, 4, A4],
    ],
    [
      [0, 2, B4],
      [2, 2, C5],
      [4, 4, D5],
      [8, 8, E5],
    ],
    [
      [0, 4, B4],
      [4, 4, GS4],
      [8, 4, A4],
      [12, 4, E5],
    ],
  ]

  const squareLayer: Array<Array<[number, number, number]>> = [
    [
      [8, 4, E5],
      [12, 4, G4],
    ],
    [
      [8, 4, A4],
      [12, 4, C5],
    ],
    [
      [8, 4, E5],
      [12, 4, G4],
    ],
    [
      [8, 4, E4],
      [12, 4, A4],
    ],
    [
      [8, 4, A4],
      [12, 4, C5],
    ],
    [
      [8, 4, B4],
      [12, 4, A4],
    ],
    [[8, 8, E5]],
    [
      [8, 4, A4],
      [12, 4, E5],
    ],
  ]

  for (let i = 0; i < 8; i += 1) {
    const bar = i + 2
    tones.push(...barTones(bar, 'sine', 0.14, 'bass', loopBass[i]!))
    if (bar === 8) {
      tones.push(
        ...barTones(8, 'sine', 0.05, 'pad', [
          [0, 11, C4],
          [0, 11, D4],
          [8, 11, B3],
          [8, 11, D4],
        ]),
      )
    } else if (bar === 9) {
      tones.push(
        ...barTones(bar, 'sine', 0.055, 'pad', [
          [0, 11, GS3],
          [0, 11, D4],
          [8, 11, A3],
          [8, 11, E4],
        ]),
      )
    } else {
      const [lo, hi] = padMap[i]!
      tones.push(
        ...barTones(bar, 'sine', 0.05, 'pad', [
          [0, 19, lo],
          [0, 19, hi],
        ]),
      )
    }
    tones.push(...barTones(bar, 'triangle', 0.09, 'lead', loopLeads[i]!))
    tones.push(
      ...barTones(
        bar,
        'square',
        bar === 9 ? 0.05 : 0.045,
        'lead',
        squareLayer[i]!,
      ),
    )
  }

  return {
    id: 'resultWin',
    bpm: 112,
    bars: 10,
    introBars: 2,
    tones,
    drums: [
      { step: 0, kind: 'kick', gain: 0.28 },
      { step: 0, kind: 'snare', gain: 0.14 },
      { step: 2, kind: 'snare', gain: 0.14 },
      { step: 4, kind: 'snare', gain: 0.14 },
      { step: 16, kind: 'kick', gain: 0.22 },
      ...drumsOn(8, [0, 8], 'kick', 0.16, 2),
      ...drumsOn(8, [2, 6, 10, 14], 'hat', 0.055, 2),
      ...drumsOn(8, [4, 12], 'snare', 0.1, 2),
    ],
  }
}

/** 敗北の余韻: ゆっくり沈む */
function resultLoseTrack(): TrackDef {
  const tones: ToneHit[] = []
  const bassRoots = [A2, F2, E2, A2, G2, F2, E2, A2]
  const padFollow = [A3, A3, G3, E3, D4, C4, B3, A3]
  const padUpper = [E4, E4, D4, B3, A4, G4, E4, E4]

  for (let bar = 0; bar < 8; bar += 1) {
    tones.push(
      ...barTones(bar, 'sine', 0.15, 'bass', [[0, 16, bassRoots[bar]!]]),
      ...barTones(bar, 'sine', 0.055, 'bass', [
        [0, 16, bassRoots[bar]! + 7],
      ]),
      ...barTones(bar, 'sine', 0.062, 'pad', [[0, 19, padFollow[bar]!]]),
      ...barTones(bar, 'sine', 0.042, 'pad', [[0, 19, padUpper[bar]!]]),
    )
  }

  // Front half melody
  tones.push(
    ...barTones(0, 'sine', 0.088, 'lead', [
      [0, 8, E4],
      [8, 8, D4],
    ]),
    ...barTones(1, 'sine', 0.088, 'lead', [
      [0, 8, C4],
      [8, 8, A3],
    ]),
    ...barTones(2, 'sine', 0.088, 'lead', [
      [0, 8, G3],
      [8, 8, E3],
    ]),
    ...barTones(3, 'sine', 0.088, 'lead', [
      [0, 12, A3],
      [12, 4, E3],
    ]),
    // Round3 fragments on bars 4/6/7
    ...barTones(4, 'sine', 0.065, 'lead', [
      [0, 8, C4],
      [8, 8, A3],
    ]),
    ...barTones(5, 'sine', 0.065, 'lead', [
      [0, 8, E4],
      [8, 8, C4],
    ]),
    ...barTones(6, 'sine', 0.07, 'lead', [
      [0, 6, D4],
      [8, 5, B3],
      [13, 3, GS3],
    ]),
    ...barTones(7, 'sine', 0.065, 'lead', [
      [0, 12, A3],
      [12, 4, B3],
    ]),
  )

  return {
    id: 'resultLose',
    bpm: 68,
    bars: 8,
    tones,
    drums: [...drumsOn(8, [0], 'kick', 0.15)],
  }
}

/** 引き分け: どちらにも寄らない浮遊感 */
function resultDrawTrack(): TrackDef {
  const tones: ToneHit[] = []
  const bassPairs: Array<Array<[number, number, number]>> = [
    [
      [0, 8, A2],
      [8, 8, E2],
    ],
    [
      [0, 6, C3],
      [6, 4, G2],
      [10, 6, C3],
    ],
    [
      [0, 8, F2],
      [8, 8, C3],
    ],
    [
      [0, 4, G2],
      [4, 4, D3],
      [8, 8, G2],
    ],
    [
      [0, 8, A2],
      [8, 8, E2],
    ],
    [
      [0, 10, D3],
      [10, 6, A2],
    ],
    [
      [0, 8, F2],
      [8, 8, G2],
    ],
    [
      [0, 6, A2],
      [6, 6, E2],
      [12, 4, A2],
    ],
  ]
  const padNinth = [B3, D4, G3, A3, B3, E4, A3, B3]
  const padLower = [E3, G3, C4, D4, E3, A3, C4, E3]
  const topLine: Array<Array<[number, number, number]>> = [
    [
      [0, 4, C5],
      [8, 4, E5],
    ],
    [
      [2, 4, E5],
      [10, 4, D5],
    ],
    [
      [0, 6, A4],
      [8, 6, C5],
    ],
    [
      [4, 4, D5],
      [12, 4, E5],
    ],
    [
      [0, 4, E5],
      [8, 4, G5],
    ],
    [
      [2, 6, C5],
      [10, 4, B4],
    ],
    [
      [0, 6, A4],
      [8, 4, B4],
    ],
    [
      [0, 4, C5],
      [6, 4, B4],
      [12, 4, E5],
    ],
  ]
  const leadSeq: Array<Array<[number, number, number, number]>> = [
    [
      [0, 8, E4, A4],
      [8, 8, G4, C5],
    ],
    [
      [0, 6, G4, C5],
      [6, 4, E4, A4],
      [10, 6, D4, G4],
    ],
    [
      [0, 8, C4, F4],
      [8, 8, E4, A4],
    ],
    [
      [0, 4, D4, G4],
      [4, 4, E4, A4],
      [8, 8, G4, C5],
    ],
    [
      [0, 8, A4, D5],
      [8, 8, G4, C5],
    ],
    [
      [0, 10, A4, D5],
      [10, 6, E4, A4],
    ],
    [
      [0, 8, C4, F4],
      [8, 8, D4, G4],
    ],
    [
      [0, 6, E4, A4],
      [6, 6, D4, G4],
      [12, 4, E4, A4],
    ],
  ]
  for (let bar = 0; bar < 8; bar += 1) {
    const padLen = 19
    tones.push(
      ...barTones(bar, 'sine', 0.13, 'bass', bassPairs[bar]!),
      ...barTones(bar, 'sine', 0.048, 'pad', [[0, padLen, padNinth[bar]!]]),
      ...barTones(bar, 'sine', 0.038, 'pad', [[0, padLen, padLower[bar]!]]),
      ...barTones(bar, 'triangle', 0.055, 'lead', topLine[bar]!),
    )
    for (const [s, l, lo, hi] of leadSeq[bar]!) {
      tones.push(
        ...barTones(bar, 'triangle', 0.078, 'lead', [
          [s, l, lo],
          [s, l, hi],
        ]),
      )
    }
  }

  return {
    id: 'resultDraw',
    bpm: 86,
    bars: 8,
    tones,
    drums: [
      ...drumsOn(8, [0], 'kick', 0.14),
      ...drumsOn(8, [8], 'hat', 0.042),
      ...drumsOn(8, [4, 12], 'hat', 0.03),
      { step: 1 * 16 + 10, kind: 'kick', gain: 0.07 },
      { step: 3 * 16 + 6, kind: 'kick', gain: 0.07 },
      { step: 5 * 16 + 12, kind: 'kick', gain: 0.07 },
    ],
  }
}

export const TRACKS: Record<TrackId, TrackDef> = {
  select: selectTrack(),
  battle: battleTrack(),
  resultWin: resultWinTrack(),
  resultLose: resultLoseTrack(),
  resultDraw: resultDrawTrack(),
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

export function stepDurationSec(bpm: number): number {
  return 60 / bpm / 4
}

export function loopSteps(track: TrackDef): number {
  return track.bars * STEPS_PER_BAR
}

export function expandTrack(track: TrackDef): ScheduledEvent[] {
  const total = loopSteps(track)
  const events: ScheduledEvent[] = []

  for (const tone of track.tones) {
    if (tone.step < 0 || tone.step >= total) {
      throw new Error(`${track.id}: tone step ${tone.step} is out of loop`)
    }
    if (tone.len <= 0) {
      throw new Error(`${track.id}: tone length must be positive`)
    }
    events.push({
      step: tone.step,
      durSteps: tone.len,
      kind: 'tone',
      midi: tone.midi,
      wave: tone.wave,
      gain: tone.gain,
      bus: tone.bus,
    })
  }

  for (const drum of track.drums) {
    if (drum.step < 0 || drum.step >= total) {
      throw new Error(`${track.id}: drum step ${drum.step} is out of loop`)
    }
    events.push({
      step: drum.step,
      durSteps: 1,
      kind: drum.kind,
      gain: drum.gain,
    })
  }

  events.sort((a, b) => a.step - b.step || a.kind.localeCompare(b.kind))
  return events
}

const eventCache = new Map<TrackId, ScheduledEvent[]>()

export function getTrack(id: TrackId): TrackDef {
  return TRACKS[id]
}

export function getTrackEvents(id: TrackId): ScheduledEvent[] {
  const cached = eventCache.get(id)
  if (cached) return cached
  const events = expandTrack(TRACKS[id])
  eventCache.set(id, events)
  return events
}
