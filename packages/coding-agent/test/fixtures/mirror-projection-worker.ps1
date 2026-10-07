param([Parameter(Mandatory = $true)][string]$WorkerPath)
$ErrorActionPreference = 'Stop'
$evidencePath = $env:OWL_MIRROR_GUARD_DIAGNOSTIC
Add-Type -AssemblyName System.Windows.Forms
$source = [IO.File]::ReadAllText($WorkerPath)
$interop = [regex]::Match($source, "(?s)\`$user32 = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
Add-Type -TypeDefinition $interop
[OwlMirrorWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$directory = Join-Path ([IO.Path]::GetTempPath()) ('owl-projection-test-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $directory | Out-Null
$appSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Drawing;
public sealed class Fixture : Form {
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
  readonly string events;
  Fixture(string info, string events) {
    this.events = events;
    Text = "红果 Fixture";
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    FormBorderStyle = FormBorderStyle.None;
    Bounds = new Rectangle(-8000, -8000, 906, 547);
    Shown += (s, e) => {
      // Keep a real visible HWND for lifecycle/input checks, but exclude this
      // fake Androws window from the running Owl's production enumeration.
      int cloaked = 1;
      int error = DwmSetWindowAttribute(Handle, 13, ref cloaked, sizeof(int));
      File.WriteAllText(info, error == 0 ? Handle.ToInt64().ToString() : "cloak-failed:" + error);
    };
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x201 || m.Msg == 0x202 || m.Msg == 0x20a)
      File.AppendAllText(events, m.Msg + ":" + ((short)((m.WParam.ToInt64() >> 16) & 0xffff)) + "\n");
    base.WndProc(ref m);
  }
  [STAThread] public static void Main(string[] args) { Application.Run(new Fixture(args[0], args[1])); }
}
'@
$executable = Join-Path $directory 'Androws.exe'
Add-Type -TypeDefinition $appSource -OutputAssembly $executable -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms, System.Drawing
$infoPath = Join-Path $directory 'handle.txt'
$eventsPath = Join-Path $directory 'events.txt'
$controlPath = Join-Path $directory 'control.jsonl'
$outPath = Join-Path $directory 'worker.txt'
$errPath = Join-Path $directory 'worker-error.txt'
$geometryId = [Guid]::NewGuid().ToString()
[IO.File]::WriteAllText($eventsPath, '')
[IO.File]::WriteAllText($controlPath, '')
$app = Start-Process -FilePath $executable -ArgumentList @($infoPath, $eventsPath) -WindowStyle Hidden -PassThru
$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'Manual'
$owner.ShowInTaskbar = $false
$owner.SetBounds(-5000, -5000, 1280, 860)
$ownerHandle = $owner.Handle
[OwlMirrorWin32]::ShowWindow($ownerHandle, 4) | Out-Null
$worker = $null

function Read-Shared([string]$path) {
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  $reader = New-Object IO.StreamReader($stream)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Wait-Until([scriptblock]$check, [string]$failure) {
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    if (& $check) { return }
    Start-Sleep -Milliseconds 20
  }
  throw $failure
}
function Start-Projection {
  $script:geometryId = [Guid]::NewGuid().ToString()
  $script:controlPath = Join-Path $directory ($geometryId + '.jsonl')
  [IO.File]::WriteAllText($controlPath, '')
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $WorkerPath, 'embed', '-Hwnd', "$targetHandle", '-ParentHwnd', "$ownerHandle", '-Projection', '-ControlPath', $controlPath, '-GeometryId', $geometryId)
  # Match MirrorHub: stop/reopen must not replace the first restore snapshot
  # with a hidden/offscreen projection's current style, owner or bounds.
  if ($restoreSnapshot) {
    $rect = $restoreSnapshot.originalRect
    $arguments += @('-HasBaseStyle', '-BaseStyle', "$($restoreSnapshot.originalStyle)", '-HasBaseRect', '-BaseParent', "$($restoreSnapshot.originalParent)", '-BaseX', "$($rect.x)", '-BaseY', "$($rect.y)", '-BaseW', "$($rect.width)", '-BaseH', "$($rect.height)")
  }
  $quoted = ($arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  return Start-Process -FilePath powershell.exe -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $outPath -RedirectStandardError $errPath
}
function Assert-RestoreSnapshot {
  $current = (Read-Shared $outPath).Split("`n") | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.event -eq 'embedded' } | Select-Object -Last 1
  if ($current.originalParent -ne $restoreSnapshot.originalParent -or $current.originalStyle -ne $restoreSnapshot.originalStyle -or
      $current.originalRect.x -ne $restoreSnapshot.originalRect.x -or $current.originalRect.y -ne $restoreSnapshot.originalRect.y -or
      $current.originalRect.width -ne $restoreSnapshot.originalRect.width -or $current.originalRect.height -ne $restoreSnapshot.originalRect.height) {
    throw ('Projection replaced the original restore snapshot: ' + (@{ expected = $restoreSnapshot; actual = $current } | ConvertTo-Json -Depth 6 -Compress))
  }
}
try {
  Wait-Until { Test-Path -LiteralPath $infoPath } 'Fixture did not start'
  $targetHandle = [IntPtr]([long][IO.File]::ReadAllText($infoPath))
  if (-not [OwlMirrorWin32]::IsCloaked($targetHandle)) { throw 'Fixture window was not cloaked from Owl enumeration' }
  $listed = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WorkerPath list
  foreach ($line in $listed) {
    $row = $line | ConvertFrom-Json
    if ($row.event -eq 'window' -and $row.hwnd -eq $targetHandle.ToInt64()) { throw 'Production mirror.list exposed the fixture window' }
  }
  $worker = Start-Projection
  Wait-Until { (Test-Path -LiteralPath $outPath) -and (Read-Shared $outPath).Contains('"event":"embedded"') } 'Projection did not start'
  $ready = (Read-Shared $outPath).Split("`n") | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.event -eq 'embedded' } | Select-Object -Last 1
  $restoreSnapshot = $ready
  if ($ready.geometry.crop.width -ne 843 -or $ready.geometry.crop.height -ne 472) { throw 'Incorrect projection crop' }
  $bounds = New-Object OwlMirrorWin32+RECT
  [OwlMirrorWin32]::GetWindowRect($targetHandle, [ref]$bounds) | Out-Null
  if ($bounds.Left -gt -10000 -or -not [OwlMirrorWin32]::IsWindowVisible($targetHandle)) { throw 'Projection did not preserve an offscreen visible surface' }

  $down = @{ token = $geometryId; action = 'down'; x = 200; y = 180; deltaY = 0 } | ConvertTo-Json -Compress
  $half = [int]($down.Length / 2)
  [IO.File]::AppendAllText($controlPath, $down.Substring(0, $half))
  Start-Sleep -Milliseconds 100
  if (Read-Shared $eventsPath) { throw 'Incomplete command was applied' }
  [IO.File]::AppendAllText($controlPath, $down.Substring($half) + "`n")
  Wait-Until { (Read-Shared $eventsPath).Contains('513:') } 'Pointer down was not delivered'
  $cancel = @{ token = $geometryId; action = 'cancel' } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($controlPath, $cancel + "`n")
  Wait-Until { (Read-Shared $eventsPath).Contains('514:') } 'Pointer cancel did not release'
  $wheel = @{ token = $geometryId; action = 'wheel'; x = 200; y = 180; deltaY = 120 } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($controlPath, $wheel + "`n")
  Wait-Until { (Read-Shared $eventsPath).Contains('522:-120') } 'Wheel direction was not mapped'
  foreach ($delta in @(0, 2, 6000, -6000)) {
    $wheel = @{ token = $geometryId; action = 'wheel'; x = 200; y = 180; deltaY = $delta } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($controlPath, $wheel + "`n")
  }
  Wait-Until { (Read-Shared $eventsPath).Split("`n") -contains '522:6000' } 'Coalesced wheel input was not delivered'
  $wheelEvents = @((Read-Shared $eventsPath).Split("`n") | Where-Object { $_.StartsWith('522:') })
  if (($wheelEvents -join ',') -ne '522:-120,522:-2,522:-6000,522:6000') {
    throw ('Native wheel delta was amplified, truncated or zero was emitted: ' + ($wheelEvents -join ','))
  }
  $stop = @{ token = $geometryId; action = 'stop' } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($controlPath, $stop + "`n")
  Wait-Until { $worker.HasExited } 'Projection did not stop'
  if ([OwlMirrorWin32]::IsWindowVisible($targetHandle)) { throw 'Stopped projection left its source visible' }

  [IO.File]::WriteAllText($controlPath, '')
  $worker = Start-Projection
  Wait-Until { (Read-Shared $outPath).Contains($geometryId) } 'Projection did not resume'
  Assert-RestoreSnapshot
  $worker.Kill()
  $worker.WaitForExit(3000) | Out-Null
  Wait-Until {
    [OwlMirrorWin32]::GetWindowRect($targetHandle, [ref]$bounds) | Out-Null
    $bounds.Left -gt -10000 -and [OwlMirrorWin32]::IsWindowVisible($targetHandle)
  } 'Abrupt worker loss stranded the source offscreen'
  $worker = Start-Projection
  Wait-Until { (Read-Shared $outPath).Contains($geometryId) } 'Projection did not resume after worker loss'
  Assert-RestoreSnapshot
  # Hold the same native lock while the old guard and a replacement projection
  # both become ready; neither may restore or remove the replacement's lease.
  $leaseLock = [OwlMirrorWin32]::LockProjection($targetHandle)
  try {
    $worker.Kill()
    $worker.WaitForExit(3000) | Out-Null
    $worker = Start-Projection
    Wait-Until { Test-Path -LiteralPath ($controlPath + '.lease.ready') } 'Replacement guard was not armed'
  } finally { $leaseLock.ReleaseMutex(); $leaseLock.Dispose() }
  Wait-Until { (Read-Shared $outPath).Contains($geometryId) } 'Replacement projection did not start'
  Assert-RestoreSnapshot
  $replacementToken = [OwlMirrorWin32]::GetProp($targetHandle, 'OwlMirrorProjectionLease').ToInt64()
  Start-Sleep -Milliseconds 150
  [OwlMirrorWin32]::GetWindowRect($targetHandle, [ref]$bounds) | Out-Null
  if ($replacementToken -eq 0 -or [OwlMirrorWin32]::GetProp($targetHandle, 'OwlMirrorProjectionLease').ToInt64() -ne $replacementToken -or $bounds.Left -gt -10000) {
    throw 'Old guard overwrote the replacement projection'
  }
  $owner.Dispose()
  Wait-Until { $worker.HasExited } 'Owner loss did not stop projection'
  [OwlMirrorWin32]::GetWindowRect($targetHandle, [ref]$bounds) | Out-Null
  if ($bounds.Left -lt -10000 -or -not [OwlMirrorWin32]::IsWindowVisible($targetHandle) -or
      $bounds.Left -ne $restoreSnapshot.originalRect.x -or $bounds.Top -ne $restoreSnapshot.originalRect.y -or
      $bounds.Right - $bounds.Left -ne $restoreSnapshot.originalRect.width -or $bounds.Bottom - $bounds.Top -ne $restoreSnapshot.originalRect.height) {
    $currentPid = [uint32]0
    [OwlMirrorWin32]::GetWindowThreadProcessId($targetHandle, [ref]$currentPid) | Out-Null
    $failure = @{
      valid = [OwlMirrorWin32]::IsWindow($targetHandle)
      visible = [OwlMirrorWin32]::IsWindowVisible($targetHandle)
      x = $bounds.Left; y = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top
      hwnd = $targetHandle.ToInt64(); targetPid = $currentPid; appExited = $app.HasExited; workerExit = $worker.ExitCode
      lease = [OwlMirrorWin32]::GetProp($targetHandle, 'OwlMirrorProjectionLease').ToInt64()
      stdout = Read-Shared $outPath; stderr = Read-Shared $errPath
    } | ConvertTo-Json -Depth 5
    if ($evidencePath) { [IO.File]::WriteAllText($evidencePath, $failure) }
    throw ('Owner loss stranded the source offscreen: ' + $failure)
  }
  if (-not [OwlMirrorWin32]::IsCloaked($targetHandle)) { throw 'Restoring the fixture leaked it into Owl enumeration' }
  if ($evidencePath) {
    [IO.File]::WriteAllText($evidencePath, (@{
      result = 'projection-worker-ok'; restoreSnapshot = $restoreSnapshot
      restoredRect = @{ x = $bounds.Left; y = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top }
      wheelEvents = $wheelEvents
      fixtureCloaked = [OwlMirrorWin32]::IsCloaked($targetHandle)
    } | ConvertTo-Json -Depth 6))
  }
  Write-Output 'projection-worker-ok'
} catch {
  if ($evidencePath) {
    [IO.File]::WriteAllText($evidencePath, (@{
      result = 'failed'; failure = ($_ | Out-String)
      appExited = $app.HasExited; workerExited = $worker -and $worker.HasExited
      sourceValid = $targetHandle -and [OwlMirrorWin32]::IsWindow($targetHandle)
      events = if (Test-Path -LiteralPath $eventsPath) { Read-Shared $eventsPath } else { '' }
      stdout = if (Test-Path -LiteralPath $outPath) { Read-Shared $outPath } else { '' }
      stderr = if (Test-Path -LiteralPath $errPath) { Read-Shared $errPath } else { '' }
    } | ConvertTo-Json -Depth 6))
  }
  throw
} finally {
  if ($worker -and -not $worker.HasExited) { $worker.Kill(); $worker.WaitForExit(3000) | Out-Null }
  if (-not $app.HasExited) { $app.Kill(); $app.WaitForExit(3000) | Out-Null }
  $owner.Dispose()
  # All files belong to this fixture; remove exact files, never a computed tree.
  Get-ChildItem -LiteralPath $directory -File | ForEach-Object {
    try { Remove-Item -LiteralPath $_.FullName -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { } # The recovery guard can delete its lease first.
  }
  Remove-Item -LiteralPath $directory
}
