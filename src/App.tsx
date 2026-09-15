import { TitleScreen } from './ui/TitleScreen.tsx'
import { PlayScreen } from './ui/PlayScreen.tsx'
import { ResultScreen } from './ui/ResultScreen.tsx'
import { BgmToggle } from './ui/BgmToggle.tsx'
import { LivesHud } from './ui/LivesHud.tsx'
import { useBgm } from './ui/useBgm.ts'
import { useGameSession } from './ui/useGameSession.ts'
import { useLives } from './ui/useLives.ts'
import { GAME_CONFIG } from './game/config.ts'
import './App.css'

function App() {
  const lives = useLives()
  const {
    session,
    beginMatch,
    onCellClick,
    onPause,
    onResume,
    onAbort,
    onRematch,
    onBackToTitle,
  } = useGameSession({
    onMatchFinished: (outcome) => {
      lives.recordOutcome(outcome)
    },
    onMatchAborted: () => {
      lives.consumeOnAbort()
    },
  })
  const bgm = useBgm({
    screen: session.screen,
    pausedMatch: session.match?.phase === 'paused',
    outcome: session.match?.outcome ?? null,
    lastMove: session.lastMove,
  })
  const playUi = () => bgm.playSfx('ui')

  const startIfAlive = (cpuType: typeof session.settings.cpuType) => {
    if (lives.refresh().remaining <= 0) return
    beginMatch({ cpuType, cooldownMs: GAME_CONFIG.cooldownMs })
  }

  const rematchIfAlive = () => {
    if (lives.refresh().remaining <= 0) return
    onRematch()
  }

  return (
    <>
      <LivesHud remaining={lives.remaining} max={lives.max} />
      <BgmToggle
        muted={bgm.muted}
        onToggle={() => {
          bgm.playSfx('ui')
          bgm.toggle()
        }}
      />
      {session.screen === 'title' ? (
        <main className="app-shell">
          <TitleScreen
            initialCpuType={session.settings.cpuType}
            canStart={lives.canStart}
            onStart={({ cpuType }) => startIfAlive(cpuType)}
            onUiSound={playUi}
          />
        </main>
      ) : (session.screen === 'countdown' || session.screen === 'playing') &&
        session.match ? (
        <main className="app-shell">
          <PlayScreen
            match={session.match}
            settings={session.settings}
            lastMove={session.lastMove}
            countdownRemainingMs={session.countdownRemainingMs}
            playerIdleRemainingMs={session.playerIdleRemainingMs}
            cpuIdleRemainingMs={session.cpuIdleRemainingMs}
            isCountdown={session.screen === 'countdown'}
            onCellClick={onCellClick}
            onPause={onPause}
            onResume={onResume}
            onAbort={onAbort}
            onUiSound={playUi}
          />
        </main>
      ) : session.screen === 'result' && session.match ? (
        <main className="app-shell">
          <ResultScreen
            match={session.match}
            canRematch={lives.canStart}
            onRematch={rematchIfAlive}
            onBackToTitle={onBackToTitle}
            onUiSound={playUi}
          />
        </main>
      ) : (
        <main className="app-shell">
          <p>読み込み中…</p>
        </main>
      )}
    </>
  )
}

export default App
