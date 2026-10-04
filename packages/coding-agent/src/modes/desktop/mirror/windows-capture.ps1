# owl mirror worker: enumerate windows / WGC capture loop / restore / launch.
# JSON lines on stdout (UTF-8), one event per line:
#   {"event":"window","hwnd":N,"title":"...","process":"...","w":N,"h":N,"minimized":bool,"class":"..."}
#   {"event":"frame","seq":N,"w":N,"h":N,"data":"<base64 jpeg>"}
#   {"event":"status","iconic":bool,"autoRestored":N,"frameSeq":N}
#   {"event":"error","message":"..."}
#   {"event":"ready"}
#
# 捕获内核（windows-capture.cs）由本脚本用进程外 csc 带系统 winmd 引用编译成
# DLL 并缓存（%TEMP% 按 cs 内容哈希），再字节加载 —— 进程内 Add-Type 既没有
# winmd 引用能力，net48 的 IInspectable vtable 互操作也不可靠。文件必须保存为
# UTF-8 with BOM（PowerShell 5.1 的要求，否则中文字符串按 GBK 误读）。
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
# capture kernel: compile windows-capture.cs via out-of-proc csc (winmd refs),
# cache by content hash, load bytes.
# ---------------------------------------------------------------------------
function Get-CaptureAssembly {
  $csPath = Join-Path $PSScriptRoot 'windows-capture.cs'
  $csBytes = [IO.File]::ReadAllBytes($csPath)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha.ComputeHash($csBytes)
    $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').Substring(0, 16).ToLower()
  } finally { $sha.Dispose() }

  $cacheDir = Join-Path ([IO.Path]::GetTempPath()) ('owl-mirror-' + $hash)
  $dllPath = Join-Path $cacheDir 'OwlMirror.Capture.dll'
  if (Test-Path $dllPath) {
    return [IO.File]::ReadAllBytes($dllPath)
  }

  $cscCandidates = @(
    (Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  $csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $csc) { throw 'csc.exe (net48) not found' }

  $winmd = Join-Path $env:windir 'System32\WinMetadata'
  $gac = 'C:\Windows\Microsoft.Net\assembly\GAC_MSIL'
  $refs = @(
    (Join-Path $winmd 'Windows.Foundation.winmd'),
    (Join-Path $winmd 'Windows.Graphics.winmd'),
    (Join-Path $winmd 'Windows.UI.winmd'),
    (Join-Path $winmd 'Windows.Storage.winmd'),
    'System.Runtime.WindowsRuntime.dll'
  )
  foreach ($name in @('System.Runtime', 'System.ObjectModel', 'System.Collections')) {
    $dir = Get-ChildItem (Join-Path $gac $name) -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($dir) { $refs += (Join-Path $dir.FullName ($name + '.dll')) }
  }

  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $argList = @('-nologo', '-target:library', ('-out:' + $dllPath), $csPath)
  foreach ($ref in $refs) { $argList += ('-r:' + $ref) }
  $stdout = & $csc @argList 2>&1
  if (-not (Test-Path $dllPath)) {
    $detail = ($stdout | Out-String)
    throw ('capture kernel compile failed: ' + $detail.Substring(0, [Math]::Min(600, $detail.Length)))
  }
  return [IO.File]::ReadAllBytes($dllPath)
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
switch ($Command) {

  'list' {
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

    if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
      [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
      Start-Sleep -Milliseconds 900
    }
    if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
      Write-JsonLine '{"event":"error","message":"window is minimized and could not be restored"}'
      exit 1
    }

    $asmBytes = Get-CaptureAssembly
    [void][System.Reflection.Assembly]::Load($asmBytes)
    $session = [OwlMirror.CaptureSession]::Start($hwndPtr)
    Write-JsonLine '{"event":"status","iconic":false,"autoRestored":0,"frameSeq":0}'

    $lastIconic = $false
    $lastStatusTick = [System.Diagnostics.Stopwatch]::StartNew()

    while ($true) {
      try {
        $iconic = [OwlMirrorWin32]::IsIconic($hwndPtr)
        if ($iconic -ne $lastIconic -or $lastStatusTick.ElapsedMilliseconds -gt 5000) {
          $lastIconic = $iconic
          $lastStatusTick.Restart()
          Write-JsonLine ('{"event":"status","iconic":' + ($iconic.ToString().ToLower()) + ',"autoRestored":' + $script:AutoRestored + ',"frameSeq":' + $session.FrameSeq + '}')
        }
        if ($iconic) {
          if (-not $NoAutoRestore) {
            # BitDock 等停靠工具会把后台窗口收纳成最小化；SC_RESTORE 拉回来继续抓
            [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
            $script:AutoRestored++
            Write-JsonLine ('{"event":"status","iconic":false,"autoRestored":' + $script:AutoRestored + ',"frameSeq":' + $session.FrameSeq + ',"autoRestore":true}')
          }
          Start-Sleep -Milliseconds 600
          continue
        }

        $w = 0; $h = 0
        $jpeg = $session.GrabFrameJpeg($FrameTimeoutMs, $Quality, $MaxWidth, [ref]$w, [ref]$h)
        if ($jpeg) {
          $b64 = [Convert]::ToBase64String($jpeg)
          Write-JsonLine ('{"event":"frame","seq":' + $session.FrameSeq + ',"w":' + $w + ',"h":' + $h + ',"data":"' + $b64 + '"}')
        }
        # GrabFrameJpeg 内部已按超时等帧，这里只防硬自旋
        Start-Sleep -Milliseconds 2
      } catch {
        Write-JsonLine ('{"event":"error","message":"' + (Escape-Json $_.Exception.Message) + '"}')
        try { $session.Dispose() } catch { }
        exit 1
      }
    }
  }
}
