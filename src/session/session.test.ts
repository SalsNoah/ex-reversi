import { describe, expect, it } from 'vitest'
import {
  countStones,
  createEmptyBoard,
  createRng,
  GAME_CONFIG,
  listLegalMoves,
} from '../game/index.ts'
import {
  abortPausedSession,
  advanceSession,
  createTitleSession,
  pauseSession,
  queuePlayerMove,
  rematchSameSettings,
  resumeSession,
  startCountdown,
  stepSession,
} from './index.ts'

describe('セッション / CPU判断待ち', () => {
  it('CPUは着手可能から判断待ちのあとで着手する', () => {
    let session = startCountdown({
      seed: 11,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(11)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    expect(session.screen).toBe('playing')
    expect(session.match?.elapsedMs).toBe(0)
    expect(listLegalMoves(session.match!.board, 'white').length).toBeGreaterThan(
      0,
    )

    session = advanceSession(
      session,
      rng,
      GAME_CONFIG.cpuThinkDelayMs - GAME_CONFIG.stepMs,
    )
    expect(session.match?.cooldowns.white).toBe(0)
    expect(session.match?.elapsedMs).toBe(
      GAME_CONFIG.cpuThinkDelayMs - GAME_CONFIG.stepMs,
    )

    session = advanceSession(session, rng, GAME_CONFIG.stepMs)
    expect(session.match!.cooldowns.white).toBeGreaterThan(0)
  })

  it('停止中はCPUの判断待ちも試合時間も進まない', () => {
    let session = startCountdown({
      seed: 12,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(12)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = advanceSession(session, rng, 100)
    session = pauseSession(session)

    const think = session.cpuThinkRemainingMs
    const elapsed = session.match!.elapsedMs
    session = advanceSession(session, rng, 2000)
    expect(session.match!.phase).toBe('paused')
    expect(session.cpuThinkRemainingMs).toBe(think)
    expect(session.match!.elapsedMs).toBe(elapsed)

    session = resumeSession(session)
    expect(session.match!.phase).toBe('playing')
    expect(session.pendingPlayerMove).toBeNull()
  })

  it('一時停止中の中断は開始画面に戻り結果にはしない', () => {
    let session = startCountdown({
      seed: 16,
      cooldownMs: 700,
      cpuType: 'max_flip',
    })
    const rng = createRng(16)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = queuePlayerMove(
      session,
      listLegalMoves(session.match!.board, 'black')[0]!,
    )
    session = stepSession(session, rng).session
    session = pauseSession(session)
    expect(session.match!.phase).toBe('paused')

    const paused = session
    session = abortPausedSession(paused)
    expect(session.screen).toBe('title')
    expect(session.match).toBeNull()
    expect(session.pendingPlayerMove).toBeNull()
    expect(session.lastMove).toBeNull()
    expect(session.settings.cpuType).toBe('max_flip')
    expect(session.settings.cooldownMs).toBe(700)
    expect(session.settings.seed).toBe(16)

    const afterAbort = stepSession(session, rng).session
    expect(afterAbort.screen).toBe('title')
    expect(afterAbort.match).toBeNull()
    expect(paused.screen).toBe('playing')
    expect(paused.match!.phase).toBe('paused')
  })

  it('対戦中や結果画面では中断できない', () => {
    let session = startCountdown({
      seed: 18,
      cooldownMs: 700,
      cpuType: 'random',
    })
    const rng = createRng(18)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    const duringPlay = abortPausedSession(session)
    expect(duringPlay).toBe(session)
    expect(duringPlay.screen).toBe('playing')
    expect(duringPlay.match!.phase).toBe('playing')

    session = advanceSession(session, rng, GAME_CONFIG.matchDurationMs + 1000)
    expect(session.screen).toBe('result')
    const fromResult = abortPausedSession(session)
    expect(fromResult).toBe(session)
    expect(fromResult.screen).toBe('result')
  })

  it('試合終了後に着手されない', () => {
    let session = startCountdown({
      seed: 13,
      cooldownMs: 2000,
      cpuType: 'max_flip',
    })
    const rng = createRng(13)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)

    session = advanceSession(session, rng, GAME_CONFIG.matchDurationMs + 1000)
    expect(session.screen).toBe('result')
    expect(session.match!.phase).toBe('finished')

    const board = session.match!.board.map((r) => r.slice())
    session = queuePlayerMove(session, { row: 2, col: 3 })
    session = stepSession(session, rng).session
    expect(session.match!.board).toEqual(board)
  })

  it('再戦時に前の試合の処理が残らない', () => {
    let session = startCountdown({
      seed: 14,
      cooldownMs: 2000,
      cpuType: 'random',
    })
    const rng = createRng(14)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = queuePlayerMove(
      session,
      listLegalMoves(session.match!.board, 'black')[0]!,
    )
    session = advanceSession(session, rng, GAME_CONFIG.cpuThinkDelayMs + 200)
    expect(session.lastMove).not.toBeNull()
    expect(session.match!.elapsedMs).toBeGreaterThan(0)

    session = rematchSameSettings(session)
    expect(session.screen).toBe('countdown')
    expect(session.lastMove).toBeNull()
    expect(session.pendingPlayerMove).toBeNull()
    expect(session.cpuThinkRemainingMs).toBeNull()
    expect(session.playerIdleRemainingMs).toBeNull()
    expect(session.cpuIdleRemainingMs).toBeNull()
    expect(session.match!.elapsedMs).toBe(0)
    expect(session.match!.cooldowns).toEqual({ black: 0, white: 0 })
    expect(session.settings.cooldownMs).toBe(2000)
    expect(session.settings.cpuType).toBe('random')
    expect(session.settings.seed).toBe(15)
  })

  it('タイトルから開始できる', () => {
    const title = createTitleSession({
      seed: 1,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    expect(title.screen).toBe('title')
    const started = startCountdown(title.settings)
    expect(started.screen).toBe('countdown')
    expect(started.match).not.toBeNull()
  })

  it('盤面が変わるとCPU判断待ちをやり直す', () => {
    let session = startCountdown({
      seed: 21,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(21)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = advanceSession(session, rng, 150)
    expect(session.cpuThinkRemainingMs).not.toBeNull()
    const signatureBefore = session.cpuThinkSignature

    const move = listLegalMoves(session.match!.board, 'black')[0]!
    session = queuePlayerMove(session, move)
    session = stepSession(session, rng).session
    // 次ステップで署名不一致により判断待ちが再セットされる
    session = stepSession(session, rng).session

    if (session.match!.phase === 'playing' && session.match!.cooldowns.white === 0) {
      expect(session.cpuThinkSignature).not.toBe(signatureBefore)
      expect(session.cpuThinkRemainingMs).not.toBeNull()
      expect(session.cpuThinkRemainingMs!).toBeGreaterThan(
        GAME_CONFIG.cpuThinkDelayMs - GAME_CONFIG.stepMs * 3,
      )
    }
  })

  it('待ち時間中のプレイヤー入力は捨てられ自動実行されない', () => {
    let session = startCountdown({
      seed: 22,
      cooldownMs: 2000,
      cpuType: 'random',
    })
    const rng = createRng(22)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    const first = listLegalMoves(session.match!.board, 'black')[0]!
    session = queuePlayerMove(session, first)
    session = stepSession(session, rng).session
    expect(session.match!.cooldowns.black).toBeGreaterThan(0)

    const second = listLegalMoves(session.match!.board, 'black')[0]
    if (second) {
      session = queuePlayerMove(session, second)
      session = stepSession(session, rng).session
    }

    let steps = 0
    while (session.match!.cooldowns.black > 0 && steps < 80) {
      session = stepSession(session, rng).session
      steps += 1
    }
    expect(session.match!.cooldowns.black).toBe(0)
    expect(session.pendingPlayerMove).toBeNull()
  })

  it('制限時間到達の通常進行で結果になり再戦で初期配置へ戻る', () => {
    let session = startCountdown({
      seed: 23,
      cooldownMs: 2000,
      cpuType: 'max_flip',
    })
    const rng = createRng(23)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)

    let guard = 0
    while (session.screen !== 'result' && guard < 4500) {
      if (
        session.screen === 'playing' &&
        session.match?.phase === 'playing' &&
        session.match.cooldowns.black === 0
      ) {
        const moves = listLegalMoves(session.match.board, 'black')
        if (moves[0]) {
          session = queuePlayerMove(session, moves[0])
        }
      }
      session = stepSession(session, rng).session
      guard += 1
    }

    expect(session.screen).toBe('result')
    expect(session.match!.phase).toBe('finished')
    expect(session.match!.endReason).not.toBeNull()
    expect(session.match!.outcome).not.toBeNull()
    expect(session.settings.cpuType).toBe('max_flip')
    expect(session.settings.cooldownMs).toBe(2000)

    const finishedBoard = session.match!.board.map((r) => r.slice())
    session = queuePlayerMove(session, { row: 0, col: 0 })
    session = stepSession(session, rng).session
    expect(session.match!.board).toEqual(finishedBoard)

    session = rematchSameSettings(session)
    expect(session.screen).toBe('countdown')
    expect(session.settings.cpuType).toBe('max_flip')
    expect(session.settings.cooldownMs).toBe(2000)
    expect(session.match!.elapsedMs).toBe(0)
    expect(session.match!.cooldowns).toEqual({ black: 0, white: 0 })
    expect(session.cpuThinkRemainingMs).toBeNull()
    expect(session.playerIdleRemainingMs).toBeNull()
    expect(session.cpuIdleRemainingMs).toBeNull()
    expect(session.pendingPlayerMove).toBeNull()
    expect(session.lastMove).toBeNull()
    expect(countStones(session.match!.board)).toEqual({
      black: 8,
      white: 8,
      empty: 84,
    })
  })
})

function freezeCpu(session: ReturnType<typeof startCountdown>) {
  return {
    ...session,
    match: {
      ...session.match!,
      cooldowns: {
        ...session.match!.cooldowns,
        white: 1_000_000,
      },
    },
  }
}

/** 白だけが (0,0) に置ける。黒は合法手なし。 */
function boardWhiteOnlyMove() {
  const board = createEmptyBoard()
  for (let r = 0; r < 10; r += 1) {
    for (let c = 0; c < 10; c += 1) {
      board[r]![c] = 'white' as const
    }
  }
  board[0]![0] = null
  board[0]![1] = 'black'
  return board
}

function freezePlayer(session: ReturnType<typeof startCountdown>) {
  return {
    ...session,
    match: {
      ...session.match!,
      cooldowns: {
        ...session.match!.cooldowns,
        black: 1_000_000,
      },
    },
  }
}

describe('セッション / 無操作の自動着手', () => {
  it('カウントダウン中は計測せず、着手可能なら3秒後にランダム着手する', () => {
    let session = startCountdown({
      seed: 41,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(41)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    expect(session.screen).toBe('playing')
    expect(session.playerIdleRemainingMs).toBeNull()
    expect(session.cpuIdleRemainingMs).toBeNull()

    session = freezeCpu(session)
    session = advanceSession(
      session,
      rng,
      GAME_CONFIG.idleAutoMoveMs - GAME_CONFIG.stepMs,
    )
    expect(session.match!.cooldowns.black).toBe(0)
    expect(session.playerIdleRemainingMs).toBe(GAME_CONFIG.stepMs)

    session = advanceSession(session, rng, GAME_CONFIG.stepMs)
    expect(session.match!.cooldowns.black).toBeGreaterThan(0)
    expect(session.playerIdleRemainingMs).toBeNull()
  })

  it('同じシードなら自動着手の位置が一致する', () => {
    const run = (seed: number) => {
      let session = startCountdown({
        seed,
        cooldownMs: 3000,
        cpuType: 'random',
      })
      const rng = createRng(seed)
      session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
      session = freezeCpu(session)
      session = advanceSession(
        session,
        rng,
        GAME_CONFIG.idleAutoMoveMs,
      )
      return session.match!.board
    }

    expect(run(42)).toEqual(run(42))
  })

  it('同じステップのプレイヤー入力は自動着手より優先する', () => {
    let session = startCountdown({
      seed: 43,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(43)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = freezeCpu(session)
    session = advanceSession(
      session,
      rng,
      GAME_CONFIG.idleAutoMoveMs - GAME_CONFIG.stepMs,
    )
    const chosen = listLegalMoves(session.match!.board, 'black')[0]!
    session = queuePlayerMove(session, chosen)
    session = stepSession(session, rng).session
    expect(session.match!.board[chosen.row]![chosen.col]).toBe('black')
    expect(session.match!.cooldowns.black).toBeGreaterThan(0)
  })

  it('待ち時間中は計測せず、再び着手可能になってから数え直す', () => {
    let session = startCountdown({
      seed: 44,
      cooldownMs: 2000,
      cpuType: 'random',
    })
    const rng = createRng(44)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = freezeCpu(session)
    const first = listLegalMoves(session.match!.board, 'black')[0]!
    session = queuePlayerMove(session, first)
    session = stepSession(session, rng).session
    expect(session.match!.cooldowns.black).toBeGreaterThan(0)
    expect(session.playerIdleRemainingMs).toBeNull()

    while (session.match!.cooldowns.black > 0) {
      session = stepSession(session, rng).session
    }
    expect(session.playerIdleRemainingMs).toBeNull()

    session = stepSession(session, rng).session
    expect(session.playerIdleRemainingMs).toBe(
      GAME_CONFIG.idleAutoMoveMs - GAME_CONFIG.stepMs,
    )
  })

  it('一時停止中は無操作タイマーも進まない', () => {
    let session = startCountdown({
      seed: 45,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(45)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = freezeCpu(session)
    session = advanceSession(session, rng, 2000)
    const idle = session.playerIdleRemainingMs
    const elapsed = session.match!.elapsedMs
    expect(idle).not.toBeNull()

    session = pauseSession(session)
    session = advanceSession(session, rng, 8000)
    expect(session.playerIdleRemainingMs).toBe(idle)
    expect(session.match!.elapsedMs).toBe(elapsed)
    expect(session.match!.cooldowns.black).toBe(0)
  })

  it('CPUの着手では無操作タイマーをリセットしない', () => {
    let session = startCountdown({
      seed: 46,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(46)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = advanceSession(session, rng, GAME_CONFIG.cpuThinkDelayMs)
    expect(session.match!.cooldowns.white).toBeGreaterThan(0)
    expect(session.cpuIdleRemainingMs).toBeNull()
    expect(session.playerIdleRemainingMs).not.toBeNull()
    expect(session.playerIdleRemainingMs!).toBeLessThanOrEqual(
      GAME_CONFIG.idleAutoMoveMs - GAME_CONFIG.cpuThinkDelayMs,
    )
    expect(session.playerIdleRemainingMs!).toBeGreaterThan(
      GAME_CONFIG.idleAutoMoveMs - GAME_CONFIG.cpuThinkDelayMs - 200,
    )
  })

  it('合法手がない間は計測しない', () => {
    let session = startCountdown({
      seed: 47,
      cooldownMs: 3000,
      cpuType: 'random',
    })
    const rng = createRng(47)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = freezeCpu(session)
    session = {
      ...session,
      match: {
        ...session.match!,
        board: boardWhiteOnlyMove(),
        cooldowns: {
          black: 0,
          white: 1_000_000,
        },
      },
    }
    expect(listLegalMoves(session.match!.board, 'black')).toHaveLength(0)
    session = advanceSession(session, rng, GAME_CONFIG.idleAutoMoveMs)
    expect(session.screen).toBe('playing')
    expect(session.match!.cooldowns.black).toBe(0)
    expect(session.playerIdleRemainingMs).toBeNull()
    expect(session.cpuIdleRemainingMs).toBeNull()
  })

  it('CPUが待機し続けても3秒後にランダム着手する', () => {
    let session = startCountdown({
      seed: 48,
      cooldownMs: 3000,
      cpuType: 'wait',
    })
    const rng = createRng(48)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = freezePlayer(session)
    expect(session.cpuIdleRemainingMs).toBeNull()

    session = advanceSession(
      session,
      rng,
      GAME_CONFIG.idleAutoMoveMs - GAME_CONFIG.stepMs,
    )
    expect(session.match!.cooldowns.white).toBe(0)
    expect(session.cpuIdleRemainingMs).toBe(GAME_CONFIG.stepMs)

    session = advanceSession(session, rng, GAME_CONFIG.stepMs)
    expect(session.match!.cooldowns.white).toBeGreaterThan(0)
    expect(session.cpuIdleRemainingMs).toBeNull()
  })

  it('プレイヤーの着手ではCPUの無操作タイマーをリセットしない', () => {
    let session = startCountdown({
      seed: 49,
      cooldownMs: 3000,
      cpuType: 'wait',
    })
    const rng = createRng(49)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = advanceSession(session, rng, 200)
    expect(session.cpuIdleRemainingMs).not.toBeNull()
    const cpuIdleBefore = session.cpuIdleRemainingMs!

    const move = listLegalMoves(session.match!.board, 'black')[0]!
    session = queuePlayerMove(session, move)
    session = stepSession(session, rng).session
    expect(session.match!.cooldowns.black).toBeGreaterThan(0)
    expect(session.cpuIdleRemainingMs).not.toBeNull()
    expect(session.cpuIdleRemainingMs!).toBeLessThan(cpuIdleBefore)
    expect(session.cpuIdleRemainingMs!).toBeGreaterThan(
      GAME_CONFIG.idleAutoMoveMs - 400,
    )
  })

  it('双方の無操作タイマーは独立して進む', () => {
    let session = startCountdown({
      seed: 50,
      cooldownMs: 3000,
      cpuType: 'wait',
    })
    const rng = createRng(50)
    session = advanceSession(session, rng, GAME_CONFIG.countdownMs)
    session = advanceSession(session, rng, 1000)
    expect(session.playerIdleRemainingMs).toBe(
      GAME_CONFIG.idleAutoMoveMs - 1000,
    )
    expect(session.cpuIdleRemainingMs).toBe(
      GAME_CONFIG.idleAutoMoveMs - 1000,
    )
  })
})

