import './BrandLockup.css'

type BrandLockupProps = {
  size?: 'full' | 'compact'
}

export function BrandLockup({ size = 'full' }: BrandLockupProps) {
  return (
    <div className={`brand-lockup brand-lockup-${size}`}>
      <p className="brand-kicker">EXTREME</p>
      <p className="brand-title">REVERSI</p>
      <p className="brand-sub">10×10 ｜ エクストリームリバーシ</p>
    </div>
  )
}
