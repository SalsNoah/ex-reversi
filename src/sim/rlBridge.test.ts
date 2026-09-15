import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { GAME_CONFIG } from '../game/config.ts'
import { createTrainingEnv } from './env.ts'
import { toNormalizedVector } from './observation.ts'
import { WAIT_ACTION } from './constants.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

async function withBridge<T>(
  fn: (send: (msg: object) => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const script = path.join(root, 'src', 'sim', 'rlBridge.ts')
  const child = spawn(process.execPath, [tsxCli, script], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const rl = createInterface({ input: child.stdout! })
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >()

  const reader = (async () => {
    for await (const line of rl) {
      const data = JSON.parse(line) as Record<string, unknown>
      const id = data.id as number
      const wait = pending.get(id)
      if (wait) {
        pending.delete(id)
        if (data.ok) wait.resolve(data)
        else wait.reject(new Error(String(data.error)))
      }
    }
  })()

  const send = (msg: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      child.stdin!.write(`${JSON.stringify({ id, ...msg })}\n`)
    })

  try {
    await send({ cmd: 'ping' })
    return await fn(send)
  } finally {
    try {
      await send({ cmd: 'close' })
    } catch {
      /* ignore */
    }
    child.kill()
    rl.close()
    await Promise.race([reader, new Promise((r) => setTimeout(r, 500))])
  }
}

describe('RL bridge', () => {
  it('reset/step が学習側観測とマスクを返し、直接 env と一致する', async () => {
    await withBridge(async (send) => {
      const res = await send({
        cmd: 'reset',
        seed: 77,
        learnerSide: 'black',
        opponent: 'random',
        cooldownMs: GAME_CONFIG.cooldownMs,
        thinkDelayMs: 0,
      })
      expect(res.observation).toHaveLength(104)
      expect(res.actionMask).toHaveLength(101)

      const direct = createTrainingEnv({
        seed: 77,
        cooldownMs: GAME_CONFIG.cooldownMs,
        blackThinkDelayMs: 0,
        whiteThinkDelayMs: 0,
      })
      expect(res.observation).toEqual(
        toNormalizedVector(direct.getObservation('black')).values,
      )
      expect(res.actionMask).toEqual(direct.getActionMask('black'))

      const stepped = await send({ cmd: 'step', action: WAIT_ACTION })
      direct.step(WAIT_ACTION, WAIT_ACTION)
      // 相手 random・think0 だと白が着手する可能性があるため、
      // WAIT 同士の一致は thinkDelay>0 か相手固定では保証しにくい。
      // ここでは応答形と終了フラグの型だけ確認する。
      expect(typeof stepped.reward).toBe('number')
      expect(typeof stepped.terminated).toBe('boolean')
      expect((stepped.actionMask as boolean[]).length).toBe(101)
    })
  })

  it('双方700ms/500msで学習側だけ短くしない', async () => {
    await withBridge(async (send) => {
      const res = await send({
        cmd: 'reset',
        seed: 1,
        learnerSide: 'white',
        opponent: 'max_flip',
        cooldownMs: 700,
        thinkDelayMs: 500,
      })
      const info = res.info as Record<string, unknown>
      expect(info.cooldownMs).toBe(700)
      expect(info.thinkDelayMs).toBe(500)
      const mask = res.actionMask as boolean[]
      // 開始直後は判断待ち中 → WAIT のみ
      expect(mask[WAIT_ACTION]).toBe(true)
      expect(mask.slice(0, 100).every((v) => !v)).toBe(true)
    })
  })
})
