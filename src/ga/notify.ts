import { spawn } from 'node:child_process'

export type TrainingNoticeKind =
  | 'current'
  | 'started'
  | 'generation-done'
  | 'finished'

export type TrainingNotice = {
  runId: string
  generation: number
  phase: string
  completedMatches: number
  campaignTarget: number
  chunkEndGeneration: number
  bestScoreRate: number | null
  kind: TrainingNoticeKind
}

const PHASE_LABEL: Record<string, string> = {
  init: '準備',
  primary: '一次評価',
  extra: '追加評価',
  breed: '世代交代',
  done: '完了',
}

export function campaignTargetGenerations(
  runId: string,
  configGenerations: number,
): number {
  if (runId === 'ga1-train-004') return 400
  return Math.max(0, configGenerations - 1)
}

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase
}

export function formatGenerationNotice(notice: TrainingNotice): {
  title: string
  body: string
} {
  const title = 'オセロAI学習'
  const target = notice.campaignTarget
  const phase = phaseLabel(notice.phase)
  const matches = `試合 ${notice.completedMatches}`
  const score =
    notice.bestScoreRate != null
      ? ` 得点率 ${notice.bestScoreRate.toFixed(3)}`
      : ''

  if (notice.kind === 'finished') {
    return {
      title,
      body: `今${notice.generation}世代目が終わった（目標${target}まで完了）\n${matches}${score}`,
    }
  }
  if (notice.kind === 'generation-done') {
    return {
      title,
      body: `今${notice.generation}世代目が終わった（目標${target}）${score}\n${matches}`,
    }
  }
  if (notice.kind === 'started') {
    return {
      title,
      body: `学習を開始／再開\n現在 第${notice.generation}世代（目標${target}） ${phase}\n${matches}`,
    }
  }
  return {
    title,
    body: `現在 第${notice.generation}世代を実行中（目標${target}）\n${phase} / ${matches}`,
  }
}

export function shouldShowDesktopNotify(): boolean {
  if (process.platform !== 'win32') return false
  if (process.env.VITEST) return false
  if (process.env.CI) return false
  if (process.env.GA_NOTIFY === '0') return false
  return true
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toastScript(title: string, body: string): string {
  const t = psSingleQuote(xmlEscape(title))
  const b = psSingleQuote(xmlEscape(body))
  return `
$title = ${t}
$body = ${b}
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $xml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>$title</text>
      <text>$body</text>
    </binding>
  </visual>
</toast>
"@
  $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $doc.LoadXml($xml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('EX.Reversi.GA').Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.Visible = $true
  $n.BalloonTipTitle = $title
  $n.BalloonTipText = $body
  $n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $n.ShowBalloonTip(8000)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 8500) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
  }
  $n.Visible = $false
  $n.Dispose()
}
`
}

export function showDesktopNotify(title: string, body: string): void {
  if (!shouldShowDesktopNotify()) return
  const encoded = Buffer.from(toastScript(title, body), 'utf16le').toString(
    'base64',
  )
  spawn(
    'powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', encoded],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  ).unref()
}

export function notifyTrainingProgress(
  notice: TrainingNotice,
  options?: { log?: boolean; desktop?: boolean },
): void {
  const { title, body } = formatGenerationNotice(notice)
  if (options?.log !== false) {
    process.stderr.write(`[ga] notify ${body.replace(/\n/g, ' | ')}\n`)
  }
  const desktop =
    options?.desktop ??
    (notice.kind === 'generation-done' || notice.kind === 'finished')
  if (!desktop) return
  try {
    showDesktopNotify(title, body)
  } catch {
    /* 学習本体は落とさない */
  }
}
