[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$OwnerProcessId,

  [Parameter(Mandatory = $true)]
  [double]$OwnerStartedAt,

  [Parameter(Mandatory = $true)]
  [int]$WorkerProcessId,

  [Parameter(Mandatory = $true)]
  [string]$LeasePath,

  [Parameter(Mandatory = $true)]
  [string]$AudioSessionPath
)

$ErrorActionPreference = 'SilentlyContinue'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Test-OwnerAlive() {
  $owner = Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue
  if ($null -eq $owner) { return $false }
  try {
    $actual = [DateTimeOffset]($owner.StartTime.ToUniversalTime())
    return [Math]::Abs([double]$actual.ToUnixTimeMilliseconds() - $OwnerStartedAt) -le 10000
  } catch { return $true }
}

function Restore-Journal() {
  if (-not (Test-Path -LiteralPath $LeasePath)) { return }
  try {
    $journal = [IO.File]::ReadAllText($LeasePath, $Utf8NoBom) | ConvertFrom-Json
    if ($null -eq ('DshMediaBridge.Windows.AudioSessionVolume' -as [type])) { Add-Type -Path $AudioSessionPath }
    $leases = @($journal.leases)
    for ($index = $leases.Count - 1; $index -ge 0; $index -= 1) {
      $lease = $leases[$index]
      $player = [string]$lease.player
      $before = [double]$lease.beforeVolume
      $applied = [double]$lease.appliedVolume
      $previousApplied = if ($null -eq $lease.previousAppliedVolume) { $before } else { [double]$lease.previousAppliedVolume }
      $invalidPlayer = $player -ne 'qq-music' -and $player -ne 'netease-music'
      $invalidBefore = [double]::IsNaN($before) -or [double]::IsInfinity($before) -or $before -lt 0 -or $before -gt 100
      $invalidApplied = [double]::IsNaN($applied) -or [double]::IsInfinity($applied) -or $applied -lt 0 -or $applied -gt 100
      $invalidPrevious = [double]::IsNaN($previousApplied) -or [double]::IsInfinity($previousApplied) -or $previousApplied -lt 0 -or $previousApplied -gt 100
      if ($invalidPlayer -or $invalidBefore -or $invalidApplied -or $invalidPrevious) { continue }
      $names = if ($player -eq 'qq-music') { [string[]]@('QQMusic') } else { [string[]]@('cloudmusic', 'cloudmusic2') }
      $current = [DshMediaBridge.Windows.AudioSessionVolume]::GetForProcessNames($names)
      $matchesApplied = [Math]::Abs([double]$current.VolumePercent - $applied) -le 1.5
      $matchesPrevious = [Math]::Abs([double]$current.VolumePercent - $previousApplied) -le 1.5
      if ($current.Found -and ($matchesApplied -or $matchesPrevious)) {
        [void][DshMediaBridge.Windows.AudioSessionVolume]::SetForProcessNames($names, [single]$before)
      }
    }
  } catch {}
  Remove-Item -LiteralPath $LeasePath -Force -ErrorAction SilentlyContinue
}

while ($true) {
  $ownerAlive = Test-OwnerAlive
  if (-not $ownerAlive) {
    Restore-Journal
    break
  }
  $workerAlive = $null -ne (Get-Process -Id $WorkerProcessId -ErrorAction SilentlyContinue)
  if (-not $workerAlive -and -not (Test-Path -LiteralPath $LeasePath)) { break }
  Start-Sleep -Milliseconds 500
}
