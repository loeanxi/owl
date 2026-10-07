param(
  [Parameter(Mandatory = $true)][string]$WorkerPath,
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class OwlCaptureFixture : Form {
  public int FrameTick;
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e);
    e.Graphics.FillRectangle(Brushes.Red, 0, 0, 40, 40);
    e.Graphics.FillRectangle(Brushes.Lime, ClientSize.Width - 40, 0, 40, 40);
    e.Graphics.FillRectangle(Brushes.Blue, 0, ClientSize.Height - 40, 40, 40);
    e.Graphics.FillRectangle(Brushes.Yellow, ClientSize.Width - 40, ClientSize.Height - 40, 40, 40);
    using (var brush = new SolidBrush(Color.FromArgb(FrameTick % 255, 80, 160)))
      e.Graphics.FillRectangle(brush, 45, 45, 12, 12);
  }
}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing
[OwlCaptureFixture]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$target = New-Object OwlCaptureFixture
$target.FormBorderStyle = 'None'
$target.StartPosition = 'Manual'
$target.ShowInTaskbar = $false
$target.SetBounds(30, 100, 320, 240)
$targetHandle = $target.Handle
[OwlCaptureFixture]::ShowWindow($targetHandle, 4) | Out-Null
[System.Windows.Forms.Application]::DoEvents()

$worker = New-Object System.Diagnostics.Process
$worker.StartInfo.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$worker.StartInfo.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $WorkerPath + '" capture -Hwnd ' + $targetHandle.ToInt64() + ' -NoAutoRestore -FrameTimeoutMs 150 -MaxWidth 0'
$worker.StartInfo.UseShellExecute = $false
$worker.StartInfo.CreateNoWindow = $true
$worker.StartInfo.RedirectStandardOutput = $true
$worker.StartInfo.RedirectStandardError = $true
$results = New-Object System.Collections.ArrayList
if ($OutputDir) { New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null }

try {
  [void]$worker.Start()
  $stderr = $worker.StandardError.ReadToEndAsync()
  $lineTask = $worker.StandardOutput.ReadLineAsync()
  $index = 0
  foreach ($size in @(@(320,240), @(640,480), @(240,360), @(800,300), @(320,240))) {
    $index++
    $marker = [Drawing.Color]::FromArgb(30 + $index * 30, 65, 120)
    $target.BackColor = $marker
    $target.ClientSize = New-Object Drawing.Size($size[0], $size[1])
    $target.Invalidate()
    [System.Windows.Forms.Application]::DoEvents()
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $matched = $false
    $lastFrame = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      # Continue presenting frames like the video app; Recreate discards pending
      # frames and the next compositor update supplies the resized texture.
      $target.FrameTick++
      $target.Invalidate()
      [System.Windows.Forms.Application]::DoEvents()
      if ($worker.HasExited) { throw ('Capture worker exited: ' + $stderr.Result) }
      if (-not $lineTask.IsCompleted) { Start-Sleep -Milliseconds 10; continue }
      $line = $lineTask.Result
      $lineTask = $worker.StandardOutput.ReadLineAsync()
      if (-not $line) { continue }
      $message = $line | ConvertFrom-Json
      if ($message.event -eq 'error') { throw $message.message }
      if ($message.event -ne 'frame') { continue }
      $lastFrame = $message
      if ($message.w -ne $size[0] -or $message.h -ne $size[1]) { continue }
      $bytes = [Convert]::FromBase64String($message.data)
      $stream = New-Object IO.MemoryStream(,$bytes)
      $bitmap = New-Object Drawing.Bitmap($stream)
      try {
        if ($bitmap.Width -ne $size[0] -or $bitmap.Height -ne $size[1]) { throw 'JPEG dimensions disagree with frame metadata' }
        $center = $bitmap.GetPixel([int]($bitmap.Width / 2), [int]($bitmap.Height / 2))
        # A repeated size can have queued old frames. Check the stage marker too.
        if ([Math]::Abs($center.R - $marker.R) -gt 15 -or [Math]::Abs($center.G - $marker.G) -gt 15 -or [Math]::Abs($center.B - $marker.B) -gt 15) { continue }
        $corners = @(
          @($bitmap.GetPixel(20,20), [Drawing.Color]::Red),
          @($bitmap.GetPixel($bitmap.Width-20,20), [Drawing.Color]::Lime),
          @($bitmap.GetPixel(20,$bitmap.Height-20), [Drawing.Color]::Blue),
          @($bitmap.GetPixel($bitmap.Width-20,$bitmap.Height-20), [Drawing.Color]::Yellow)
        )
        foreach ($pair in $corners) {
          if ([Math]::Abs($pair[0].R - $pair[1].R) -gt 25 -or [Math]::Abs($pair[0].G - $pair[1].G) -gt 25 -or [Math]::Abs($pair[0].B - $pair[1].B) -gt 25) {
            throw "Capture clipped a corner at $($size[0])x$($size[1])"
          }
        }
      } finally { $bitmap.Dispose(); $stream.Dispose() }
      if ($OutputDir) { [IO.File]::WriteAllBytes((Join-Path $OutputDir ("frame-$index.jpg")), $bytes) }
      [void]$results.Add(@{ width = $message.w; height = $message.h; sequence = $message.seq; corners = 'complete' })
      $matched = $true
      break
    }
    if (-not $matched) {
      $actual = if ($lastFrame) { "$($lastFrame.w)x$($lastFrame.h)" } else { 'no frame' }
      throw "Capture did not adapt to $($size[0])x$($size[1]); last frame: $actual"
    }
  }
  Write-Output 'capture-resize-ok'
} finally {
  if ($worker.Id -and -not $worker.HasExited) { $worker.Kill(); $worker.WaitForExit(3000) | Out-Null }
  $worker.Dispose()
  $target.Dispose()
  if ($OutputDir) { $results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir 'results.json') -Encoding UTF8 }
}
