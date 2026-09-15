import type { Board } from '../game/types.ts'

/** 判断待ちの内部状態（公開観測とは別。デバッグ／制御用） */
export type ThinkGateState = {
  remainingMs: number | null
  signature: string | null
}

export function createIdleThinkGate(): ThinkGateState {
  return { remainingMs: null, signature: null }
}

export function boardSignature(board: Board): string {
  let s = ''
  for (const row of board) {
    for (const cell of row) {
      s += cell === 'black' ? 'b' : cell === 'white' ? 'w' : '.'
    }
  }
  return s
}

/**
 * 1 固定ステップ分の判断待ちを進める。
 * ready=true のステップで着手／WAIT を選べる（delayMs<=0 なら canAct 中は常に ready）。
 */
export function tickThinkGate(
  gate: ThinkGateState,
  options: {
    canAct: boolean
    signature: string
    delayMs: number
    stepMs: number
  },
): { gate: ThinkGateState; ready: boolean } {
  if (!options.canAct) {
    return { gate: createIdleThinkGate(), ready: false }
  }

  if (options.delayMs <= 0) {
    return { gate: createIdleThinkGate(), ready: true }
  }

  let remaining = gate.remainingMs
  if (remaining === null || gate.signature !== options.signature) {
    remaining = options.delayMs
  }
  remaining -= options.stepMs

  if (remaining > 0) {
    return {
      gate: { remainingMs: remaining, signature: options.signature },
      ready: false,
    }
  }

  return { gate: createIdleThinkGate(), ready: true }
}
