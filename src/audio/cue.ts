import type { TrackId } from './tracks.ts'

export type BgmScreen = 'title' | 'countdown' | 'playing' | 'result'

export type BgmOutcome = 'black_win' | 'white_win' | 'draw'

export type BgmStage = 'normal' | 'countdown'

export type BgmCue = {
  track: TrackId | null
  paused: boolean
  stage: BgmStage
}

export function resolveBgmCue(input: {
  screen: BgmScreen
  pausedMatch: boolean
  hidden: boolean
  outcome?: BgmOutcome | null
}): BgmCue {
  const track =
    input.screen === 'title'
      ? 'select'
      : input.screen === 'countdown' || input.screen === 'playing'
        ? 'battle'
        : input.screen === 'result'
          ? resultTrackFor(input.outcome)
          : null

  const paused =
    input.hidden || (input.screen === 'playing' && input.pausedMatch)

  const stage: BgmStage =
    input.screen === 'countdown' ? 'countdown' : 'normal'

  return { track, paused, stage }
}

function resultTrackFor(outcome: BgmOutcome | null | undefined): TrackId {
  if (outcome === 'black_win') return 'resultWin'
  if (outcome === 'white_win') return 'resultLose'
  return 'resultDraw'
}
