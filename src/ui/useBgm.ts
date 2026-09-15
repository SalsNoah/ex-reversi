import { useEffect, useRef, useState } from 'react'
import { resolveBgmCue, type BgmScreen } from '../audio/cue.ts'
import { BgmEngine } from '../audio/engine.ts'
import { sfxForStone, type SfxId } from '../audio/sfx.ts'

type UseBgmOptions = {
  screen: BgmScreen
  pausedMatch: boolean
  outcome?: 'black_win' | 'white_win' | 'draw' | null
  lastMove?: { player: 'black' | 'white' } | null
}

/** 仕様 2.8: 初期状態はミュートしない（BGMオン） */
export const BGM_MUTED_DEFAULT = false

export function useBgm({
  screen,
  pausedMatch,
  outcome = null,
  lastMove = null,
}: UseBgmOptions) {
  const engineRef = useRef<BgmEngine | null>(null)
  const [muted, setMuted] = useState(BGM_MUTED_DEFAULT)
  const [hidden, setHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.hidden,
  )

  useEffect(() => {
    const engine = new BgmEngine()
    engineRef.current = engine

    const unlock = () => {
      engine.unlock()
    }
    const onVisibility = () => setHidden(document.hidden)

    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      document.removeEventListener('visibilitychange', onVisibility)
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    const cue = resolveBgmCue({ screen, pausedMatch, hidden, outcome })
    engineRef.current?.setCue(cue)
  }, [screen, pausedMatch, hidden, muted, outcome])

  useEffect(() => {
    engineRef.current?.setMuted(muted)
  }, [muted])

  const heardMove = useRef(lastMove)
  useEffect(() => {
    if (!lastMove || lastMove === heardMove.current) {
      heardMove.current = lastMove
      return
    }
    heardMove.current = lastMove
    engineRef.current?.playSfx(sfxForStone(lastMove.player))
  }, [lastMove])

  const playSfx = (id: SfxId) => {
    engineRef.current?.playSfx(id)
  }

  const toggle = () => {
    engineRef.current?.unlock()
    setMuted((current) => !current)
  }

  return {
    muted,
    toggle,
    playSfx,
  }
}
