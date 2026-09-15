import { useState } from 'react'
import { CPU_OPTIONS, resolveCpuType, type CpuTypeId } from '../cpu/index.ts'
import { BrandLockup } from './BrandLockup.tsx'
import './TitleScreen.css'

type TitleScreenProps = {
  initialCpuType: CpuTypeId
  canStart: boolean
  onStart: (options: { cpuType: CpuTypeId }) => void
  onUiSound?: () => void
}

export function TitleScreen({
  initialCpuType,
  canStart,
  onStart,
  onUiSound,
}: TitleScreenProps) {
  const [cpuType, setCpuType] = useState<CpuTypeId>(
    resolveCpuType(initialCpuType),
  )

  return (
    <section className="title-screen">
      <BrandLockup />
      <p className="lead">
        相手の手番を待たず、ゲージが回復したら石を置けます
      </p>

      <fieldset className="cpu-select">
        <legend>CPUの選択</legend>
        {CPU_OPTIONS.map((option) => (
          <label key={option.id} className="option">
            <input
              type="radio"
              name="cpuType"
              value={option.id}
              checked={cpuType === option.id}
              onChange={() => {
                onUiSound?.()
                setCpuType(option.id)
              }}
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      {!canStart ? (
        <p className="lives-empty-note">
          ライフがありません。日付が変わると復活します
        </p>
      ) : null}

      <button
        type="button"
        className="primary"
        disabled={!canStart}
        onClick={() => {
          if (!canStart) return
          onUiSound?.()
          onStart({ cpuType })
        }}
      >
        開始
      </button>
    </section>
  )
}
