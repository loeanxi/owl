[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'diagnose', 'launch', 'play-pause', 'next', 'previous', 'seek', 'set-volume')]
  [string]$Command,

  [Parameter()]
  [double]$PositionSeconds = 0,

  [Parameter()]
  [ValidateSet('qq-music', 'netease-music')]
  [string]$Player = 'qq-music',

  [Parameter()]
  [double]$VolumePercent = 0,

  # Used only by the bundled persistent worker. A completed response unwinds
  # back to the worker loop instead of terminating the PowerShell process.
  [Parameter()]
  [switch]$WorkerInvocation
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ResponseComplete = '__DSH_MEDIA_BRIDGE_RESPONSE_COMPLETE__'

# One media-session bridge, many explicit players. Each entry owns the stable
# playerId/playerName the adapters validate and the SourceAppUserModelId
# pattern that identifies its session (classic Win32 clients publish
# '<exe-name>.exe' style app ids through the media-session layer).
$Players = @{
  'qq-music' = @{
    playerId = 'qq-music'
    playerName = 'QQ Music'
    aumidPattern = '(?i)qqmusic'
  }
  'netease-music' = @{
    playerId = 'netease-music'
    playerName = 'NetEase Cloud Music'
    aumidPattern = '(?i)(cloudmusic|netease)'
  }
}

$selected = $Players[$Player]
if ($null -eq $selected) {
  throw "Unsupported player: $Player"
}

function Write-BridgeJson([object]$value, [int]$exitCode = 0) {
  # Console.OutputEncoding can inherit the parent process' active code page.
  # DSH reads this process' stdout as UTF-8, so write UTF-8 bytes directly to
  # the redirected pipe instead of letting Windows PowerShell choose GBK.
  $json = $value | ConvertTo-Json -Compress -Depth 8
  $bytes = $Utf8NoBom.GetBytes($json + [Environment]::NewLine)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
  if ($WorkerInvocation) {
    throw $ResponseComplete
  }
  exit $exitCode
}

function Await-WinRtOperation([object]$operation, [Type]$resultType) {
  $method = @(
    [System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethodDefinition -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
      }
  )[0]

  if ($null -eq $method) {
    throw 'Windows Runtime async bridge is unavailable.'
  }

  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}

function Empty-Status([hashtable]$playerInfo, [string]$detail) {
  return @{
    playerId = $playerInfo.playerId
    playerName = $playerInfo.playerName
    state = 'unavailable'
    capabilities = @{
      playPause = $false
      next = $false
      previous = $false
      seek = $false
      volume = $false
    }
    detail = $detail
  }
}

function Find-PlayerSession($manager, [string]$aumidPattern) {
  return @(
    $manager.GetSessions() |
      Where-Object { $_.SourceAppUserModelId -match $aumidPattern }
  )[0]
}

if ($Command -eq 'launch') {
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $launchTargets = @{
    'qq-music' = @('QQMusic.exe', (Join-Path $env:LOCALAPPDATA 'Tencent\QQMusic\QQMusic.exe'), (Join-Path $env:ProgramFiles 'Tencent\QQMusic\QQMusic.exe'), (Join-Path $programFilesX86 'Tencent\QQMusic\QQMusic.exe'))
    'netease-music' = @('cloudmusic.exe', (Join-Path $env:LOCALAPPDATA 'Netease\CloudMusic\cloudmusic.exe'), (Join-Path $env:ProgramFiles 'Netease\CloudMusic\cloudmusic.exe'), (Join-Path $programFilesX86 'Netease\CloudMusic\cloudmusic.exe'))
  }
  $processNames = if ($Player -eq 'qq-music') { @('QQMusic') } else { @('cloudmusic', 'cloudmusic2') }
  if (@(Get-Process -Name $processNames -ErrorAction SilentlyContinue).Count -gt 0) {
    Write-BridgeJson @{ launched = $false; alreadyRunning = $true }
  }
  $shortcutRoots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    [Environment]::GetFolderPath('Desktop')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  try {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($root in $shortcutRoots) {
      foreach ($shortcut in (Get-ChildItem -LiteralPath $root -Recurse -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
        $shortcutTarget = $shell.CreateShortcut($shortcut.FullName).TargetPath
        $targetProcess = if ($shortcutTarget) { [IO.Path]::GetFileNameWithoutExtension($shortcutTarget) } else { $null }
        if ($shortcutTarget -and $targetProcess -and ($processNames -contains $targetProcess)) {
          if (Test-Path -LiteralPath $shortcutTarget) {
            Start-Process -FilePath $shortcutTarget | Out-Null
            Write-BridgeJson @{ launched = $true; alreadyRunning = $false }
          }
        }
      }
    }
  } catch {}
  foreach ($target in $launchTargets[$Player]) {
    $command = Get-Command $target -ErrorAction SilentlyContinue
    $path = if ($command -and $command.Source) { $command.Source } elseif (Test-Path -LiteralPath $target) { $target } else { $null }
    if ($null -ne $path) {
      Start-Process -FilePath $path | Out-Null
      Write-BridgeJson @{ launched = $true; alreadyRunning = $false }
    }
  }
  Write-BridgeJson @{ error = @{ code = 'PLAYER_NOT_FOUND'; message = "Could not find $($selected.playerName). Install it or start it manually." } } 1
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  if ($null -eq ('DshMediaBridge.Windows.AudioSessionVolume' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-audio-session.cs')
  }
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $sessionType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType=WindowsRuntime]
  $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]

  $manager = Await-WinRtOperation ($managerType::RequestAsync()) $managerType

  # On-demand self-check for the connection diagnostics center: player process,
  # media-session match, and per-app audio-session probes in one round trip.
  # Reports names and app ids only — never track metadata, paths, or pids.
  if ($Command -eq 'diagnose') {
    $diagnoseProcessNames = if ($Player -eq 'qq-music') { @('QQMusic') } else { @('cloudmusic', 'cloudmusic2') }
    $diagnoseProcesses = @(Get-Process -Name $diagnoseProcessNames -ErrorAction SilentlyContinue)
    $allSessions = @($manager.GetSessions())
    $matchedSessions = @($allSessions | Where-Object { $_.SourceAppUserModelId -match $selected.aumidPattern })
    $probe = @{
      playerId = $selected.playerId
      playerName = $selected.playerName
      process = @{
        found = ($diagnoseProcesses.Count -gt 0)
        processCount = $diagnoseProcesses.Count
        names = @($diagnoseProcesses | ForEach-Object { [string]$_.ProcessName } | Select-Object -Unique)
      }
      mediaSession = @{
        totalSessions = $allSessions.Count
        matchingSessions = $matchedSessions.Count
        appUserModelIds = @($matchedSessions | ForEach-Object { [string]$_.SourceAppUserModelId } | Select-Object -Unique)
      }
    }
    try {
      $diagnoseAudio = [DshMediaBridge.Windows.AudioSessionVolume]::GetForProcessNames($diagnoseProcessNames)
      $audioProbe = @{ found = [bool]($null -ne $diagnoseAudio -and $diagnoseAudio.Found) }
      if ($audioProbe.found) { $audioProbe.volumePercent = [Math]::Round($diagnoseAudio.VolumePercent, 1) }
      $probe.audioSession = $audioProbe
    } catch {
      $probe.audioSession = @{ found = $false }
    }
    if ($matchedSessions.Count -gt 0) {
      try {
        $matchedPlayback = $matchedSessions[0].GetPlaybackInfo()
        $matchedStatus = $matchedPlayback.PlaybackStatus.ToString()
        $probe.state = if ($matchedStatus -eq 'Playing') { 'playing' } elseif ($matchedStatus -eq 'Paused') { 'paused' } else { 'unavailable' }
        $probe.capabilities = @{
          playPause = [bool]$matchedPlayback.Controls.IsPlayPauseToggleEnabled
          next = [bool]$matchedPlayback.Controls.IsNextEnabled
          previous = [bool]$matchedPlayback.Controls.IsPreviousEnabled
          seek = [bool]$matchedPlayback.Controls.IsPlaybackPositionEnabled
          volume = [bool]($null -ne $probe.audioSession -and $probe.audioSession.found)
        }
      } catch {}
    }
    Write-BridgeJson $probe
  }

  $session = Find-PlayerSession $manager $selected.aumidPattern

  if ($null -eq $session) {
    Write-BridgeJson (Empty-Status $selected "$($selected.playerName) did not publish a media session. Start $($selected.playerName) and play a track, then try again.")
  }

  $audioProcessNames = if ($Player -eq 'qq-music') { @('QQMusic') } else { @('cloudmusic', 'cloudmusic2') }
  $audio = [DshMediaBridge.Windows.AudioSessionVolume]::GetForProcessNames($audioProcessNames)

  if ($Command -eq 'set-volume') {
    if ($null -eq $audio -or -not $audio.Found) {
      Write-BridgeJson @{ error = @{ code = 'VOLUME_UNAVAILABLE'; message = "$($selected.playerName) has no active Core Audio render session on the default output device." } } 1
    }
    $audio = [DshMediaBridge.Windows.AudioSessionVolume]::SetForProcessNames($audioProcessNames, [single]$VolumePercent)
  } elseif ($Command -ne 'status') {
    $result = switch ($Command) {
      'play-pause' { Await-WinRtOperation ($session.TryTogglePlayPauseAsync()) ([bool]); break }
      'next' { Await-WinRtOperation ($session.TrySkipNextAsync()) ([bool]); break }
      'previous' { Await-WinRtOperation ($session.TrySkipPreviousAsync()) ([bool]); break }
      'seek' { Await-WinRtOperation ($session.TryChangePlaybackPositionAsync([TimeSpan]::FromSeconds($PositionSeconds))) ([bool]); break }
    }
    if (-not $result) {
      Write-BridgeJson @{ error = @{ code = 'COMMAND_REJECTED'; message = "$($selected.playerName) rejected the $Command control request." } } 1
    }
  }

  $playback = $session.GetPlaybackInfo()
  $controls = $playback.Controls
  $timeline = $session.GetTimelineProperties()
  $properties = Await-WinRtOperation ($session.TryGetMediaPropertiesAsync()) $propertiesType
  $state = if ($playback.PlaybackStatus.ToString() -eq 'Playing') { 'playing' } elseif ($playback.PlaybackStatus.ToString() -eq 'Paused') { 'paused' } else { 'unavailable' }

  $payload = @{
    playerId = $selected.playerId
    playerName = $selected.playerName
    state = $state
    capabilities = @{
      playPause = [bool]$controls.IsPlayPauseToggleEnabled
      next = [bool]$controls.IsNextEnabled
      previous = [bool]$controls.IsPreviousEnabled
      seek = [bool]$controls.IsPlaybackPositionEnabled
      volume = [bool]($null -ne $audio -and $audio.Found)
    }
  }

  if ($state -ne 'unavailable') {
    $payload.track = @{
      title = [string]$properties.Title
      artist = [string]$properties.Artist
      album = [string]$properties.AlbumTitle
      durationSeconds = [Math]::Round($timeline.EndTime.TotalSeconds, 3)
    }
    $payload.positionSeconds = [Math]::Round($timeline.Position.TotalSeconds, 3)
    if ($null -ne $audio -and $audio.Found) {
      $payload.volumePercent = [Math]::Round($audio.VolumePercent, 1)
    }
  } else {
    $payload.detail = "$($selected.playerName) did not publish a playable media state."
  }

  Write-BridgeJson $payload
} catch {
  if ($WorkerInvocation -and $_.Exception.Message -eq $ResponseComplete) {
    throw
  }
  Write-BridgeJson @{ error = @{ code = 'WINDOWS_MEDIA_SESSION_ERROR'; message = $_.Exception.Message } } 1
}
