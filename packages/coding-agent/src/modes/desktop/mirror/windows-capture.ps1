# owl mirror worker: enumerate windows / WGC capture loop / restore / launch.
# JSON lines on stdout (UTF-8), one event per line:
#   {"event":"window","hwnd":N,"title":"...","process":"...","w":N,"h":N,"minimized":bool,"class":"..."}
#   {"event":"frame","seq":N,"w":N,"h":N,"data":"<base64 jpeg>"}
#   {"event":"status","iconic":bool,"autoRestored":N,"frameSeq":N}
#   {"event":"error","message":"..."}
#   {"event":"ready"}
#
# 捕获走 Windows.Graphics.Capture：C# 侧（windows-capture.cs）只做工厂 interop
# （Type.GetType 惰性解析 + WindowsRuntimeMarshal，无需 winmd 引用），WinRT 会话
# 在本文件用惰性类型字面量编排，COM 对象全部不透明透传、不做 PS 侧强转。
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'capture', 'restore', 'launch')]
  [string]$Command,

  [long]$Hwnd = 0,
  [int]$Fps = 20,
  [int]$Quality = 70,
  [int]$MaxWidth = 1280,
  [int]$FrameTimeoutMs = 1500,
  [switch]$NoAutoRestore
)

$ErrorActionPreference = 'Stop'
$script:AutoRestored = 0
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-JsonLine([string]$line) {
  $bytes = $Utf8NoBom.GetBytes($line + [Environment]::NewLine)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Escape-Json([string]$text) {
  if ($null -eq $text) { return '' }
  $escaped = $text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
  return $escaped
}

# ---------------------------------------------------------------------------
# window interop (list / restore): pure user32, no WinRT
# ---------------------------------------------------------------------------
$user32 = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OwlMirrorWin32 {
    public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

    public static bool IsCloaked(IntPtr hwnd) {
        int cloaked;
        try {
            DwmGetWindowAttribute(hwnd, 14, out cloaked, 4);
        } catch { cloaked = 0; }
        return cloaked != 0;
    }

    public static string GetTitle(IntPtr hwnd) {
        int len = GetWindowTextLength(hwnd);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string GetClassName(IntPtr hwnd) {
        var sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static bool RestoreByScRestore(IntPtr hwnd) {
        // BitDock 类 Dock 工具会吞掉 ShowWindow/SW_RESTORE；系统的 SC_RESTORE
        // 命令能穿透。
        return PostMessage(hwnd, 0x0112, (IntPtr)0xF120, IntPtr.Zero);
    }
}
'@
Add-Type -TypeDefinition $user32

function Get-WindowRows {
  $rows = New-Object System.Collections.ArrayList
  $cb = [OwlMirrorWin32+EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$l)
    try {
      if (-not [OwlMirrorWin32]::IsWindowVisible($h)) { return $true }
      $title = [OwlMirrorWin32]::GetTitle($h)
      if (-not $title) { return $true }
      if ([OwlMirrorWin32]::IsCloaked($h)) { return $true }
      $procId = 0
      [OwlMirrorWin32]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      $procName = ''
      try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $procName = $proc.ProcessName
      } catch { }
      $iconic = [bool][OwlMirrorWin32]::IsIconic($h)
      # 最小化窗口的客户区是任务栏缩略尺寸，改报窗口矩形（仅作列表展示用；
      # attach 后以实际帧尺寸为准）
      $rect = New-Object OwlMirrorWin32+RECT
      if ($iconic) {
        [OwlMirrorWin32]::GetWindowRect($h, [ref]$rect) | Out-Null
      } else {
        [OwlMirrorWin32]::GetClientRect($h, [ref]$rect) | Out-Null
      }
      $w = $rect.Right - $rect.Left
      $hh = $rect.Bottom - $rect.Top
      if (-not $iconic -and ($w -lt 80 -or $hh -lt 60)) { return $true }
      [void]$rows.Add(@{
        hwnd = $h.ToInt64(); title = $title; process = $procName
        w = $w; h = $hh; minimized = $iconic
        cls = [OwlMirrorWin32]::GetClassName($h)
      })
    } catch { }
    return $true
  }
  [OwlMirrorWin32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $rows
}

# ---------------------------------------------------------------------------
# WGC capture (lazy WinRT literals + opaque COM objects)
# ---------------------------------------------------------------------------
function Start-MirrorCapture([IntPtr]$hwndPtr) {
  if (-not ('OwlMirror.CaptureInterop' -as [type])) {
    if (-not $script:SwrPath) {
        $script:SwrPath = [Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089').Location
      }
      Add-Type -Path (Join-Path $PSScriptRoot 'windows-capture.cs') -ReferencedAssemblies @($script:SwrPath)
  }
  $deviceObj = [OwlMirror.CaptureInterop]::CreateDirect3DDevice()
  $itemPtr = [OwlMirror.CaptureInterop]::CreateItemForWindow($hwndPtr)
  $item = [System.Runtime.InteropServices.Marshal]::GetObjectForIUnknown($itemPtr)

  $rect = New-Object OwlMirrorWin32+RECT
  [OwlMirrorWin32]::GetClientRect($hwndPtr, [ref]$rect) | Out-Null
  $size = New-Object Windows.Graphics.SizeInt32
  $size.Width = $rect.Right - $rect.Left
  $size.Height = $rect.Bottom - $rect.Top
  if ($size.Width -le 0 -or $size.Height -le 0) { throw "window client size is empty" }

  $fmt = [Windows.Graphics.DirectX.DirectXPixelFormat]::B8G8R8A8UIntNormalized
  $framePool = [Windows.Graphics.Capture.Direct3D11CaptureFramePool]::CreateFreeThreaded($deviceObj, $fmt, 2, $size)
  $session = $framePool.CreateCaptureSession($item)
  try { $session.IsCursorCaptureEnabled = $false } catch { }
  try { $session.IsBorderRequired = $false } catch { }
  $session.StartCapture()
  return @{ pool = $framePool; session = $session }
}

function Get-FrameJpeg($framePool, [int]$quality, [int]$maxWidth, [int]$timeoutMs, [ref]$outW, [ref]$outH) {
  $deadline = [Environment]::TickCount + $timeoutMs
  $frame = $null
  while ([Environment]::TickCount -lt $deadline) {
    $frame = $framePool.TryGetNextFrame()
    if ($frame) { break }
    Start-Sleep -Milliseconds 4
  }
  if (-not $frame) { return $null }
  try {
    $softOp = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromSurfaceAsync($frame.Surface)
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $asTask = $asTaskGeneric.MakeGenericMethod([Windows.Graphics.Imaging.SoftwareBitmap])
    $netTask = $asTask.Invoke($null, @($softOp))
    $netTask.Wait(-1) | Out-Null
    $soft = $netTask.Result
    try {
      $sw = $soft.PixelWidth; $sh = $soft.PixelHeight
      $scale = 1.0
      if ($maxWidth -gt 0 -and $sw -gt $maxWidth) { $scale = $maxWidth / $sw }
      $dw = [Math]::Max(1, [int][Math]::Round($sw * $scale))
      $dh = [Math]::Max(1, [int][Math]::Round($sh * $scale))
      $outW.Value = $dw; $outH.Value = $dh

      $buffer = $soft.LockBuffer([Windows.Graphics.Imaging.BitmapBufferAccessMode]::Read)
      try {
        $pixels = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::ToArray($buffer)
      } finally { $buffer.Dispose() }

      $bmp = New-Object System.Drawing.Bitmap($dw, $dh, ($dw * 4), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb, [System.Runtime.InteropServices.Marshal]::UnsafeAddrOfPinnedArrayElement($pixels, 0))
      try {
        $stream = New-Object System.IO.MemoryStream
        try {
          $jpegCodec = $null
          foreach ($codec in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {
            if ($codec.MimeType -eq 'image/jpeg') { $jpegCodec = $codec; break }
          }
          $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
          $q = [Math]::Max(1, [Math]::Min(100, $quality))
          $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
          $bmp.Save($stream, $jpegCodec, $encParams)
          return $stream.ToArray()
        } finally { $stream.Dispose() }
      } finally { $bmp.Dispose() }
    } finally { $soft.Dispose() }
  } finally { $frame.Dispose() }
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
switch ($Command) {

  'list' {
    Add-Type -AssemblyName System.Drawing
    foreach ($row in (Get-WindowRows)) {
      $json = '{"event":"window","hwnd":' + $row.hwnd +
        ',"title":"' + (Escape-Json $row.title) +
        '","process":"' + (Escape-Json $row.process) +
        '","w":' + $row.w + ',"h":' + $row.h +
        ',"minimized":' + ($row.minimized.ToString().ToLower()) +
        ',"class":"' + (Escape-Json $row.cls) + '"}'
      Write-JsonLine $json
    }
    Write-JsonLine '{"event":"ready"}'
  }

  'restore' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $ok = [OwlMirrorWin32]::RestoreByScRestore([IntPtr]$Hwnd)
    Write-JsonLine ('{"event":"restored","ok":' + ($ok.ToString().ToLower()) + '}')
    Write-JsonLine '{"event":"ready"}'
  }

  'launch' {
    # 应用宝电脑版: registry uninstall entry -> DisplayIcon path -> sibling launcher
    $paths = @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $entry = $null
    foreach ($path in $paths) {
      $hit = Get-ItemProperty $path -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq '腾讯应用宝' } |
        Select-Object -First 1
      if ($hit) { $entry = $hit; break }
    }
    if (-not $entry -or -not $entry.DisplayIcon) {
      Write-JsonLine '{"event":"error","message":"Androws (YingYongBao PC) not found in registry"}'
      exit 1
    }
    $iconPath = ($entry.DisplayIcon -split ',')[0].Trim()
    $dir = Split-Path -Parent $iconPath
    $launcher = Join-Path $dir 'AndrowsLauncher.exe'
    if (Test-Path $launcher) {
      Start-Process -FilePath $launcher -WorkingDirectory $dir
      Write-JsonLine '{"event":"launched","how":"launcher"}'
    } elseif (Test-Path $iconPath) {
      Start-Process -FilePath $iconPath -WorkingDirectory $dir
      Write-JsonLine '{"event":"launched","how":"displayicon"}'
    } else {
      Write-JsonLine '{"event":"error","message":"launcher exe not found: ' + (Escape-Json $launcher) + '"}'
      exit 1
    }
    Write-JsonLine '{"event":"ready"}'
  }

  'capture' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $hwndPtr = [IntPtr]$Hwnd
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    Add-Type -AssemblyName System.Drawing

    if (-not ('OwlMirror.CaptureInterop' -as [type])) {
      if (-not $script:SwrPath) {
        $script:SwrPath = [Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089').Location
      }
      Add-Type -Path (Join-Path $PSScriptRoot 'windows-capture.cs') -ReferencedAssemblies @($script:SwrPath)
    }

    if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
      [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
      Start-Sleep -Milliseconds 900
    }
    if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
      Write-JsonLine '{"event":"error","message":"window is minimized and could not be restored"}'
      exit 1
    }

    $capture = Start-MirrorCapture $hwndPtr
    $framePool = $capture.pool
    Write-JsonLine '{"event":"status","iconic":false,"autoRestored":0,"frameSeq":0}'

    $lastIconic = $false
    $lastStatusTick = [System.Diagnostics.Stopwatch]::StartNew()
    $seq = 0

    while ($true) {
      try {
        $iconic = [OwlMirrorWin32]::IsIconic($hwndPtr)
        if ($iconic -ne $lastIconic -or $lastStatusTick.ElapsedMilliseconds -gt 5000) {
          $lastIconic = $iconic
          $lastStatusTick.Restart()
          Write-JsonLine ('{"event":"status","iconic":' + ($iconic.ToString().ToLower()) + ',"autoRestored":' + $script:AutoRestored + ',"frameSeq":' + $seq + '}')
        }
        if ($iconic) {
          if (-not $NoAutoRestore) {
            # BitDock 等停靠工具会把后台窗口收纳成最小化；SC_RESTORE 拉回来继续抓
            [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
            $script:AutoRestored++
            Write-JsonLine ('{"event":"status","iconic":false,"autoRestored":' + $script:AutoRestored + ',"frameSeq":' + $seq + ',"autoRestore":true}')
          }
          Start-Sleep -Milliseconds 600
          continue
        }

        $w = 0; $h = 0
        $jpeg = Get-FrameJpeg $framePool $Quality $MaxWidth $FrameTimeoutMs ([ref]$w) ([ref]$h)
        if ($jpeg) {
          $seq++
          $b64 = [Convert]::ToBase64String($jpeg)
          Write-JsonLine ('{"event":"frame","seq":' + $seq + ',"w":' + $w + ',"h":' + $h + ',"data":"' + $b64 + '"}')
        }
        Start-Sleep -Milliseconds 1
      } catch {
        Write-JsonLine ('{"event":"error","message":"' + (Escape-Json $_.Exception.Message) + '"}')
        try { $capture.session.Close() } catch { }
        try { $framePool.Dispose() } catch { }
        exit 1
      }
    }
  }
}
