import { createInterface } from 'node:readline'
import { GAME_CONFIG } from '../game/config.ts'
import {
  createLearnerSession,
  packLearnerState,
  stepLearner,
  type LearnerSession,
} from './learnerMatch.ts'

type Incoming =
  | { id: number; cmd: 'ping' }
  | {
      id: number
      cmd: 'reset'
      seed: number
      learnerSide: 'black' | 'white'
      opponent: 'random' | 'max_flip'
      cooldownMs?: number
      thinkDelayMs?: number
      /** 省略時 false（Phase5互換）。true で強制WAIT圧縮 */
      compressForcedWait?: boolean
    }
  | { id: number; cmd: 'step'; action: number }
  | { id: number; cmd: 'close' }
  | { id: number; cmd: 'snapshot' }

type BridgeSession = LearnerSession & {
  compressForcedWait: boolean
}

function logErr(message: string): void {
  process.stderr.write(`${message}\n`)
}

function respond(id: number, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, ok: true, ...payload })}\n`)
}

function respondError(id: number, error: string): void {
  process.stdout.write(`${JSON.stringify({ id, ok: false, error })}\n`)
}

async function main(): Promise<void> {
  let session: BridgeSession | null = null
  let closing = false
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  const shutdown = () => {
    if (closing) return
    closing = true
    session = null
    rl.close()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  logErr('[rl-bridge] ready')

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let msg: Incoming
    try {
      msg = JSON.parse(trimmed) as Incoming
    } catch {
      logErr(`[rl-bridge] invalid json: ${trimmed.slice(0, 200)}`)
      continue
    }

    try {
      if (msg.cmd === 'ping') {
        respond(msg.id, { pong: true })
        continue
      }
      if (msg.cmd === 'close') {
        respond(msg.id, { closed: true })
        shutdown()
        break
      }
      if (msg.cmd === 'snapshot') {
        if (!session) {
          respond(msg.id, {
            observation: null,
            actionMask: null,
            terminated: true,
            truncated: false,
            reward: 0,
            info: { error: 'no_session' },
          })
        } else {
          respond(msg.id, packLearnerState(session))
        }
        continue
      }

      if (msg.cmd === 'reset') {
        if (msg.learnerSide !== 'black' && msg.learnerSide !== 'white') {
          respondError(msg.id, 'invalid_learnerSide')
          continue
        }
        if (msg.opponent !== 'random' && msg.opponent !== 'max_flip') {
          respondError(msg.id, 'invalid_opponent')
          continue
        }
        const base = createLearnerSession({
          seed: msg.seed,
          learnerSide: msg.learnerSide,
          opponent: msg.opponent,
          cooldownMs: msg.cooldownMs ?? GAME_CONFIG.cooldownMs,
          thinkDelayMs: msg.thinkDelayMs ?? GAME_CONFIG.cpuThinkDelayMs,
        })
        session = {
          ...base,
          compressForcedWait: Boolean(msg.compressForcedWait),
        }
        const packed = packLearnerState(session)
        respond(msg.id, {
          ...packed,
          reward: 0,
          internalSteps: 0,
          advancedMs: 0,
          forcedWaitAutoSteps: 0,
          info: {
            ...packed.info,
            compressForcedWait: session.compressForcedWait,
          },
        })
        continue
      }

      if (msg.cmd === 'step') {
        if (!session) {
          respondError(msg.id, 'not_reset')
          continue
        }
        if (session.env.isTerminated() || session.env.isTruncated()) {
          respondError(msg.id, 'episode_ended')
          continue
        }
        const result = stepLearner(session, Number(msg.action), {
          compressForcedWait: session.compressForcedWait,
        })
        respond(msg.id, result)
        continue
      }

      respondError((msg as { id: number }).id, 'unknown_cmd')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logErr(`[rl-bridge] error: ${message}`)
      respondError((msg as { id: number }).id, message)
    }
  }
}

main().catch((err) => {
  logErr(
    `[rl-bridge] fatal: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exitCode = 1
})
