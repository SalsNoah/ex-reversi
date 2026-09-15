import { useEffect, useRef, useState } from 'react'
import { createRng, type Rng } from '../game/rng.ts'
import { GAME_CONFIG } from '../game/config.ts'
import {
  abortPausedSession,
  createTitleSession,
  pauseSession,
  queuePlayerMove,
  rematchSameSettings,
  resumeSession,
  startCountdown,
  stepSession,
  type SessionSettings,
  type SessionState,
} from '../session/index.ts'
import type { MoveRequest, Outcome } from '../game/types.ts'
import { shouldConsumeLifeOnAbort, shouldRecordMatchOutcome } from '../lives/index.ts'

function createSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000)
}

export function useGameSession(options?: {
  onMatchFinished?: (outcome: Outcome) => void
  onMatchAborted?: () => void
}) {
  const [session, setSession] = useState<SessionState>(() =>
    createTitleSession({ seed: createSeed() }),
  )
  const sessionRef = useRef(session)
  sessionRef.current = session
  const onMatchFinishedRef = useRef(options?.onMatchFinished)
  onMatchFinishedRef.current = options?.onMatchFinished
  const onMatchAbortedRef = useRef(options?.onMatchAborted)
  onMatchAbortedRef.current = options?.onMatchAborted

  const rngRef = useRef<Rng>(createRng(session.settings.seed))
  /** React 更新と rAF の競合を避けるため、入力は ref 経由でループに渡す */
  const pendingMoveRef = useRef<MoveRequest | null>(null)
  /** HMR / StrictMode で古い rAF が残らないようにする世代番号 */
  const loopGenerationRef = useRef(0)

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) return
      pendingMoveRef.current = null
      setSession((current) => {
        if (
          current.screen === 'playing' &&
          current.match?.phase === 'playing'
        ) {
          const paused = pauseSession(current)
          sessionRef.current = paused
          return paused
        }
        return current
      })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const generation = loopGenerationRef.current + 1
    loopGenerationRef.current = generation
    let cancelled = false
    let acc = 0
    let last = performance.now()
    let rafId = 0

    const tick = (now: number) => {
      if (cancelled || loopGenerationRef.current !== generation) return
      const rawDt = now - last
      last = now
      // rAF の停止・復帰で空いた実時間はまとめ進めしない（一時停止復帰と同趣旨）
      const dt = rawDt > 250 ? 0 : Math.max(0, rawDt)
      acc += dt

      let current = sessionRef.current
      const shouldRun =
        current.screen === 'countdown' ||
        (current.screen === 'playing' && current.match?.phase === 'playing')

      if (!shouldRun) {
        acc = 0
        rafId = requestAnimationFrame(tick)
        return
      }

      let changed = false
      // 1フレームで進めすぎない（異常な蓄積の安全弁）
      let stepsThisFrame = 0
      while (acc >= GAME_CONFIG.stepMs && stepsThisFrame < 4) {
        acc -= GAME_CONFIG.stepMs
        stepsThisFrame += 1
        current = sessionRef.current

        if (pendingMoveRef.current) {
          current = queuePlayerMove(current, pendingMoveRef.current)
          pendingMoveRef.current = null
        }

        const prevScreen = current.screen
        const result = stepSession(current, rngRef.current)
        current = result.session
        sessionRef.current = current
        changed = true

        if (
          shouldRecordMatchOutcome(prevScreen, current.screen) &&
          current.match?.outcome
        ) {
          onMatchFinishedRef.current?.(current.match.outcome)
        }

        if (
          current.screen !== 'countdown' &&
          !(current.screen === 'playing' && current.match?.phase === 'playing')
        ) {
          acc = 0
          break
        }
      }
      if (stepsThisFrame >= 4) {
        acc = 0
      }

      if (changed) {
        setSession(current)
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [])

  const beginMatch = (
    settings: Omit<SessionSettings, 'seed'> & { seed?: number },
  ) => {
    pendingMoveRef.current = null
    const nextSettings: SessionSettings = {
      seed: settings.seed ?? createSeed(),
      cooldownMs: settings.cooldownMs,
      cpuType: settings.cpuType,
    }
    rngRef.current = createRng(nextSettings.seed)
    const next = startCountdown(nextSettings)
    sessionRef.current = next
    setSession(next)
  }

  const onCellClick = (row: number, col: number) => {
    // 予約しない: 未処理がなければ1件だけ受け付ける
    if (pendingMoveRef.current) return
    const current = sessionRef.current
    if (current.screen !== 'playing' || current.match?.phase !== 'playing') {
      return
    }
    pendingMoveRef.current = { row, col }
  }

  const onPause = () => {
    pendingMoveRef.current = null
    setSession((current) => {
      const next = pauseSession(current)
      sessionRef.current = next
      return next
    })
  }

  const onResume = () => {
    pendingMoveRef.current = null
    setSession((current) => {
      const next = resumeSession(current)
      sessionRef.current = next
      return next
    })
  }

  const onAbort = () => {
    pendingMoveRef.current = null
    const current = sessionRef.current
    const next = abortPausedSession(current)
    if (shouldConsumeLifeOnAbort(current.screen, next.screen)) {
      onMatchAbortedRef.current?.()
    }
    sessionRef.current = next
    setSession(next)
  }

  const onRematch = () => {
    pendingMoveRef.current = null
    setSession((current) => {
      const next = rematchSameSettings(current)
      rngRef.current = createRng(next.settings.seed)
      sessionRef.current = next
      return next
    })
  }

  const onBackToTitle = () => {
    pendingMoveRef.current = null
    const next = createTitleSession({
      ...sessionRef.current.settings,
      seed: createSeed(),
    })
    sessionRef.current = next
    setSession(next)
  }

  return {
    session,
    beginMatch,
    onCellClick,
    onPause,
    onResume,
    onAbort,
    onRematch,
    onBackToTitle,
  }
}
