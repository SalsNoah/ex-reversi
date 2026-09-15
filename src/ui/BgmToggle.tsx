import './BgmToggle.css'

type BgmToggleProps = {
  muted: boolean
  onToggle: () => void
}

export function BgmToggle({ muted, onToggle }: BgmToggleProps) {
  const label = muted ? 'BGMオフ' : 'BGMオン'

  return (
    <button
      type="button"
      className="bgm-toggle"
      aria-pressed={!muted}
      aria-label={label}
      onClick={onToggle}
    >
      <SpeakerIcon muted={muted} />
      <span>{label}</span>
    </button>
  )
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="bgm-toggle-icon" aria-hidden="true">
      <path
        d="M4 9.5v5h3.2L12 18V6L7.2 9.5H4z"
        fill="currentColor"
      />
      {muted ? (
        <path
          d="M15.2 9.2 20.8 14.8M20.8 9.2 15.2 14.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M15.2 9.4c1.3 1.2 1.3 4 0 5.2M17.6 7.2c2.4 2.3 2.4 7.3 0 9.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
