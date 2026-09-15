import './LivesHud.css'

type LivesHudProps = {
  remaining: number
  max: number
}

export function LivesHud({ remaining, max }: LivesHudProps) {
  const safeMax = Math.max(0, max)
  const filled = Math.min(safeMax, Math.max(0, remaining))

  return (
    <div
      className="lives-hud"
      aria-label={`ライフ ${filled} / ${safeMax}`}
    >
      <span className="lives-hud-label">ライフ</span>
      <span className="lives-hud-pips" aria-hidden="true">
        {Array.from({ length: safeMax }, (_, index) => (
          <span
            key={index}
            className={
              index < filled ? 'lives-pip lives-pip-on' : 'lives-pip lives-pip-off'
            }
          >
            <HeartIcon />
          </span>
        ))}
      </span>
    </div>
  )
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="lives-pip-icon">
      <path
        d="M12 20.2S4.2 15.1 4.2 9.7A4.05 4.05 0 0 1 12 7.5 4.05 4.05 0 0 1 19.8 9.7C19.8 15.1 12 20.2 12 20.2z"
        fill="currentColor"
      />
    </svg>
  )
}
