import {
  countStones,
  hasLegalMove,
  GAME_CONFIG,
  type MatchState,
} from '../game/index.ts'
import { getCpuAgent } from '../cpu/index.ts'
import type { LastMove, SessionSettings } from '../session/index.ts'
import { BrandLockup } from './BrandLockup.tsx'
import { BoardView } from './Board.tsx'
import './PlayScreen.css'

type PlayScreenProps = {
  match: MatchState
  settings: SessionSettings
  lastMove: LastMove | null
  countdownRemainingMs: number
  playerIdleRemainingMs: number | null
  cpuIdleRemainingMs: number | null
  isCountdown: boolean
  onCellClick: (row: number, col: number) => void
  onPause: () => void
  onResume: () => void
  onAbort: () => void
  onUiSound?: () => void
}

export function PlayScreen({
  match,
  settings,
  lastMove,
  countdownRemainingMs,
  playerIdleRemainingMs,
  cpuIdleRemainingMs,
  isCountdown,
  onCellClick,
  onPause,
  onResume,
  onAbort,
  onUiSound,
}: PlayScreenProps) {
  const counts = countStones(match.board)
  const remainingMatchMs = Math.max(
    0,
    GAME_CONFIG.matchDurationMs - match.elapsedMs,
  )
  const paused = match.phase === 'paused'
  const playing = match.phase === 'playing' && !isCountdown
  const playerStatus = describePlayerStatus(match, isCountdown)
  const cpuLabel = getCpuAgent(settings.cpuType).label
  const countdownNumber = Math.max(
    1,
    Math.ceil(countdownRemainingMs / 1000),
  )

  return (
    <section className="play-screen">
      <header className="play-top">
        <BrandLockup size="compact" />
      </header>

      <div className="hud">
        <div className="score-card side-player">
          <span className="hud-stone hud-stone-black" aria-hidden="true" />
          <div className="score-meta">
            <div className="score-name">あなた</div>
            <div className="gauge-stack">
              <Gauge
                label="行動ゲージ"
                remainingMs={match.cooldowns.black}
                totalMs={match.cooldownMs}
                tone="cooldown"
              />
              <Gauge
                label="自動着手ゲージ"
                remainingMs={playerIdleRemainingMs ?? GAME_CONFIG.idleAutoMoveMs}
                totalMs={GAME_CONFIG.idleAutoMoveMs}
                tone="idle"
              />
            </div>
          </div>
          <div className="stone-count" key={`black-${counts.black}`}>
            {counts.black}
          </div>
        </div>

        <div className="hud-timer">
          <div className="hud-timer-label">残り時間</div>
          <div className="hud-timer-value">
            {formatTime(isCountdown ? GAME_CONFIG.matchDurationMs : remainingMatchMs)}
          </div>
        </div>

        <div className="score-card side-cpu">
          <span className="hud-stone hud-stone-white" aria-hidden="true" />
          <div className="score-meta">
            <div className="score-name">CPU</div>
            <div className="gauge-stack">
              <Gauge
                label="行動ゲージ"
                remainingMs={match.cooldowns.white}
                totalMs={match.cooldownMs}
                tone="cooldown"
              />
              <Gauge
                label="自動着手ゲージ"
                remainingMs={cpuIdleRemainingMs ?? GAME_CONFIG.idleAutoMoveMs}
                totalMs={GAME_CONFIG.idleAutoMoveMs}
                tone="idle"
              />
            </div>
          </div>
          <div className="stone-count" key={`white-${counts.white}`}>
            {counts.white}
          </div>
        </div>
      </div>

      <div className="status-row">
        <p className="status">{playerStatus}</p>
        <p className="cpu-name">{cpuLabel}</p>
      </div>

      <div className="board-wrap">
        <BoardView
          board={match.board}
          lastMove={lastMove}
          showLegalMoves={playing && !paused}
          interactive={playing && !paused}
          onCellClick={onCellClick}
        />
        {isCountdown && (
          <div className="countdown-overlay" aria-live="assertive">
            <span className="countdown-number" key={countdownNumber}>
              {countdownNumber}
            </span>
            <span className="countdown-caption">まもなく開始</span>
          </div>
        )}
        {paused && (
          <div className="pause-overlay">
            <p>一時停止中</p>
            <div className="pause-overlay-actions">
              <button
                type="button"
                className="hud-btn"
                onClick={() => {
                  onUiSound?.()
                  onResume()
                }}
              >
                再開
              </button>
              <button
                type="button"
                className="hud-btn pause-abort"
                onClick={() => {
                  onUiSound?.()
                  onAbort()
                }}
              >
                中断
              </button>
            </div>
          </div>
        )}
      </div>

      {!paused && (
        <button
          type="button"
          className="pause-fab"
          onClick={() => {
            onUiSound?.()
            onPause()
          }}
          disabled={isCountdown || match.phase !== 'playing'}
        >
          <PauseIcon />
          <span>一時停止</span>
        </button>
      )}
    </section>
  )
}

function Gauge({
  label,
  remainingMs,
  totalMs,
  tone,
}: {
  label: string
  remainingMs: number
  totalMs: number
  tone: 'cooldown' | 'idle'
}) {
  const readyRatio =
    totalMs <= 0 ? 1 : Math.max(0, Math.min(1, 1 - remainingMs / totalMs))
  return (
    <div className={`gauge gauge-${tone}`} aria-label={label}>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${readyRatio * 100}%` }} />
      </div>
    </div>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pause-fab-icon">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  )
}

function describePlayerStatus(
  match: MatchState,
  isCountdown: boolean,
): string {
  if (isCountdown) return 'カウントダウン中'
  if (match.phase === 'paused') return '一時停止中'
  if (match.cooldowns.black > 0) {
    const sec = (match.cooldowns.black / 1000).toFixed(1)
    return `回復まであと${sec}秒`
  }
  if (!hasLegalMove(match.board, 'black')) {
    return '置ける場所がありません'
  }
  return '置けます'
}

function formatTime(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}
