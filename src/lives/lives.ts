import { GAME_CONFIG } from '../game/config.ts'
import type { Outcome, Stone } from '../game/types.ts'

export const LIVES_STORAGE_KEY = 'exreversi.lives.v1'

export type LivesState = {
  remaining: number
  /** 端末ローカルの暦日 YYYY-MM-DD */
  date: string
}

export type StringStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export function localDateKey(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function defaultLives(date: string): LivesState {
  return { remaining: GAME_CONFIG.livesMax, date }
}

export function createMemoryStore(
  initial: Record<string, string> = {},
): StringStore {
  const data: Record<string, string> = { ...initial }
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null
    },
    setItem(key, value) {
      data[key] = value
    },
  }
}

export function createLocalStorageStore(): StringStore {
  try {
    const storage = window.localStorage
    storage.getItem(LIVES_STORAGE_KEY)
    return {
      getItem(key) {
        try {
          return storage.getItem(key)
        } catch {
          return null
        }
      },
      setItem(key, value) {
        try {
          storage.setItem(key, value)
        } catch {
          // プライベートモードなどでは捨てる
        }
      },
    }
  } catch {
    return createMemoryStore()
  }
}

export function clampLives(remaining: number): number {
  if (!Number.isInteger(remaining)) return GAME_CONFIG.livesMax
  return Math.min(GAME_CONFIG.livesMax, Math.max(0, remaining))
}

export function parseLives(raw: string | null, today: string): LivesState {
  if (raw == null) return defaultLives(today)
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return defaultLives(today)
    const remaining = (parsed as { remaining?: unknown }).remaining
    const date = (parsed as { date?: unknown }).date
    if (typeof remaining !== 'number' || typeof date !== 'string') {
      return defaultLives(today)
    }
    if (!DATE_KEY.test(date) || !Number.isInteger(remaining)) {
      return defaultLives(today)
    }
    return restoreLives({ remaining: clampLives(remaining), date }, today)
  } catch {
    return defaultLives(today)
  }
}

export function restoreLives(state: LivesState, today: string): LivesState {
  if (state.date !== today) return defaultLives(today)
  return { remaining: clampLives(state.remaining), date: today }
}

export function canStartMatch(state: LivesState): boolean {
  return state.remaining > 0
}

export function isPlayerDefeat(
  outcome: Outcome | null,
  playerStone: Stone = GAME_CONFIG.playerStone,
): boolean {
  if (outcome == null || outcome === 'draw') return false
  if (playerStone === 'black') return outcome === 'white_win'
  return outcome === 'black_win'
}

export function consumeLife(state: LivesState, today: string): LivesState {
  const restored = restoreLives(state, today)
  return {
    remaining: Math.max(0, restored.remaining - 1),
    date: today,
  }
}

export function applyMatchOutcome(
  state: LivesState,
  outcome: Outcome | null,
  today: string,
  playerStone: Stone = GAME_CONFIG.playerStone,
): LivesState {
  const restored = restoreLives(state, today)
  if (!isPlayerDefeat(outcome, playerStone)) return restored
  return consumeLife(restored, today)
}

export function applyAbort(state: LivesState, today: string): LivesState {
  return consumeLife(state, today)
}

export function saveLives(store: StringStore, state: LivesState): void {
  store.setItem(LIVES_STORAGE_KEY, JSON.stringify(state))
}

export function loadLives(store: StringStore, today: string): LivesState {
  const next = parseLives(store.getItem(LIVES_STORAGE_KEY), today)
  saveLives(store, next)
  return next
}

export function recordMatchOutcome(
  store: StringStore,
  outcome: Outcome | null,
  today: string,
  playerStone: Stone = GAME_CONFIG.playerStone,
): LivesState {
  const current = parseLives(store.getItem(LIVES_STORAGE_KEY), today)
  const next = applyMatchOutcome(current, outcome, today, playerStone)
  saveLives(store, next)
  return next
}

export function recordAbort(store: StringStore, today: string): LivesState {
  const current = parseLives(store.getItem(LIVES_STORAGE_KEY), today)
  const next = applyAbort(current, today)
  saveLives(store, next)
  return next
}

export function shouldRecordMatchOutcome(
  previousScreen: string,
  nextScreen: string,
): boolean {
  return previousScreen !== 'result' && nextScreen === 'result'
}

export function shouldConsumeLifeOnAbort(
  previousScreen: string,
  nextScreen: string,
): boolean {
  return previousScreen === 'playing' && nextScreen === 'title'
}
