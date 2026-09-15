/**
 * CLI の引数解析。
 *
 * `--key=value` を取りこぼして既定値で長時間走らせた事故があったので、
 * 両方の書き方を受け、かつ読まれなかったフラグがあれば止める。
 */

export type Args = {
  positional: string[]
  flags: Map<string, string | true>
  /** 読まれたキー。綴り間違いを黙って既定値にしないため */
  read: Set<string>
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    // --key=value と --key value の両方を受ける
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags.set(body, next)
      i += 1
    } else {
      flags.set(body, true)
    }
  }
  return { positional, flags, read: new Set() }
}

export function raw(args: Args, key: string): string | true | undefined {
  args.read.add(key)
  return args.flags.get(key)
}

export function num(args: Args, key: string, fallback: number): number {
  const value = raw(args, key)
  if (value === undefined || value === true) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`)
  return parsed
}

export function str(args: Args, key: string, fallback: string): string {
  const value = raw(args, key)
  if (value === undefined || value === true) return fallback
  return value
}

export function flag(args: Args, key: string): boolean {
  args.read.add(key)
  return args.flags.has(key)
}

/** 使われなかったフラグがあれば止める（既定値で走ってしまうのを防ぐ） */
export function assertAllFlagsUsed(args: Args): void {
  const unknown = [...args.flags.keys()].filter((key) => !args.read.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `知らないオプション: ${unknown.map((k) => `--${k}`).join(' ')}\n` +
        '（綴り間違いを既定値で走らせないため、ここで止めています）',
    )
  }
}
