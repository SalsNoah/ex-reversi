import {
  getTrack,
  getTrackEvents,
  midiToFreq,
  STEPS_PER_BAR,
  stepDurationSec,
  type ScheduledEvent,
  type TrackId,
} from './tracks.ts'
import type { BgmCue, BgmStage } from './cue.ts'
import { SFX_PATCHES, type SfxId } from './sfx.ts'

const MASTER_GAIN = 0.26
const SFX_MASTER_GAIN = 0.78
const LOOKAHEAD_SEC = 0.22
const TICK_MS = 40

export class BgmEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private leadBus: GainNode | null = null
  private leadDuck: GainNode | null = null
  private bassBus: GainNode | null = null
  private padBus: GainNode | null = null
  private drumBus: GainNode | null = null
  private hatPan: StereoPannerNode | null = null
  private sfxGain: GainNode | null = null
  private stageFilter: BiquadFilterNode | null = null
  private delay: DelayNode | null = null
  private delayFeedback: GainNode | null = null
  private delayWet: GainNode | null = null
  private noise: AudioBuffer | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private track: TrackId | null = null
  private stage: BgmStage = 'normal'
  private muted = false
  private paused = false
  private stepCursor = 0
  private nextStepTime = 0
  private disposed = false
  private tickBus: GainNode | null = null
  private lastSfxAt = new Map<string, number>()
  private activeGains = new Set<GainNode>()
  onStateChange: ((running: boolean) => void) | null = null

  get unlocked(): boolean {
    return this.ctx?.state === 'running'
  }

  unlock(): void {
    if (this.disposed) return
    this.ensureContext()
    if (!this.ctx) return
    void this.ctx.resume()
    this.startTimer()
    this.onStateChange?.(this.unlocked)
  }

  setCue(cue: BgmCue): void {
    if (this.disposed) return
    this.ensureContext()
    const trackChanged = cue.track !== this.track
    const stageChanged = cue.stage !== this.stage
    this.track = cue.track
    this.paused = cue.paused
    this.stage = cue.stage

    if (trackChanged && this.ctx && this.master) {
      const now = this.ctx.currentTime
      for (const g of this.activeGains) {
        g.gain.cancelScheduledValues(now)
        g.gain.setValueAtTime(g.gain.value, now)
        g.gain.linearRampToValueAtTime(0.0001, now + 0.1)
      }
      this.activeGains.clear()
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.linearRampToValueAtTime(0, now + 0.14)
      this.stepCursor = cue.stage === 'countdown' ? 14 * STEPS_PER_BAR : 0
      this.nextStepTime = now + 0.2
      this.master.gain.linearRampToValueAtTime(
        this.muted || this.paused || !this.track ? 0 : MASTER_GAIN,
        now + 0.5,
      )
      this.applyDelayForTrack(this.track)
    } else {
      this.applyMaster()
    }

    if (stageChanged || trackChanged) this.applyStage()
    this.startTimer()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyMaster()
    this.applySfxGain()
    this.startTimer()
  }

  playSfx(id: SfxId): void {
    if (this.disposed || this.muted) return
    this.unlock()
    const ctx = this.ctx
    if (!ctx || !this.sfxGain) return
    const fire = () => {
      if (this.disposed || this.muted || !this.ctx || !this.sfxGain) return
      const time = this.ctx.currentTime + 0.001
      const key = id === 'ui' ? 'ui' : 'place'
      const prev = this.lastSfxAt.get(key) ?? -1
      if (time - prev < 0.055) return
      const scale = time - prev < 0.11 ? 0.6 : 1
      this.lastSfxAt.set(key, time)
      this.duckLead(time)
      this.playSoftSfx(time, id, scale)
    }
    if (ctx.state === 'running') {
      fire()
      return
    }
    void ctx.resume().then(fire)
  }

  dispose(): void {
    this.disposed = true
    this.stopTimer()
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
    this.master = null
    this.leadBus = null
    this.leadDuck = null
    this.bassBus = null
    this.padBus = null
    this.drumBus = null
    this.hatPan = null
    this.sfxGain = null
    this.tickBus = null
    this.stageFilter = null
    this.delay = null
    this.delayFeedback = null
    this.delayWet = null
    this.noise = null
  }

  private ensureContext(): void {
    if (this.ctx || this.disposed) return
    const Ctor =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx
    ctx.addEventListener('statechange', () => {
      this.onStateChange?.(ctx.state === 'running')
      if (ctx.state === 'running') this.startTimer()
    })

    const master = ctx.createGain()
    master.gain.value = 0
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 42
    highpass.Q.value = 0.7
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -20
    compressor.knee.value = 18
    compressor.ratio.value = 1.8
    compressor.attack.value = 0.006
    compressor.release.value = 0.25
    const stageFilter = ctx.createBiquadFilter()
    stageFilter.type = 'lowpass'
    stageFilter.frequency.value = 14000
    stageFilter.Q.value = 0.7
    this.stageFilter = stageFilter

    master.connect(highpass)
    highpass.connect(stageFilter)
    stageFilter.connect(compressor)
    compressor.connect(ctx.destination)
    this.master = master

    const sfxGain = ctx.createGain()
    sfxGain.gain.value = SFX_MASTER_GAIN
    const sfxLimiter = ctx.createDynamicsCompressor()
    sfxLimiter.threshold.value = -12
    sfxLimiter.knee.value = 8
    sfxLimiter.ratio.value = 4
    sfxLimiter.attack.value = 0.002
    sfxLimiter.release.value = 0.08
    sfxGain.connect(sfxLimiter)
    sfxLimiter.connect(ctx.destination)
    this.sfxGain = sfxGain

    this.tickBus = ctx.createGain()
    this.tickBus.gain.value = 0.5
    this.tickBus.connect(compressor)

    this.bassBus = ctx.createGain()
    this.bassBus.gain.value = 0.92
    this.bassBus.connect(master)

    this.drumBus = ctx.createGain()
    this.drumBus.gain.value = 0.85
    this.drumBus.connect(master)

    this.hatPan = ctx.createStereoPanner()
    this.hatPan.pan.value = 0.22
    this.hatPan.connect(this.drumBus)

    const padPan = ctx.createStereoPanner()
    padPan.pan.value = -0.3
    this.padBus = ctx.createGain()
    this.padBus.gain.value = 0.95
    this.padBus.connect(padPan)
    padPan.connect(master)

    const motifPan = ctx.createStereoPanner()
    motifPan.pan.value = 0.28
    this.leadDuck = ctx.createGain()
    this.leadDuck.gain.value = 1
    this.leadBus = ctx.createGain()
    this.leadBus.gain.value = 0.95
    this.leadBus.connect(this.leadDuck)
    this.leadDuck.connect(motifPan)
    motifPan.connect(master)

    const delay = ctx.createDelay(1)
    delay.delayTime.value = 0.26
    const feedback = ctx.createGain()
    feedback.gain.value = 0.22
    const wet = ctx.createGain()
    wet.gain.value = 0.22
    const wetFilter = ctx.createBiquadFilter()
    wetFilter.type = 'lowpass'
    wetFilter.frequency.value = 1800
    this.leadDuck.connect(delay)
    delay.connect(feedback)
    feedback.connect(delay)
    delay.connect(wetFilter)
    wetFilter.connect(wet)
    wet.connect(master)
    this.delay = delay
    this.delayFeedback = feedback
    this.delayWet = wet

    this.noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1
    }
  }

  private applyMaster(): void {
    if (!this.ctx || !this.master) return
    const silent = this.muted || this.paused || !this.track
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(this.master.gain.value, now)
    this.master.gain.linearRampToValueAtTime(silent ? 0 : MASTER_GAIN, now + 0.08)
  }

  private applySfxGain(): void {
    if (!this.sfxGain) return
    this.sfxGain.gain.value = this.muted ? 0 : SFX_MASTER_GAIN
  }

  private applyDelayForTrack(track: TrackId | null): void {
    if (!this.ctx || !this.delay || !this.delayFeedback || !this.delayWet) return
    if (!track) return
    const bpm = getTrack(track).bpm
    const now = this.ctx.currentTime
    let delayTime = 45 / bpm
    let feedback = 0.24
    let wet = 0.26
    if (track === 'battle') {
      delayTime = 15 / bpm
      feedback = 0.24
      wet = 0.14
    } else if (track === 'select') {
      delayTime = 45 / bpm
      feedback = 0.26
      wet = 0.3
    }
    this.delay.delayTime.cancelScheduledValues(now)
    this.delay.delayTime.setValueAtTime(this.delay.delayTime.value, now)
    this.delay.delayTime.linearRampToValueAtTime(delayTime, now + 0.05)
    this.delayFeedback.gain.setValueAtTime(feedback, now)
    this.delayWet.gain.setValueAtTime(wet, now)
  }

  private applyStage(): void {
    if (!this.ctx || !this.stageFilter || !this.drumBus) return
    const now = this.ctx.currentTime
    if (this.stage === 'countdown') {
      this.stageFilter.frequency.cancelScheduledValues(now)
      this.stageFilter.frequency.setValueAtTime(
        this.stageFilter.frequency.value,
        now,
      )
      this.stageFilter.frequency.exponentialRampToValueAtTime(1250, now + 0.18)
      this.drumBus.gain.cancelScheduledValues(now)
      this.drumBus.gain.setValueAtTime(this.drumBus.gain.value, now)
      this.drumBus.gain.linearRampToValueAtTime(0.42, now + 0.18)
      return
    }
    this.stageFilter.frequency.cancelScheduledValues(now)
    this.stageFilter.frequency.setValueAtTime(
      this.stageFilter.frequency.value,
      now,
    )
    const bpm = getTrack(this.track!).bpm
    const stepDur = stepDurationSec(bpm)
    const stepsToBar = STEPS_PER_BAR - (this.stepCursor % STEPS_PER_BAR)
    const target = Math.max(
      now + 0.12,
      this.nextStepTime + stepsToBar * stepDur,
    )
    this.stageFilter.frequency.exponentialRampToValueAtTime(14000, target)
    this.drumBus.gain.cancelScheduledValues(now)
    this.drumBus.gain.setValueAtTime(this.drumBus.gain.value, now)
    this.drumBus.gain.linearRampToValueAtTime(0.85, target)
  }

  private duckLead(time: number): void {
    if (!this.leadDuck) return
    this.leadDuck.gain.cancelScheduledValues(time)
    this.leadDuck.gain.setValueAtTime(this.leadDuck.gain.value, time)
    this.leadDuck.gain.linearRampToValueAtTime(0.72, time + 0.02)
    this.leadDuck.gain.linearRampToValueAtTime(1, time + 0.2)
  }

  private shouldRun(): boolean {
    return (
      !this.disposed &&
      !this.muted &&
      !this.paused &&
      this.track !== null &&
      this.ctx?.state === 'running'
    )
  }

  private startTimer(): void {
    if (this.timer !== null || !this.shouldRun() || !this.ctx) return
    this.nextStepTime = Math.max(this.nextStepTime, this.ctx.currentTime + 0.03)
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    if (!this.shouldRun()) {
      this.stopTimer()
      return
    }
    const ctx = this.ctx
    const trackId = this.track
    if (!ctx || !trackId) return

    const spec = getTrack(trackId)
    const events = getTrackEvents(trackId)
    const stepDur = stepDurationSec(spec.bpm)
    const total = spec.bars * STEPS_PER_BAR
    const intro = (spec.introBars ?? 0) * STEPS_PER_BAR
    const ahead = ctx.currentTime + LOOKAHEAD_SEC

    if (this.nextStepTime < ctx.currentTime - 0.08) {
      this.nextStepTime = ctx.currentTime
    }

    while (this.nextStepTime < ahead) {
      const loopStep =
        this.stepCursor < intro
          ? this.stepCursor
          : intro + ((this.stepCursor - intro) % Math.max(1, total - intro))
      for (const event of events) {
        if (event.step === loopStep) {
          this.play(event, this.nextStepTime, stepDur)
        }
      }
      if (this.stage === 'countdown' && loopStep % 8 === 0) {
        this.playCountTick(this.nextStepTime)
      }
      this.stepCursor += 1
      this.nextStepTime += stepDur
    }
  }

  private playCountTick(time: number): void {
    const ctx = this.ctx
    if (!ctx || !this.tickBus) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(1480, time)
    gain.gain.setValueAtTime(0.055, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05)
    osc.connect(gain)
    gain.connect(this.tickBus)
    this.trackGain(gain)
    osc.start(time)
    osc.stop(time + 0.06)
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
      this.activeGains.delete(gain)
    }
  }

  private play(event: ScheduledEvent, time: number, stepDur: number): void {
    if (event.kind === 'tone') {
      this.playTone(event, time, stepDur)
      return
    }
    if (event.kind === 'kick') this.playKick(time, event.gain)
    else if (event.kind === 'snare') this.playSnare(time, event.gain)
    else this.playHat(time, event.gain)
  }

  private busFor(bus: 'bass' | 'lead' | 'pad'): GainNode | null {
    if (bus === 'bass') return this.bassBus
    if (bus === 'pad') return this.padBus
    return this.leadBus
  }

  private playTone(
    event: Extract<ScheduledEvent, { kind: 'tone' }>,
    time: number,
    stepDur: number,
  ): void {
    const ctx = this.ctx
    const dest = this.busFor(event.bus)
    if (!ctx || !dest) return

    const voices =
      event.wave === 'triangle' && event.bus === 'lead'
        ? [-7, 7]
        : [0]
    const voiceGain =
      voices.length > 1 ? event.gain * 0.56 : event.gain

    for (const cents of voices) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = event.wave
      osc.frequency.setValueAtTime(midiToFreq(event.midi), time)
      if (cents !== 0) osc.detune.setValueAtTime(cents, time)

      const dur = Math.max(0.08, event.durSteps * stepDur)
      const peak = voiceGain
      const isPad = event.bus === 'pad'
      if (isPad) {
        const attack = Math.min(0.35, dur * 0.12)
        const release = Math.min(0.35, dur * 0.15)
        const holdEnd = Math.max(time + attack + 0.05, time + dur - release)
        gain.gain.setValueAtTime(0.0001, time)
        gain.gain.linearRampToValueAtTime(peak, time + attack)
        gain.gain.setValueAtTime(peak, holdEnd)
        gain.gain.exponentialRampToValueAtTime(0.0001, time + dur)
      } else if (event.bus === 'bass') {
        const release = Math.min(0.25, dur * 0.25)
        const holdEnd = Math.max(time + 0.12, time + dur - release)
        gain.gain.setValueAtTime(0.0001, time)
        gain.gain.exponentialRampToValueAtTime(peak, time + 0.012)
        gain.gain.exponentialRampToValueAtTime(peak * 0.78, time + 0.09)
        gain.gain.setValueAtTime(peak * 0.78, holdEnd)
        gain.gain.exponentialRampToValueAtTime(0.0001, time + dur)
      } else {
        gain.gain.setValueAtTime(0.0001, time)
        gain.gain.exponentialRampToValueAtTime(peak, time + 0.006)
        gain.gain.exponentialRampToValueAtTime(
          peak * 0.62,
          time + Math.min(0.12, dur * 0.3),
        )
        gain.gain.exponentialRampToValueAtTime(0.0001, time + dur)
      }

      if (event.wave === 'sawtooth' || event.wave === 'square') {
        const filter = ctx.createBiquadFilter()
        filter.type = 'lowpass'
        filter.Q.value = event.wave === 'sawtooth' ? 3 : 0.6
        if (event.wave === 'sawtooth') {
          filter.frequency.setValueAtTime(820, time)
          filter.frequency.linearRampToValueAtTime(2100, time + 0.045)
          filter.frequency.exponentialRampToValueAtTime(
            1150,
            time + dur * 0.7,
          )
        } else {
          filter.frequency.setValueAtTime(1600, time)
        }
        osc.connect(filter)
        filter.connect(gain)
      } else {
        osc.connect(gain)
      }
      gain.connect(dest)
      this.trackGain(gain)
      osc.start(time)
      osc.stop(time + dur + 0.03)
      osc.onended = () => {
        osc.disconnect()
        gain.disconnect()
        this.activeGains.delete(gain)
      }
    }
  }

  private trackGain(gain: GainNode): void {
    this.activeGains.add(gain)
  }

  private playKick(time: number, gainValue: number): void {
    const ctx = this.ctx
    if (!ctx || !this.drumBus) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(190, time)
    osc.frequency.exponentialRampToValueAtTime(55, time + 0.09)
    gain.gain.setValueAtTime(gainValue, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16)
    osc.connect(gain)
    gain.connect(this.drumBus)
    this.trackGain(gain)
    osc.start(time)
    osc.stop(time + 0.18)
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
      this.activeGains.delete(gain)
    }

    const click = ctx.createOscillator()
    const clickGain = ctx.createGain()
    click.type = 'triangle'
    click.frequency.setValueAtTime(900, time)
    clickGain.gain.setValueAtTime(gainValue * 0.45, time)
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.014)
    click.connect(clickGain)
    clickGain.connect(this.drumBus)
    click.start(time)
    click.stop(time + 0.02)

    if (this.noise) {
      const noise = ctx.createBufferSource()
      noise.buffer = this.noise
      const filter = ctx.createBiquadFilter()
      filter.type = 'highpass'
      filter.frequency.value = 3000
      filter.Q.value = 0.7
      const nGain = ctx.createGain()
      nGain.gain.setValueAtTime(gainValue * 0.3, time)
      nGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.018)
      noise.connect(filter)
      filter.connect(nGain)
      nGain.connect(this.drumBus)
      noise.start(time, Math.random() * 0.18)
      noise.stop(time + 0.02)
    }
  }

  private playSnare(time: number, gainValue: number): void {
    const ctx = this.ctx
    if (!ctx || !this.drumBus || !this.noise) return
    const noise = ctx.createBufferSource()
    noise.buffer = this.noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 1800
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2600
    bp.Q.value = 1.1
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(gainValue, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12)
    noise.connect(hp)
    hp.connect(bp)
    bp.connect(gain)
    gain.connect(this.drumBus)
    this.trackGain(gain)
    noise.start(time, Math.random() * 0.18)
    noise.stop(time + 0.13)

    const body = ctx.createOscillator()
    const bodyGain = ctx.createGain()
    body.type = 'triangle'
    body.frequency.setValueAtTime(210, time)
    bodyGain.gain.setValueAtTime(gainValue * 0.22, time)
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05)
    body.connect(bodyGain)
    bodyGain.connect(this.drumBus)
    this.trackGain(bodyGain)
    body.start(time)
    body.stop(time + 0.07)
  }

  private playHat(time: number, gainValue: number): void {
    const ctx = this.ctx
    if (!ctx || !this.drumBus || !this.noise || !this.hatPan) return
    const noise = ctx.createBufferSource()
    noise.buffer = this.noise
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 7000
    filter.Q.value = 1.2
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(gainValue, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.028)
    noise.connect(filter)
    filter.connect(gain)
    gain.connect(this.hatPan)
    this.trackGain(gain)
    noise.start(time, Math.random() * 0.18)
    noise.stop(time + 0.035)
  }

  private playSoftSfx(time: number, id: SfxId, scale: number): void {
    const patch = SFX_PATCHES[id]
    const jf = 1 + (Math.random() - 0.5) * 0.02
    const jg = (0.92 + Math.random() * 0.16) * scale
    this.playSoftTone(
      time,
      patch.bodyHz * jf,
      'sine',
      patch.bodyGain * jg,
      patch.durSec * patch.bodyDurScale,
      patch.filterHz,
      patch.attackSec,
      patch.bendRatio,
    )
    this.playSoftTone(
      time,
      patch.partialHz * jf,
      'triangle',
      patch.partialGain * jg,
      patch.durSec * 0.62,
      patch.filterHz,
      patch.attackSec,
      1 + (patch.bendRatio - 1) * 0.5,
    )
    this.playSoftTone(
      time,
      patch.chimeHz * jf,
      'triangle',
      patch.chimeGain * jg,
      patch.durSec * 0.42,
      patch.filterHz,
      patch.attackSec * 0.6,
      1 + (patch.bendRatio - 1) * 0.5,
    )
    this.playTick(time, patch, jg)
    this.playSoftAir(
      time,
      patch.airGain * jg,
      patch.durSec * 0.3,
      patch.airHz,
    )
  }

  private playTick(
    time: number,
    patch: (typeof SFX_PATCHES)[SfxId],
    scale: number,
  ): void {
    const ctx = this.ctx
    if (!ctx || !this.sfxGain || !this.noise) return
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const filter = ctx.createBiquadFilter()
    filter.type = patch.tickMode
    filter.frequency.value = patch.tickHz
    filter.Q.value = patch.tickMode === 'bandpass' ? 1.2 : 0.7
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(patch.tickGain * scale, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + patch.tickDurSec)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(this.sfxGain)
    src.start(time, Math.random() * 0.18)
    src.stop(time + patch.tickDurSec + 0.01)
  }

  private playSoftTone(
    time: number,
    freq: number,
    wave: OscillatorType,
    gainValue: number,
    dur: number,
    filterHz: number,
    attackSec: number,
    bendRatio: number,
  ): void {
    const ctx = this.ctx
    if (!ctx || !this.sfxGain) return
    const osc = ctx.createOscillator()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = wave
    osc.frequency.setValueAtTime(freq, time)
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, freq * bendRatio),
      time + Math.min(0.045, dur * 0.28),
    )
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(filterHz, time)
    filter.Q.value = 0.5
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(gainValue, time + attackSec)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur)
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.sfxGain)
    osc.start(time)
    osc.stop(time + dur + 0.02)
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
    }
  }

  private playSoftAir(
    time: number,
    gainValue: number,
    dur: number,
    airHz: number,
  ): void {
    const ctx = this.ctx
    if (!ctx || !this.sfxGain || !this.noise || gainValue <= 0) return
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = airHz
    filter.Q.value = 0.9
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(gainValue, time + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(this.sfxGain)
    src.start(time, Math.random() * 0.18)
    src.stop(time + dur + 0.02)
  }
}
