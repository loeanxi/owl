[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('qq-music', 'netease-music')]
  [string]$Player,

  [Parameter()]
  [int]$IntervalMs = 50,

  [Parameter()]
  [int]$Bands = 24,

  [Parameter()]
  [int]$IdleExitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-MeterLine([string]$line) {
  # The TypeScript consumer reads this pipe as UTF-8; write raw bytes so the
  # active code page can never re-encode the stream (same as the media bridge).
  $bytes = $Utf8NoBom.GetBytes($line + [Environment]::NewLine)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

# Keep in sync with the $Players table in windows-media-session.ps1: these are
# the process names that may own the player's Core Audio render sessions.
$meterPlayers = @{
  'qq-music' = @('QQMusic')
  'netease-music' = @('cloudmusic', 'cloudmusic2')
}

try {
  if ($null -eq ('DshMediaBridge.Windows.ProcessLoopbackMeter' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-process-loopback.cs')
  }
  $processNames = $meterPlayers[$Player]
  if ($null -eq $processNames) {
    throw "Unsupported player: $Player"
  }
  [DshMediaBridge.Windows.ProcessLoopbackMeter]::Run($processNames, $IntervalMs, $Bands, $IdleExitSeconds, { param($line) Write-MeterLine $line }) | Out-Null
} catch {
  $code = 'PROCESS_CAPTURE_FAILED'
  if ($_.Exception -is [System.NotSupportedException]) {
    $code = 'PROCESS_LOOPBACK_UNSUPPORTED'
  }
  $payload = @{ error = @{ code = $code; message = $_.Exception.Message } }
  Write-MeterLine ($payload | ConvertTo-Json -Compress -Depth 5)
  exit 1
}
