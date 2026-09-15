import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GAME_CONFIG } from '../game/config.ts'
import type { Outcome } from '../game/types.ts'
import {
  canStartMatch,
  createLocalStorageStore,
  loadLives,
  localDateKey,
  recordAbort,
  recordMatchOutcome,
  type LivesState,
  type StringStore,
} from '../lives/index.ts'

const DATE_CHECK_MS = 30_000

export type UseLivesOptions = {
  store?: StringStore
  now?: () => Date
}

export function useLives(options?: UseLivesOptions) {
  const store = useMemo(
    () => options?.store ?? createLocalStorageStore(),
    [options?.store],
  )
  const nowRef = useRef(options?.now)
  nowRef.current = options?.now

  const today = () =>
    localDateKey((nowRef.current ?? (() => new Date()))())

  const [state, setState] = useState<LivesState>(() => loadLives(store, today()))

  const refresh = useCallback((): LivesState => {
    const next = loadLives(store, today())
    setState(next)
    return next
  }, [store])

  const recordOutcome = useCallback(
    (outcome: Outcome | null): LivesState => {
      const next = recordMatchOutcome(store, outcome, today())
      setState(next)
      return next
    },
    [store],
  )

  const consumeOnAbort = useCallback((): LivesState => {
    const next = recordAbort(store, today())
    setState(next)
    return next
  }, [store])

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(refresh, DATE_CHECK_MS)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(timer)
    }
  }, [refresh])

  return {
    remaining: state.remaining,
    max: GAME_CONFIG.livesMax,
    canStart: canStartMatch(state),
    refresh,
    recordOutcome,
    consumeOnAbort,
  }
}
