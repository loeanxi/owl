param([Parameter(Mandatory = $true)][string]$WorkerPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$source = [IO.File]::ReadAllText($WorkerPath)
$interop = [regex]::Match($source, "(?s)\`$user32 = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
if (-not $interop) { throw 'Mirror native interop was not found' }
Add-Type -TypeDefinition $interop
[OwlMirrorWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

# Hidden native windows exercise the production placement method without touching
# the user's desktop windows. Anchors model an app responding to WM_SIZE itself.
$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'Manual'
$owner.ShowInTaskbar = $false
$owner.SetBounds(100, 100, 1920, 1080)
$target = New-Object System.Windows.Forms.Form
$target.FormBorderStyle = 'None'
$target.StartPosition = 'Manual'
$target.ShowInTaskbar = $false
$target.SetBounds(200, 200, 906, 510)
$target.MinimumSize = New-Object System.Drawing.Size(600, 500)
$player = New-Object System.Windows.Forms.Panel
$player.SetBounds(4, 40, 840, 470)
$player.Anchor = 'Top,Bottom,Left,Right'
$target.Controls.Add($player)
$ownerHandle = $owner.Handle
$targetHandle = $target.Handle
$playerHandle = $player.Handle

try {
  foreach ($stage in @(
    @{ X = 700; Y = 100; W = 360; H = 640 },
    @{ X = 400; Y = 80; W = 954; H = 806 },
    @{ X = 900; Y = 120; W = 498; H = 634 },
    @{ X = 720; Y = 100; W = 360; H = 640 }
  )) {
    $result = [OwlMirrorWin32]::PlaceStage($targetHandle, $ownerHandle, $stage.X, $stage.Y, $stage.W, $stage.H)
    if ($result -ne 0) { throw "Native placement failed: $result" }
    if ($player.Width -ne $stage.W -or $player.Height -ne $stage.H) {
      throw "Content not adapted to stage: $($player.Width)x$($player.Height), expected $($stage.W)x$($stage.H)"
    }
    $region = [OwlMirrorWin32]::CreateRectRgn(0, 0, 0, 0)
    try {
      [OwlMirrorWin32]::GetWindowRgn($targetHandle, $region) | Out-Null
      $clip = New-Object OwlMirrorWin32+RECT
      [OwlMirrorWin32]::GetRgnBox($region, [ref]$clip) | Out-Null
      if ($clip.Left -ne $player.Left -or $clip.Top -ne $player.Top -or
          $clip.Right -ne $player.Right -or $clip.Bottom -ne $player.Bottom) {
        throw 'Native clip cuts off the app content'
      }
    } finally { [OwlMirrorWin32]::DeleteObject($region) | Out-Null }
    $window = New-Object OwlMirrorWin32+RECT
    [OwlMirrorWin32]::GetWindowRect($targetHandle, [ref]$window) | Out-Null
    if ($window.Left + $player.Left -ne 100 + $stage.X -or
        $window.Top + $player.Top -ne 100 + $stage.Y) {
      throw 'App content does not align with the stage origin'
    }
  }
  # Moving Owl and changing the stage origin at the same time must use the new
  # origin; caching only width/height leaves the video over the chat composer.
  $owner.Location = New-Object System.Drawing.Point(180, 160)
  [OwlMirrorWin32]::PlaceStage($targetHandle, $ownerHandle, 800, 140, 360, 640) | Out-Null
  $window = New-Object OwlMirrorWin32+RECT
  [OwlMirrorWin32]::GetWindowRect($targetHandle, [ref]$window) | Out-Null
  if ($window.Left + $player.Left -ne 980 -or $window.Top + $player.Top -ne 300) {
    throw 'Native window followed a stale stage origin'
  }

  # There is no guaranteed child HWND in Qt. The fallback must apply the same
  # physical stage rectangle when the whole app is painted into its root HWND.
  $target.Controls.Remove($player)
  [OwlMirrorWin32]::PlaceStage($targetHandle, $ownerHandle, 800, 140, 360, 640) | Out-Null
  if (-not [OwlMirrorWin32]::ContentClipOk($targetHandle, 4, 40, 364, 680)) {
    throw 'Root-painted app has a different clipping layout'
  }
  $target.Controls.Add($player)

  # Twice the CSS stage size is passed at DPR 2. The worker must use the physical
  # pixel rectangle directly, without introducing a second scale conversion.
  [OwlMirrorWin32]::PlaceStage($targetHandle, $ownerHandle, 800, 140, 720, 1280) | Out-Null
  if ($player.Width -ne 720 -or $player.Height -ne 1280) {
    throw 'Physical stage dimensions were scaled twice'
  }

  # Run the real watchdog against offscreen fixture windows to verify layout
  # publication, hide/show, and owner visibility without displaying test UI.
  $owner.SetBounds(-5000, -5000, 1920, 1080)
  [OwlMirrorWin32]::ShowWindow($ownerHandle, 4) | Out-Null
  $layoutPath = Join-Path ([IO.Path]::GetTempPath()) ("owl-mirror-layout-" + $targetHandle.ToInt64() + '.txt')
  [IO.File]::WriteAllText($layoutPath, '700,100,360,640')
  $worker = New-Object System.Diagnostics.Process
  $worker.StartInfo.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $worker.StartInfo.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $WorkerPath + '" embed -Hwnd ' + $targetHandle.ToInt64() + ' -ParentHwnd ' + $ownerHandle.ToInt64() + ' -X 700 -Y 100 -W 360 -H 640'
  $worker.StartInfo.UseShellExecute = $false
  $worker.StartInfo.CreateNoWindow = $true
  $worker.StartInfo.RedirectStandardOutput = $true
  $worker.StartInfo.RedirectStandardError = $true
  try {
    [void]$worker.Start()
    $expectedWidth = 360
    $expectedHeight = 640
    foreach ($transition in @(
      @{ Layout = '700,100,360,640'; Visible = $true },
      @{ Layout = '0,0,0,0'; Visible = $false },
      @{ Layout = '900,120,498,634'; Visible = $true },
      @{ OwnerHidden = $true; Visible = $false },
      @{ OwnerHidden = $false; Visible = $true }
    )) {
      if ($transition.ContainsKey('Layout')) {
        [IO.File]::WriteAllText($layoutPath, $transition.Layout)
        if ($transition.Visible) {
          $parts = $transition.Layout.Split(',')
          $expectedWidth = [int]$parts[2]
          $expectedHeight = [int]$parts[3]
        }
      }
      if ($transition.ContainsKey('OwnerHidden')) {
        $show = if ($transition.OwnerHidden) { 0 } else { 4 }
        [OwlMirrorWin32]::ShowWindow($ownerHandle, $show) | Out-Null
      }
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      $matched = $false
      while ([DateTime]::UtcNow -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        if ($worker.HasExited) { throw ('Native watchdog exited: ' + $worker.StandardError.ReadToEnd()) }
        $visible = [OwlMirrorWin32]::IsWindowVisible($targetHandle)
        $sizeMatches = (-not $visible) -or ($player.Width -eq $expectedWidth -and $player.Height -eq $expectedHeight)
        if ($visible -eq $transition.Visible -and $sizeMatches) {
          $matched = $true
          break
        }
        Start-Sleep -Milliseconds 20
      }
      if (-not $matched) { throw "Native visibility transition failed: $($transition | ConvertTo-Json -Compress)" }
    }
    [System.Windows.Forms.Application]::DoEvents()
    if ($player.Width -ne 498 -or $player.Height -ne 634) { throw 'Watchdog resumed stale content dimensions' }
  } finally {
    if ($worker.Id -and -not $worker.HasExited) { $worker.Kill(); $worker.WaitForExit(3000) | Out-Null }
    $worker.Dispose()
    Remove-Item -LiteralPath $layoutPath -ErrorAction SilentlyContinue
  }
  Write-Output 'native-layout-ok'
} finally {
  $target.Dispose()
  $owner.Dispose()
}
