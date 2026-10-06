# owl computer-use driver worker：长驻 PowerShell 侧车。
#
# stdin/stdout JSON 行协议（UTF-8）：
#   请求  {"id":N,"cmd":"screenshot","monitor":-1,"maxWidth":1568,"quality":80}
#         {"id":N,"cmd":"click","x":100,"y":200,"button":"left","double":false}
#         {"id":N,"cmd":"type","text":"..."}
#         {"id":N,"cmd":"key","down":[17],"tap":[83]}
#         {"id":N,"cmd":"scroll","x":100,"y":200,"delta":-120,"horizontal":false}
#         {"id":N,"cmd":"windows"}
#         {"id":N,"cmd":"focus","hwnd":1234} / {"id":N,"cmd":"restore","hwnd":1234}
#         {"id":N,"cmd":"cursor"}
#   响应  {"id":N,"ok":true,"data":{...}} / {"id":N,"ok":false,"error":"..."}
#   启动  {"event":"ready"}（内核编译+加载完成后） / {"event":"error","message":"..."}
#
# 捕获/输入内核（computer-kernel.cs）由本脚本用进程外 csc 编成 DLL 缓存到
# %TEMP%（按 cs 内容哈希），再字节加载。stdin 按原始字节读再 UTF-8 解码 ——
# PS 5.1 重定向 stdin 默认走 OEM 代码页，直接 [Console]::In 会让 type 的
# 非 ASCII 文本乱码。文件必须保存为 UTF-8 with BOM（PowerShell 5.1 要求）。

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-JsonLine([string]$line) {
	$bytes = $Utf8NoBom.GetBytes($line + [Environment]::NewLine)
	$stdout = [Console]::OpenStandardOutput()
	$stdout.Write($bytes, 0, $bytes.Length)
	$stdout.Flush()
}

function Read-RequestLine {
	# 返回原始 UTF-8 文本行；EOF 返回 $null；空行跳过。
	$stream = [Console]::OpenStandardInput()
	while ($true) {
		$bytes = New-Object System.Collections.Generic.List[byte]
		while ($true) {
			$b = $stream.ReadByte()
			if ($b -eq -1) {
				if ($bytes.Count -eq 0) { return $null }
				return [Text.Encoding]::UTF8.GetString($bytes.ToArray())
			}
			if ($b -eq 10) { break }
			if ($b -eq 13) { continue }
			$bytes.Add([byte]$b) | Out-Null
		}
		if ($bytes.Count -gt 0) { return [Text.Encoding]::UTF8.GetString($bytes.ToArray()) }
	}
}

# ---------------------------------------------------------------------------
# 窗口互操作（枚举/聚焦/恢复）：纯 user32，进程内 Add-Type 即可。
# ---------------------------------------------------------------------------
$user32 = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace OwlComputerUse.Win32
{
    public struct WindowRow
    {
        public long Hwnd;
        public string Title;
        public string Class;
        public string Process;
        public int Pid;
        public int Left; public int Top; public int Right; public int Bottom;
        public bool Minimized;
        public bool Foreground;
    }

    public static class WindowTools
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int left; public int top; public int right; public int bottom; }

        private delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
        [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, ref RECT rect);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processIdOut);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int x; public int y; }

        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOOLWINDOW = 0x80;
        private const int SW_RESTORE = 9;

        private static readonly List<WindowRow> Rows = new List<WindowRow>();
        private static IntPtr s_foreground;

        /// <summary>屏幕坐标（物理像素）处的顶层窗口信息；给 click 的反馈用。</summary>
        public static WindowRow InfoAt(int x, int y)
        {
            POINT point = new POINT();
            point.x = x;
            point.y = y;
            IntPtr hwnd = WindowFromPoint(point);
            if (hwnd == IntPtr.Zero) return Describe(IntPtr.Zero);
            IntPtr root = GetAncestor(hwnd, 2); // GA_ROOT：点在子控件上时归到顶层窗口
            return Describe(root == IntPtr.Zero ? hwnd : root);
        }

        public static WindowRow ForegroundInfo()
        {
            return Describe(GetForegroundWindow());
        }

        private static WindowRow Describe(IntPtr hwnd)
        {
            WindowRow row = new WindowRow();
            row.Hwnd = hwnd.ToInt64();
            if (hwnd == IntPtr.Zero) return row;
            int length = GetWindowTextLength(hwnd);
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(hwnd, title, title.Capacity);
            row.Title = title.ToString();
            StringBuilder className = new StringBuilder(256);
            GetClassName(hwnd, className, className.Capacity);
            row.Class = className.ToString();
            uint pid = 0;
            GetWindowThreadProcessId(hwnd, out pid);
            row.Pid = (int)pid;
            row.Process = ProcessName(pid);
            row.Minimized = IsIconic(hwnd);
            row.Foreground = GetForegroundWindow() == hwnd;
            RECT rect = new RECT();
            if (GetWindowRect(hwnd, ref rect))
            {
                row.Left = rect.left; row.Top = rect.top;
                row.Right = rect.right; row.Bottom = rect.bottom;
            }
            return row;
        }

        public static List<WindowRow> ListWindows()
        {
            Rows.Clear();
            s_foreground = GetForegroundWindow();
            EnumWindows(delegate(IntPtr hwnd, IntPtr lparam)
            {
                if (!IsWindowVisible(hwnd)) return true;
                if (IsIconic(hwnd))
                {
                    // 最小化窗口 GetWindowTextLength 仍有效，保留（agent 可恢复它）。
                }
                int length = GetWindowTextLength(hwnd);
                if (length <= 0) return true;
                if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
                RECT rect = new RECT();
                if (!GetWindowRect(hwnd, ref rect)) return true;
                if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return true;

                WindowRow row = new WindowRow();
                row.Hwnd = hwnd.ToInt64();
                StringBuilder title = new StringBuilder(length + 1);
                GetWindowText(hwnd, title, title.Capacity);
                row.Title = title.ToString();
                StringBuilder className = new StringBuilder(256);
                GetClassName(hwnd, className, className.Capacity);
                row.Class = className.ToString();
                uint pid = 0;
                GetWindowThreadProcessId(hwnd, out pid);
                row.Pid = (int)pid;
                row.Process = ProcessName(pid);
                row.Left = rect.left; row.Top = rect.top;
                row.Right = rect.right; row.Bottom = rect.bottom;
                row.Minimized = IsIconic(hwnd);
                row.Foreground = hwnd == s_foreground;
                Rows.Add(row);
                return true;
            }, IntPtr.Zero);
            return new List<WindowRow>(Rows);
        }

        private static string ProcessName(uint pid)
        {
            try
            {
                return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
            }
            catch
            {
                return "";
            }
        }

        public static bool Restore(long hwnd)
        {
            return ShowWindow(new IntPtr(hwnd), SW_RESTORE);
        }

        public static bool Focus(long hwnd)
        {
            IntPtr target = new IntPtr(hwnd);
            if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
            // 验证式聚焦：前台锁容易被调用方（如全屏应用、通知中心）立刻抢回，
            // SetForegroundWindow 的返回值不可信 —— 每次 attempt 后以
            // GetForegroundWindow 实测为准，重试三次。
            for (int attempt = 0; attempt < 3; attempt++)
            {
                IntPtr foreground = GetForegroundWindow();
                if (foreground == target) return true;

                uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
                uint currentThread = GetCurrentThreadId();
                bool attached = false;
                if (foregroundThread != 0 && foregroundThread != currentThread)
                    attached = AttachThreadInput(currentThread, foregroundThread, true);
                try
                {
                    SetForegroundWindow(target);
                }
                finally
                {
                    if (attached) AttachThreadInput(currentThread, foregroundThread, false);
                }
                System.Threading.Thread.Sleep(90);
                if (GetForegroundWindow() == target) return true;

                // 回退：伪造一次 ALT 击键绕过前台锁。
                keybd_event(0x12, 0, 0, IntPtr.Zero);
                try { SetForegroundWindow(target); }
                finally { keybd_event(0x12, 0, 2, IntPtr.Zero); }
                System.Threading.Thread.Sleep(90);
                if (GetForegroundWindow() == target) return true;
            }
            return GetForegroundWindow() == target;
        }
    }
}
'@
Add-Type -TypeDefinition $user32 -Language CSharp

# ---------------------------------------------------------------------------
# 内核编译缓存（进程外 csc，net48）
# ---------------------------------------------------------------------------
function Get-KernelAssembly {
	$csPath = Join-Path $PSScriptRoot 'computer-kernel.cs'
	$csBytes = [IO.File]::ReadAllBytes($csPath)
	$sha = [System.Security.Cryptography.SHA256]::Create()
	try {
		$hash = ([System.BitConverter]::ToString($sha.ComputeHash($csBytes))).Replace('-', '').Substring(0, 16).ToLower()
	} finally { $sha.Dispose() }

	$cacheDir = Join-Path ([IO.Path]::GetTempPath()) ('owl-cu-' + $hash)
	$dllPath = Join-Path $cacheDir 'OwlComputerUse.Kernel.dll'
	if (Test-Path $dllPath) {
		return [IO.File]::ReadAllBytes($dllPath)
	}

	$cscCandidates = @(
		(Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
		(Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
	)
	$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
	if (-not $csc) { throw 'csc.exe (net48) not found' }

	New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
	$stdout = & $csc -nologo -target:library ('-out:' + $dllPath) '-r:System.Drawing.dll' $csPath 2>&1
	if (-not (Test-Path $dllPath)) {
		$detail = ($stdout | Out-String)
		throw ('computer-use kernel compile failed: ' + $detail.Substring(0, [Math]::Min(600, $detail.Length)))
	}
	return [IO.File]::ReadAllBytes($dllPath)
}

# ---------------------------------------------------------------------------
# 启动：加载内核 + DPI 感知，然后广播 ready
# ---------------------------------------------------------------------------
try {
	[Reflection.Assembly]::Load([byte[]](Get-KernelAssembly)) | Out-Null
	[OwlComputerUse.Kernel]::Initialize()
	Write-JsonLine '{"event":"ready"}'
} catch {
	$message = $_.Exception.Message.Replace('"', "'")
	Write-JsonLine ('{"event":"error","message":"' + $message + '"}')
	exit 1
}

function Convert-ToJsonLine([hashtable]$data) {
	return $data | ConvertTo-Json -Compress -Depth 6
}

function Convert-RowToPayload($row) {
	if ($null -eq $row -or $row.Hwnd -eq 0) { return $null }
	return @{
		hwnd       = $row.Hwnd
		title      = $row.Title
		process    = $row.Process
		pid        = $row.Pid
		minimized  = $row.Minimized
		foreground = $row.Foreground
	}
}

function Get-WindowRowsPayload {
	$rows = [OwlComputerUse.Win32.WindowTools]::ListWindows()
	$list = @()
	foreach ($row in $rows) {
		$list += @{
			hwnd       = $row.Hwnd
			title      = $row.Title
			class      = $row.Class
			process    = $row.Process
			pid        = $row.Pid
			x          = $row.Left
			y          = $row.Top
			w          = ($row.Right - $row.Left)
			h          = ($row.Bottom - $row.Top)
			minimized  = $row.Minimized
			foreground = $row.Foreground
		}
	}
	return @{ windows = $list }
}

# ---------------------------------------------------------------------------
# 主循环：一行请求 → 一行响应
# ---------------------------------------------------------------------------
while ($true) {
	$line = Read-RequestLine
	if ($null -eq $line) { break }
	if ($line.Trim() -eq '') { continue }

	$req = $null
	try { $req = $line | ConvertFrom-Json } catch {
		Write-JsonLine '{"id":0,"ok":false,"error":"bad request json"}'
		continue
	}
	$id = 0
	if ($null -ne $req.id) { $id = [int]$req.id }

	try {
		$data = $null
		switch ($req.cmd) {
			'screenshot' {
				$r = [OwlComputerUse.Kernel]::Capture([int]$req.monitor, [int]$req.maxWidth, [int]$req.quality)
				$data = @{
					imageWidth  = $r.ImageWidth
					imageHeight = $r.ImageHeight
					screenWidth = $r.ScreenWidth
					screenHeight = $r.ScreenHeight
					originX     = $r.OriginX
					originY     = $r.OriginY
					jpeg        = [Convert]::ToBase64String($r.Jpeg)
				}
			}
			'click' {
				# expectHwnd 预检版：给了 expectHwnd 时，注入前先看目标点上是不是
				# 预期窗口，不是就一个键都不碰（防 z-order 变化/前台被抢导致点偏）。
				$hit = [OwlComputerUse.Win32.WindowTools]::InfoAt([int]$req.x, [int]$req.y)
				if ($null -ne $req.expectHwnd -and [long]$req.expectHwnd -gt 0 -and $hit.Hwnd -ne [long]$req.expectHwnd) {
					$data = @{ clicked = $false; blocked = $true; x = [int]$req.x; y = [int]$req.y; window = Convert-RowToPayload $hit }
					break
				}
				[OwlComputerUse.Kernel]::MoveMouse([int]$req.x, [int]$req.y) | Out-Null
				Start-Sleep -Milliseconds 30
				[OwlComputerUse.Kernel]::ClickMouse([string]$req.button, [bool]$req.double)
				Start-Sleep -Milliseconds 30
				$pos = [OwlComputerUse.Kernel]::CursorPosition()
				$hit = [OwlComputerUse.Win32.WindowTools]::InfoAt($pos[0], $pos[1])
				$data = @{ clicked = $true; blocked = $false; x = $pos[0]; y = $pos[1]; window = Convert-RowToPayload $hit }
			}
			'type' {
				$fg = [OwlComputerUse.Win32.WindowTools]::ForegroundInfo()
				if ($null -ne $req.expectHwnd -and [long]$req.expectHwnd -gt 0 -and $fg.Hwnd -ne [long]$req.expectHwnd) {
					# 前台不是预期窗口：一个字都不打，防止快捷键误触别的应用。
					$data = @{ typed = $false; blocked = $true; foreground = Convert-RowToPayload $fg }
					break
				}
				[OwlComputerUse.Kernel]::TypeText([string]$req.text)
				# 键入时的前台窗口 —— 模型据此发现「打进了别的窗口」。
				$data = @{ typed = $true; blocked = $false; foreground = Convert-RowToPayload ([OwlComputerUse.Win32.WindowTools]::ForegroundInfo()) }
			}
			'key' {
				$fg = [OwlComputerUse.Win32.WindowTools]::ForegroundInfo()
				if ($null -ne $req.expectHwnd -and [long]$req.expectHwnd -gt 0 -and $fg.Hwnd -ne [long]$req.expectHwnd) {
					$data = @{ sent = $false; blocked = $true; foreground = Convert-RowToPayload $fg }
					break
				}
				$down = @()
				if ($null -ne $req.down) { foreach ($v in $req.down) { $down += [int]$v } }
				$tap = @()
				if ($null -ne $req.tap) { foreach ($v in $req.tap) { $tap += [int]$v } }
				[OwlComputerUse.Kernel]::KeyCombo([int[]]$down, [int[]]$tap)
				$data = @{ sent = $true; blocked = $false; foreground = Convert-RowToPayload ([OwlComputerUse.Win32.WindowTools]::ForegroundInfo()) }
			}
			'scroll' {
				$hit = [OwlComputerUse.Win32.WindowTools]::InfoAt([int]$req.x, [int]$req.y)
				if ($null -ne $req.expectHwnd -and [long]$req.expectHwnd -gt 0 -and $hit.Hwnd -ne [long]$req.expectHwnd) {
					$data = @{ scrolled = $false; blocked = $true; window = Convert-RowToPayload $hit }
					break
				}
				[OwlComputerUse.Kernel]::MoveMouse([int]$req.x, [int]$req.y) | Out-Null
				Start-Sleep -Milliseconds 30
				$horizontal = $false
				if ($req.horizontal) { $horizontal = [bool]$req.horizontal }
				[OwlComputerUse.Kernel]::ScrollWheel([int]$req.delta, $horizontal)
				$data = @{ scrolled = $true; blocked = $false }
			}
			'windows' {
				$data = Get-WindowRowsPayload
			}
			'focus' {
				$ok = [OwlComputerUse.Win32.WindowTools]::Focus([long]$req.hwnd)
				Start-Sleep -Milliseconds 60
				$data = @{ focused = $ok }
			}
			'restore' {
				$ok = [OwlComputerUse.Win32.WindowTools]::Restore([long]$req.hwnd)
				Start-Sleep -Milliseconds 80
				$data = @{ restored = $ok }
			}
			'cursor' {
				$pos = [OwlComputerUse.Kernel]::CursorPosition()
				$data = @{ x = $pos[0]; y = $pos[1] }
			}
			default {
				throw ('unknown cmd: ' + $req.cmd)
			}
		}
		Write-JsonLine (Convert-ToJsonLine @{ id = $id; ok = $true; data = $data })
	} catch {
		$message = $_.Exception.Message.Replace('"', "'")
		Write-JsonLine (Convert-ToJsonLine @{ id = $id; ok = $false; error = $message })
	}
}
