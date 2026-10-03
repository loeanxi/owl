[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BridgeScriptPath,

  [Parameter()]
  [int]$OwnerProcessId = 0,

  [Parameter()]
  [double]$OwnerStartedAt = 0
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ResponseComplete = '__DSH_MEDIA_BRIDGE_RESPONSE_COMPLETE__'
[Console]::InputEncoding = $Utf8NoBom
$Leases = @{}
$LeaseOrder = New-Object 'System.Collections.Generic.List[string]'
$LeaseDirectory = [IO.Path]::GetTempPath()
$LeasePattern = 'dsh-media-bridge-volume-lease-*.json'
$LeasePath = if ($OwnerProcessId -gt 0) {
  Join-Path $LeaseDirectory "dsh-media-bridge-volume-lease-$OwnerProcessId-$([Math]::Round($OwnerStartedAt)).json"
} else {
  Join-Path $LeaseDirectory "dsh-media-bridge-volume-lease-worker-$PID.json"
}

function Write-WorkerJson([object]$value) {
  $json = $value | ConvertTo-Json -Compress -Depth 8
  $bytes = $Utf8NoBom.GetBytes($json + [Environment]::NewLine)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Assert-Volume([object]$value, [string]$name) {
  $number = [double]$value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt 0 -or $number -gt 100) {
    throw "$name must be a finite number from 0 to 100."
  }
  return $number
}

function Set-VolumeLease([object]$lease) {
  $id = [string]$lease.id
  $player = [string]$lease.player
  if ([string]::IsNullOrWhiteSpace($id)) { throw 'Volume lease id must not be empty.' }
  if ($player -ne 'qq-music' -and $player -ne 'netease-music') { throw "Unsupported lease player: $player" }
  $entry = @{
    id = $id
    player = $player
    beforeVolume = (Assert-Volume $lease.beforeVolume 'beforeVolume')
    appliedVolume = (Assert-Volume $lease.appliedVolume 'appliedVolume')
    previousAppliedVolume = (Assert-Volume $(if ($null -eq $lease.previousAppliedVolume) { $lease.beforeVolume } else { $lease.previousAppliedVolume }) 'previousAppliedVolume')
  }
  if (-not $Leases.ContainsKey($id)) { $LeaseOrder.Add($id) }
  $Leases[$id] = $entry
}

function Clear-VolumeLease([string]$id) {
  if ([string]::IsNullOrWhiteSpace($id)) { throw 'Volume lease id must not be empty.' }
  $Leases.Remove($id)
  [void]$LeaseOrder.Remove($id)
}

function Save-LeaseJournal() {
  if ($LeaseOrder.Count -eq 0) {
    Remove-Item -LiteralPath $LeasePath -Force -ErrorAction SilentlyContinue
    return
  }
  $ordered = @($LeaseOrder | ForEach-Object { $Leases[$_] })
  $payload = @{ ownerPid = $OwnerProcessId; ownerStartedAt = $OwnerStartedAt; leases = $ordered }
  $json = $payload | ConvertTo-Json -Compress -Depth 6
  $temporary = "$LeasePath.$PID.tmp"
  [IO.File]::WriteAllText($temporary, $json, $Utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $LeasePath -Force
}

function Test-LeaseOwnerAlive([object]$journal) {
  $ownerPid = [int]$journal.ownerPid
  if ($ownerPid -le 0) { return $false }
  $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($null -eq $owner) { return $false }
  if ([double]$journal.ownerStartedAt -le 0) { return $true }
  try {
    $actual = [DateTimeOffset]($owner.StartTime.ToUniversalTime())
    $actualMs = $actual.ToUnixTimeMilliseconds()
    return [Math]::Abs([double]$actualMs - [double]$journal.ownerStartedAt) -le 10000
  } catch { return $true }
}

function Restore-LeaseEntries([object[]]$entries) {
  if (@($entries).Count -eq 0) { return }
  if ($null -eq ('DshMediaBridge.Windows.AudioSessionVolume' -as [type])) {
    Add-Type -Path (Join-Path (Split-Path -Parent $BridgeScriptPath) 'windows-audio-session.cs')
  }
  for ($index = $entries.Count - 1; $index -ge 0; $index -= 1) {
    $lease = $entries[$index]
    if ($null -eq $lease) { continue }
    $player = [string]$lease.player
    if ($player -ne 'qq-music' -and $player -ne 'netease-music') { continue }
    try {
      $beforeVolume = Assert-Volume $lease.beforeVolume 'beforeVolume'
      $appliedVolume = Assert-Volume $lease.appliedVolume 'appliedVolume'
      $previousAppliedVolume = Assert-Volume $(if ($null -eq $lease.previousAppliedVolume) { $lease.beforeVolume } else { $lease.previousAppliedVolume }) 'previousAppliedVolume'
      $processNames = if ($player -eq 'qq-music') { [string[]]@('QQMusic') } else { [string[]]@('cloudmusic', 'cloudmusic2') }
      $current = [DshMediaBridge.Windows.AudioSessionVolume]::GetForProcessNames($processNames)
      $matchesApplied = [Math]::Abs([double]$current.VolumePercent - $appliedVolume) -le 1.5
      $matchesPrevious = [Math]::Abs([double]$current.VolumePercent - $previousAppliedVolume) -le 1.5
      if ($current.Found -and ($matchesApplied -or $matchesPrevious)) {
        [void][DshMediaBridge.Windows.AudioSessionVolume]::SetForProcessNames($processNames, [single]$beforeVolume)
      }
    } catch {}
  }
}

function Recover-StaleLeaseJournals() {
  foreach ($file in Get-ChildItem -LiteralPath $LeaseDirectory -Filter $LeasePattern -File -ErrorAction SilentlyContinue) {
    if ($file.FullName -eq $LeasePath) { continue }
    try {
      $journal = [IO.File]::ReadAllText($file.FullName, $Utf8NoBom) | ConvertFrom-Json
      if (Test-LeaseOwnerAlive $journal) { continue }
      Restore-LeaseEntries @($journal.leases)
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    } catch {}
  }
}

function Restore-VolumeLeases() {
  if ($LeaseOrder.Count -eq 0) { return }
  try {
    $ordered = @($LeaseOrder | ForEach-Object { $Leases[$_] })
    Restore-LeaseEntries $ordered
  } catch {}
  Remove-Item -LiteralPath $LeasePath -Force -ErrorAction SilentlyContinue
}

Recover-StaleLeaseJournals

if ($OwnerProcessId -gt 0) {
  $watchdogPath = Join-Path $PSScriptRoot 'windows-volume-lease-watchdog.ps1'
  if (Test-Path -LiteralPath $watchdogPath) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', $watchdogPath,
      '-OwnerProcessId', [string]$OwnerProcessId,
      '-OwnerStartedAt', [string]$OwnerStartedAt,
      '-WorkerProcessId', [string]$PID,
      '-LeasePath', $LeasePath,
      '-AudioSessionPath', (Join-Path $PSScriptRoot 'windows-audio-session.cs')
    ) -WindowStyle Hidden | Out-Null
  }
}

try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $request = $line | ConvertFrom-Json
      if ($request.command -eq 'lease-set') {
        Set-VolumeLease $request
        Save-LeaseJournal
        Write-WorkerJson @{ lease = @{ id = [string]$request.id; armed = $true } }
        continue
      }
      if ($request.command -eq 'lease-clear') {
        Clear-VolumeLease ([string]$request.leaseId)
        Save-LeaseJournal
        Write-WorkerJson @{ lease = @{ id = [string]$request.leaseId; armed = $false } }
        continue
      }
      if ($request.command -eq 'lease-sync') {
        $Leases.Clear()
        $LeaseOrder.Clear()
        foreach ($lease in @($request.leases)) { Set-VolumeLease $lease }
        Save-LeaseJournal
        Write-WorkerJson @{ leases = @{ synced = $LeaseOrder.Count } }
        continue
      }

      $parameters = @{
        Command = [string]$request.command
        Player = [string]$request.player
        WorkerInvocation = $true
      }
      if ($null -ne $request.value) {
        if ($request.command -eq 'seek') {
          $parameters.PositionSeconds = [double]$request.value
        } elseif ($request.command -eq 'set-volume') {
          $parameters.VolumePercent = [double]$request.value
        }
      }

      try {
        & $BridgeScriptPath @parameters
      } catch {
        if ($_.Exception.Message -ne $ResponseComplete) { throw }
      }
    } catch {
      Write-WorkerJson @{ error = @{ code = 'WINDOWS_MEDIA_WORKER_ERROR'; message = $_.Exception.Message } }
    }
  }
} finally {
  Restore-VolumeLeases
}
