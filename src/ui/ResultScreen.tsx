import {
  countStones,
  type EndReason,
  type MatchState,
  type Outcome,
} from '../game/index.ts'
import { BrandLockup } from './BrandLockup.tsx'
import './ResultScreen.css'

type ResultScreenProps = {
  match: MatchState
  canRematch: boolean
  onRematch: () => void
  onBackToTitle: () => void
  onUiSound?: () => void
}

export function ResultScreen({
  match,
  canRematch,
  onRematch,
  onBackToTitle,
  onUiSound,
}: ResultScreenProps) {
  const counts = countStones(match.board)

  return (
    <section className="result-screen">
      <BrandLockup size="compact" />
      <h1>{outcomeLabel(match.outcome)}</h1>
      <p className="reason">{endReasonLabel(match.endReason)}</p>
      <div className="final-counts">
        <div className="result-score">
          <span className="hud-stone hud-stone-black" aria-hidden="true" />
          <span className="label">あなた</span>
          <strong>{counts.black}</strong>
        </div>
        <div className="result-score">
          <span className="hud-stone hud-stone-white" aria-hidden="true" />
          <span className="label">CPU</span>
          <strong>{counts.white}</strong>
        </div>
      </div>
      {!canRematch ? (
        <p className="lives-empty-note">
          ライフがありません。日付が変わると復活します
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!canRematch}
          onClick={() => {
            if (!canRematch) return
            onUiSound?.()
            onRematch()
          }}
        >
          同じ設定で再戦
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            onUiSound?.()
            onBackToTitle()
          }}
        >
          開始画面に戻る
        </button>
      </div>
    </section>
  )
}

function outcomeLabel(outcome: Outcome | null): string {
  if (outcome === 'black_win') return '勝ち'
  if (outcome === 'white_win') return '負け'
  if (outcome === 'draw') return '引き分け'
  return '結果'
}

function endReasonLabel(reason: EndReason | null): string {
  if (reason === 'board_full') return '終了理由: 盤面が埋まりました'
  if (reason === 'no_legal_moves') {
    return '終了理由: 双方とも置ける場所がなくなりました'
  }
  if (reason === 'time_up') return '終了理由: 試合時間切れ'
  return '終了理由: —'
}
