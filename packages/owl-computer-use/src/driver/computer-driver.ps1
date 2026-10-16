# owl computer-use driver worker：长驻 PowerShell 侧车。
#
# stdin/stdout JSON 行协议（UTF-8）：
#   请求  {"id":N,"cmd":"observe","hwnd":1234,"includeImage":true,"maxWidth":1568,"quality":80,"captureKernelPath":"..."}
#         {"id":N,"cmd":"act","observationId":"...","action":"set_value","elementId":"e2","text":"..."}
#         {"id":N,"cmd":"act","observationId":"...","action":"click","inputMode":"foreground","x":100,"y":200}
#         {"id":N,"cmd":"release"}
#   保留只读 screenshot/windows/cursor；旧裸写命令明确拒绝。
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
	if ('OwlComputerUse.NativeProtocol' -as [type]) {
		[OwlComputerUse.NativeProtocol]::WriteJsonLine($line)
		return
	}
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
        public static Func<long, bool> IgnoreWindow;
        public static Func<int, int, long> HitTestWindow;
        public static string LastFocusDiagnostics = "";
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
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetActiveWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);

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
            IntPtr hwnd = HitTestWindow == null ? WindowFromPoint(point) : new IntPtr(HitTestWindow(x, y));
            if (hwnd == IntPtr.Zero) return Describe(IntPtr.Zero);
            IntPtr root = GetAncestor(hwnd, 2); // GA_ROOT：点在子控件上时归到顶层窗口
            return Describe(root == IntPtr.Zero ? hwnd : root);
        }

        public static WindowRow ForegroundInfo()
        {
            return Describe(GetForegroundWindow());
        }

        public static WindowRow Describe(IntPtr hwnd)
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
                if (IgnoreWindow != null && IgnoreWindow(hwnd.ToInt64())) return true;
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
            StringBuilder diagnostics = new StringBuilder();
            uint targetPid;
            uint targetThread = GetWindowThreadProcessId(target, out targetPid);
            diagnostics.Append("target=").Append(hwnd).Append(" targetPid=").Append(targetPid).Append(" targetThread=").Append(targetThread);
            LastFocusDiagnostics = diagnostics.ToString();
            if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
            // 验证式聚焦：前台锁容易被调用方（如全屏应用、通知中心）立刻抢回，
            // SetForegroundWindow 的返回值不可信 —— 每次 attempt 后以
            // GetForegroundWindow 实测为准，重试三次。
            for (int attempt = 0; attempt < 3; attempt++)
            {
                IntPtr foreground = GetForegroundWindow();
                if (foreground == target) return true;

                uint foregroundPid;
                uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
                uint currentThread = GetCurrentThreadId();
                bool attached = false;
                int attachError = 0;
                if (foregroundThread != 0 && foregroundThread != currentThread)
                {
                    SetLastError(0);
                    attached = AttachThreadInput(currentThread, foregroundThread, true);
                    attachError = Marshal.GetLastWin32Error();
                }
                bool requested = false;
                int foregroundError = 0;
                bool targetAttached = false, brought = false;
                int targetAttachError = 0, bringError = 0, activeError = 0;
                IntPtr activePrevious = IntPtr.Zero;
                try
                {
                    if (targetThread != 0 && targetThread != currentThread && (!attached || targetThread != foregroundThread))
                    {
                        SetLastError(0);
                        targetAttached = AttachThreadInput(currentThread, targetThread, true);
                        targetAttachError = Marshal.GetLastWin32Error();
                    }
                    if (GetForegroundWindow() != target)
                    {
                        SetLastError(0); brought = BringWindowToTop(target); bringError = Marshal.GetLastWin32Error();
                    }
                    if (GetForegroundWindow() != target)
                    {
                        SetLastError(0); activePrevious = SetActiveWindow(target); activeError = Marshal.GetLastWin32Error();
                    }
                    if (GetForegroundWindow() != target)
                    {
                        SetLastError(0); requested = SetForegroundWindow(target); foregroundError = Marshal.GetLastWin32Error();
                    }
                }
                finally
                {
                    if (targetAttached) AttachThreadInput(currentThread, targetThread, false);
                    if (attached) AttachThreadInput(currentThread, foregroundThread, false);
                }
                System.Threading.Thread.Sleep(90);
                IntPtr actual = GetForegroundWindow();
                uint actualPid; GetWindowThreadProcessId(actual, out actualPid);
                diagnostics.Append("; attempt=").Append(attempt + 1).Append(" currentThread=").Append(currentThread)
                    .Append(" before=").Append(foreground.ToInt64()).Append(" beforePid=").Append(foregroundPid)
                    .Append(" beforeThread=").Append(foregroundThread).Append(" attached=").Append(attached)
                    .Append(" attachError=").Append(attachError).Append(" targetAttached=").Append(targetAttached)
                    .Append(" targetAttachError=").Append(targetAttachError).Append(" brought=").Append(brought).Append(" bringError=").Append(bringError)
                    .Append(" activePrevious=").Append(activePrevious.ToInt64()).Append(" activeError=").Append(activeError).Append(" setForeground=").Append(requested)
                    .Append(" foregroundError=").Append(foregroundError).Append(" after=").Append(actual.ToInt64()).Append(" afterPid=").Append(actualPid);
                LastFocusDiagnostics = diagnostics.ToString();
                if (actual == target) return true;

                // Do not send an untagged ALT into a different foreground application.
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
	$overlayPath = Join-Path $PSScriptRoot 'computer-control-overlay.cs'
	$sourceBytes = New-Object IO.MemoryStream
	try {
		foreach ($name in @('computer-kernel.cs', 'computer-control-overlay.cs', 'computer-uia.cs')) {
			$bytes = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $name))
			$sourceBytes.Write($bytes, 0, $bytes.Length)
		}
		$csBytes = $sourceBytes.ToArray()
	} finally { $sourceBytes.Dispose() }
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
	$stdout = & $csc -nologo -target:library ('-out:' + $dllPath) '-r:System.Drawing.dll' '-r:System.Windows.Forms.dll' $csPath $overlayPath 2>&1
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
	$overlayType = [OwlComputerUse.ControlOverlay]
	[OwlComputerUse.Win32.WindowTools]::IgnoreWindow = [Delegate]::CreateDelegate([Func[long,bool]], $overlayType.GetMethod('RecognizesWindow'))
	[OwlComputerUse.Win32.WindowTools]::HitTestWindow = [Delegate]::CreateDelegate([Func[int,int,long]], $overlayType.GetMethod('WindowAtPoint'))
	[OwlComputerUse.Kernel]::Initialize()
	[OwlComputerUse.DesktopGuard]::Start()
	Write-JsonLine '{"event":"ready"}'
} catch {
	$message = $_.Exception.Message.Replace('"', "'")
	Write-JsonLine ('{"event":"error","message":"' + $message + '"}')
	exit 1
}

function Convert-ToJsonLine([hashtable]$data) {
	return $data | ConvertTo-Json -Compress -Depth 12
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

# Native observations contain private process identity and UIA runtime refs. Only the
# public projection leaves this worker. Every act consumes its token before validation.
$script:Observation = $null
$script:UiaExecutable = $null
$script:CaptureLoaded = $false

function Get-UiaExecutable {
	if ($script:UiaExecutable) { return $script:UiaExecutable }
	$source = Join-Path $PSScriptRoot 'computer-uia.cs'
	$sha = [Security.Cryptography.SHA256]::Create()
	try { $hash = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($source)))).Replace('-', '').Substring(0, 16) }
	finally { $sha.Dispose() }
	$cache = Join-Path ([IO.Path]::GetTempPath()) ('owl-cu-uia-' + $hash)
	$executable = Join-Path $cache 'OwlComputerUse.Uia.exe'
	if (-not (Test-Path -LiteralPath $executable)) {
		$csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
		if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
		$wpf = Join-Path (Split-Path $csc) 'WPF'
		New-Item -ItemType Directory -Force -Path $cache | Out-Null
		$argsList = @('-nologo', '-target:exe', ('-out:' + $executable), '-r:System.Web.Extensions.dll', '-r:System.Core.dll', $source)
		foreach ($name in @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')) { $argsList += ('-r:' + (Join-Path $wpf ($name + '.dll'))) }
		$compileOutput = & $csc @argsList 2>&1
		if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $executable)) { throw ('UIA helper compile failed: ' + ($compileOutput | Out-String)) }
	}
	$script:UiaExecutable = $executable
	return $executable
}

function Invoke-Uia($request) {
	$readOnly = $request.action -in @('observe', 'plan')
	if ($readOnly) {
		$result = [OwlComputerUse.DesktopGuard]::RunChild((Get-UiaExecutable), ($request | ConvertTo-Json -Depth 12 -Compress), 8000)
	} else {
		$result = [OwlComputerUse.DesktopGuard]::RunChild((Get-UiaExecutable), ($request | ConvertTo-Json -Depth 12 -Compress), 8000,
			[long]$request.hwnd, [long]$request.windowRevision, [long]$request.globalRevision, [bool]$request.exclusive,
			[bool]$request.showControl, [long]$request.controlRequestId, [string]$request.controlMode, [int]$request.testHoldMs)
	}
	if ($result.TimedOut) { return @{ status = $(if ($request.action -eq 'plan') { 'blocked' } else { 'unknown' }); code = $(if ($request.action -eq 'plan') { 'uia_plan_timeout' } else { 'uia_timeout' }); message = 'UIA helper timed out; no fallback was executed.' } }
	if ($result.ExitCode -ne 0 -or -not $result.Output.Trim()) {
		return @{ status = $(if ($readOnly -or $request.action -eq 'validate') { 'blocked' } else { 'unknown' }); code = 'uia_unavailable'; message = 'UIA helper could not return a result; no fallback was executed.' }
	}
	return $result.Output | ConvertFrom-Json
}

function Import-CaptureKernel([string]$source) {
	if ($script:CaptureLoaded) { return }
	if (-not $source -or -not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'WGC capture kernel unavailable' }
	$sha = [Security.Cryptography.SHA256]::Create()
	try { $hash = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($source)))).Replace('-', '').Substring(0, 16).ToLower() }
	finally { $sha.Dispose() }
	$cache = Join-Path ([IO.Path]::GetTempPath()) ('owl-mirror-' + $hash)
	$dll = Join-Path $cache 'OwlMirror.Capture.dll'
	if (-not (Test-Path -LiteralPath $dll)) {
		$csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
		if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
		$winmd = Join-Path $env:windir 'System32\WinMetadata'
		$references = @('System.Runtime.WindowsRuntime.dll')
		foreach ($name in @('Windows.Foundation', 'Windows.Graphics', 'Windows.UI', 'Windows.Storage')) { $references += (Join-Path $winmd ($name + '.winmd')) }
		$gac = Join-Path $env:windir 'Microsoft.NET\assembly\GAC_MSIL'
		foreach ($name in @('System.Runtime', 'System.ObjectModel', 'System.Collections')) {
			$directory = Get-ChildItem -LiteralPath (Join-Path $gac $name) -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($directory) { $references += (Join-Path $directory.FullName ($name + '.dll')) }
		}
		New-Item -ItemType Directory -Force -Path $cache | Out-Null
		$argsList = @('-nologo', '-target:library', ('-out:' + $dll), $source)
		foreach ($reference in $references) { $argsList += ('-r:' + $reference) }
		$compileOutput = & $csc @argsList 2>&1
		if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $dll)) { throw ('WGC capture compile failed: ' + ($compileOutput | Out-String)) }
	}
	[Reflection.Assembly]::Load([IO.File]::ReadAllBytes($dll)) | Out-Null
	$script:CaptureLoaded = $true
}

function Get-WindowIdentity([long]$hwnd) {
	if ([OwlComputerUse.ControlOverlay]::RecognizesWindow($hwnd)) { throw 'control_overlay_is_not_an_application_target' }
	if (-not [OwlComputerUse.DesktopGuard]::Exists($hwnd)) { throw 'target_gone' }
	$row = [OwlComputerUse.Win32.WindowTools]::Describe([IntPtr]$hwnd)
	$process = [Diagnostics.Process]::GetProcessById($row.Pid)
	try { $started = $process.StartTime.ToUniversalTime().Ticks }
	finally { $process.Dispose() }
	return @{ hwnd = $hwnd; pid = $row.Pid; started = $started; row = $row; rect = @($row.Left, $row.Top, ($row.Right - $row.Left), ($row.Bottom - $row.Top)) }
}

function Convert-FullWindow($row) {
	return @{ hwnd = $row.Hwnd; title = $row.Title; class = $row.Class; process = $row.Process; pid = $row.Pid;
		x = $row.Left; y = $row.Top; w = ($row.Right - $row.Left); h = ($row.Bottom - $row.Top); minimized = $row.Minimized; foreground = $row.Foreground }
}

function Invoke-Observe($request) {
	$script:Observation = $null
	$hwnd = [OwlComputerUse.DesktopGuard]::ForegroundHwnd()
	if ($null -ne $request.hwnd) { $hwnd = [long]$request.hwnd }
	$observationId = [Guid]::NewGuid().ToString('N')
	$diagnostics = New-Object 'System.Collections.Generic.List[string]'
	$public = @{ observationId = $observationId; target = $null; elements = @(); capabilities = @{ uia = $false; backgroundUia = $false; windowCapture = $false; input = [OwlComputerUse.DesktopGuard]::Monitoring } }
	try { $identity = Get-WindowIdentity $hwnd }
	catch {
		# Discovery still carries a one-use token so an explicitly authorized open_app
		# can proceed when the requested application has not been launched yet.
		$script:Observation = @{ id = $observationId; identity = $null; created = [DateTime]::UtcNow; elements = @{}; screenshot = $null }
		$public.diagnostics = @('target_unavailable: no window was focused, restored or launched'); return $public
	}
	$revision = [OwlComputerUse.DesktopGuard]::WindowRevision($hwnd)
	$public.target = Convert-FullWindow $identity.row
	$internalElements = @{}
	try {
		$uia = Invoke-Uia @{ action = 'observe'; hwnd = $hwnd }
		if ($uia.available -eq $true) {
			$public.capabilities.uia = $true
			$public.capabilities.backgroundUia = [OwlComputerUse.DesktopGuard]::Monitoring
			foreach ($element in $uia.elements) {
				$internalElements[[string]$element.id] = $element
				$row = @{ id = $element.id; name = $element.name; controlType = $element.controlType; enabled = $element.enabled;
					password = $element.password; rect = $element.rect; patterns = @($element.patterns) }
				if (-not $element.password) {
					foreach ($field in @('value', 'text', 'isReadOnly', 'truncated')) {
						if ($null -ne $element.$field) { $row[$field] = $element.$field }
					}
				}
				$public.elements += $row
			}
		} else { $diagnostics.Add('uia_unavailable: ' + $uia.code) }
	} catch { $diagnostics.Add('uia_unavailable: ' + $_.Exception.Message) }
	$shot = $null
	if ($request.includeImage -ne $false) {
		if (-not [OwlComputerUse.DesktopGuard]::Visible($hwnd)) { $diagnostics.Add('window_capture_unavailable: target is hidden or minimized; observe does not restore it') }
		else {
			$maxWidth = 1568; $quality = 80
			if ($request.maxWidth) { $maxWidth = [Math]::Max(256, [Math]::Min(4096, [int]$request.maxWidth)) }
			if ($request.quality) { $quality = [Math]::Max(30, [Math]::Min(95, [int]$request.quality)) }
			$session = $null
			try {
				Import-CaptureKernel ([string]$request.captureKernelPath)
				$geometry = [OwlComputerUse.DesktopGuard]::Geometry($hwnd, $true)
				$session = [OwlMirror.CaptureSession]::Start([IntPtr]$hwnd)
				$w = 0; $h = 0
				$jpeg = $session.GrabFrameJpeg(1500, $quality, $maxWidth, [ref]$w, [ref]$h)
				if (-not $jpeg -or $w -le 0 -or $h -le 0) { throw 'WGC produced no frame' }
				$scaled = [OwlComputerUse.Kernel]::ResizeJpeg($jpeg, $maxWidth, $quality)
				$shot = @{ jpeg = [Convert]::ToBase64String($scaled.Jpeg); imageWidth = $scaled.ImageWidth; imageHeight = $scaled.ImageHeight; screenWidth = $geometry[2]; screenHeight = $geometry[3]; originX = $geometry[0]; originY = $geometry[1] }
				$diagnostics.Add('capture_backend: wgc')
			} catch {
				$diagnostics.Add('wgc_unavailable: ' + $_.Exception.Message)
				if ([OwlComputerUse.DesktopGuard]::Unobscured($hwnd)) {
					$r = [OwlComputerUse.Kernel]::CaptureRect($identity.rect[0], $identity.rect[1], $identity.rect[2], $identity.rect[3], $maxWidth, $quality)
					$shot = @{ jpeg = [Convert]::ToBase64String($r.Jpeg); imageWidth = $r.ImageWidth; imageHeight = $r.ImageHeight; screenWidth = $r.ScreenWidth; screenHeight = $r.ScreenHeight; originX = $r.OriginX; originY = $r.OriginY }
					if (-not [OwlComputerUse.DesktopGuard]::Unobscured($hwnd)) { $shot = $null; $diagnostics.Add('gdi_capture_blocked: occlusion changed during capture') }
					else { $diagnostics.Add('capture_backend: unobscured_gdi_crop') }
				} else { $diagnostics.Add('gdi_capture_blocked: window is obscured or outside the visible desktop; no substitute screenshot') }
			} finally { if ($session) { $session.Dispose() } }
		}
	}
	try { $latest = Get-WindowIdentity $hwnd }
	catch {
		$script:Observation = @{ id = $observationId; identity = $null; created = [DateTime]::UtcNow; elements = @{}; screenshot = $null }
		$public.target = $null; $public.elements = @(); $public.capabilities.uia = $false; $public.capabilities.backgroundUia = $false
		$public.diagnostics = @('target_unavailable: the window closed during observation; refresh windows or explicitly open the app'); return $public
	}
	if ($latest.pid -ne $identity.pid -or $latest.started -ne $identity.started -or ($latest.rect -join ',') -ne ($identity.rect -join ',') -or [OwlComputerUse.DesktopGuard]::WindowRevision($hwnd) -ne $revision) {
		if ([OwlComputerUse.DesktopGuard]::WindowRevision($hwnd) -ne $revision) { $diagnostics.Add('target_intervened: target input changed during observe; reobserve') }
		$diagnostics.Add('observation_changed: target geometry/identity or target input changed during observe; reobserve')
		$public.diagnostics = @($diagnostics.ToArray()); return $public
	}
	if ($shot) { $public.screenshot = $shot; $public.capabilities.windowCapture = $true }
	$public.target = Convert-FullWindow $latest.row
	$script:Observation = @{ id = $observationId; identity = $identity; targetRevision = $revision; revision = [OwlComputerUse.DesktopGuard]::UserRevision;
		created = [DateTime]::UtcNow; elements = $internalElements; screenshot = $shot }
	$public.diagnostics = @($diagnostics.ToArray())
	return $public
}

function New-ActBlock([string]$code, [string]$message, [string]$next = 'computer_observe', [int]$retryAfter = 0) {
	$result = @{ status = 'blocked'; code = $code; message = $message; retryable = $true; nextAction = $next }
	if ($retryAfter -gt 0) { $result.retryAfterMs = $retryAfter }
	return $result
}

function Get-ControlHold($request) {
	$hold = 0
	if ($env:OWL_COMPUTER_USE_NATIVE_TEST -eq '1') {
		[void][int]::TryParse([string]$request._testControlHoldMs, [ref]$hold)
	}
	return [Math]::Max(0, [Math]::Min(2000, $hold))
}

function Start-Control($request, [string]$mode, [long]$hwnd) {
	$began = [OwlComputerUse.ControlOverlay]::Begin($mode, $hwnd, [long]$request.id)
	if ($began) { [OwlComputerUse.DesktopGuard]::HoldForControlTest((Get-ControlHold $request)) }
	return -not [OwlComputerUse.DesktopGuard]::StopRequested
}

function Wait-ForegroundIdle($observation, [string]$mode, [bool]$bindTarget = $true) {
	$clock = [Diagnostics.Stopwatch]::StartNew()
	# The default native request budget is 20 seconds. Planning and this wait
	# share eight seconds, leaving time for focus, the HUD and the UIA child.
	$waitBudget = 8000
	if ($script:ActionClock) { $waitBudget = [Math]::Max(0, 8000 - [long]$script:ActionClock.ElapsedMilliseconds) }
	while ($true) {
		$script:Execution.idleWaitMs = [long]$clock.ElapsedMilliseconds
		if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'blocked'; code = 'physical_escape'; retryable = $false; message = 'Desktop control was explicitly stopped while waiting for idle.' } }
		if (-not [OwlComputerUse.DesktopGuard]::Monitoring) { return New-ActBlock 'input_monitor_unavailable' 'Desktop input monitoring is unavailable; no foreground control was acquired.' 'restart the driver and reobserve' }
		if (([DateTime]::UtcNow - $observation.created).TotalSeconds -gt 120) { return New-ActBlock 'observation_expired' 'The observation expired while waiting for idle; reobserve.' }
		if ($mode -eq 'foreground' -and [OwlComputerUse.DesktopGuard]::UserRevision -ne $observation.revision) {
			$result = New-ActBlock 'user_intervened' 'The desktop received input after this foreground observation; refresh it before acting.'
			$result.requiresExclusive = $true; return $result
		}
		if ($bindTarget) {
			$hwnd = $observation.identity.hwnd
			if ([OwlComputerUse.DesktopGuard]::WindowRevision($hwnd) -ne $observation.targetRevision) { return New-ActBlock 'target_intervened' 'The target received input while waiting for idle; reobserve.' }
			try { $current = Get-WindowIdentity $hwnd }
			catch { return New-ActBlock 'target_gone' 'The target closed while waiting for idle; reobserve.' }
			if ($current.pid -ne $observation.identity.pid -or $current.started -ne $observation.identity.started) { return New-ActBlock 'target_replaced' 'The target process identity changed while waiting for idle; reobserve.' }
			if (($current.rect -join ',') -ne ($observation.identity.rect -join ',')) { return New-ActBlock 'geometry_changed' 'The target moved or resized while waiting for idle; reobserve.' }
		}
		$revision = [OwlComputerUse.DesktopGuard]::UserRevision
		$quiet = [OwlComputerUse.DesktopGuard]::QuietForMs
		$script:Execution.idleQuietForMs = $quiet
		if ($quiet -ge 750) {
			if ([OwlComputerUse.DesktopGuard]::UserRevision -ne $revision -or ($mode -eq 'foreground' -and $revision -ne $observation.revision)) { return New-ActBlock 'input_conflict' 'Input changed while desktop idle was checked; no foreground control was acquired.' 'wait, then reobserve' 750 }
			if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'blocked'; code = 'physical_escape'; retryable = $false } }
			if ($bindTarget -and [OwlComputerUse.DesktopGuard]::WindowRevision($hwnd) -ne $observation.targetRevision) { return New-ActBlock 'target_intervened' 'The target received input while idle was checked; reobserve.' }
			$script:Execution.idleWaitMs = [long]$clock.ElapsedMilliseconds
			$script:Execution.idleGrantedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
			return @{ status = 'confirmed'; code = 'foreground_idle'; revision = $revision }
		}
		$remaining = $waitBudget - [long]$clock.ElapsedMilliseconds
		if ($mode -ne 'auto' -or $remaining -le 0) {
			return New-ActBlock 'user_busy' 'No desktop idle interval was available within the bounded wait; no foreground action was sent.' 'wait, then reobserve' ([Math]::Max(1, 750 - $quiet))
		}
		Start-Sleep -Milliseconds ([int][Math]::Min(50, $remaining))
	}
}

function Invoke-AppOpen($request, [string]$mode, $observation) {
	if ($mode -eq 'background') { return New-ActBlock 'exclusive_required' 'Opening an app may change the desktop foreground; use auto or foreground.' 'computer_act with inputMode auto' }
	$app = [string]$request.app
	if (-not $app -or $app -match '[\r\n;&|<>"\u0060]' -or $app -ne $app.Trim()) {
		return New-ActBlock 'invalid_app' 'app must be one executable name, existing absolute .exe path, or AUMID; command arguments and shell chains are not accepted.' 'provide a single app identity'
	}
	$executable = $null; $arguments = ''; $expectedProcess = $null
	if ($app -match '^[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$') {
		$executable = Join-Path $env:windir 'explorer.exe'
		$arguments = 'shell:AppsFolder\' + $app
	} else {
		if ($app -in @('notepad', '记事本')) { $app = 'notepad.exe' }
		if ($app -in @('calculator', '计算器')) { $app = 'calc.exe' }
		if ([IO.Path]::IsPathRooted($app)) {
			if ([IO.Path]::GetExtension($app) -ne '.exe' -or -not (Test-Path -LiteralPath $app -PathType Leaf)) {
				return New-ActBlock 'app_not_found' 'The requested executable path does not exist.' 'correct app or inspect installed applications'
			}
			$executable = (Get-Item -LiteralPath $app).FullName
		} else {
			if ($app -match '[\\/]' -or $app -notmatch '^[^\s]+(?:\.exe)?$') {
				return New-ActBlock 'invalid_app' 'Use a bare executable name or an existing absolute executable path; do not combine app and arguments.' 'provide a single app identity'
			}
			if ([IO.Path]::GetExtension($app) -eq '') { $app += '.exe' }
			if ([IO.Path]::GetExtension($app) -ne '.exe') { return New-ActBlock 'invalid_app' 'Only executable names, absolute .exe paths and AUMIDs are supported.' 'provide a single app identity' }
			$command = Get-Command -Name $app -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $app } | Select-Object -First 1
			if (-not $command) { return New-ActBlock 'app_not_found' 'The requested executable is not on PATH.' 'correct app or provide its absolute executable path' }
			$executable = $command.Source
		}
		$expectedProcess = [IO.Path]::GetFileNameWithoutExtension($executable)
	}
	# Launch has no target window yet; discovery may refer to the user's app.
	$idle = Wait-ForegroundIdle $observation $mode $false
	if ($idle.status -ne 'confirmed') { return $idle }
	$inputRevision = $idle.revision
	if (-not [OwlComputerUse.DesktopGuard]::Acquire()) { return New-ActBlock 'desktop_busy' 'Another Owl worker is performing a foreground action.' 'wait, then reobserve' 750 }
	if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'blocked'; code = 'physical_escape'; retryable = $false; message = 'Desktop input was explicitly stopped with Escape.' } }
	if ([OwlComputerUse.DesktopGuard]::UserRevision -ne $inputRevision) { return New-ActBlock 'input_conflict' 'The user resumed input before app launch; the app was not opened.' 'wait, then reobserve' 750 }
	$script:Execution.executedMode = 'foreground'; $script:Execution.executedAction = 'open_app'
	$script:Execution.fallbackReason = 'application_launch'
	$before = @([OwlComputerUse.Win32.WindowTools]::ListWindows() | ForEach-Object { $_.Hwnd })
	$launched = $null
	try {
		$start = New-Object Diagnostics.ProcessStartInfo
		$start.FileName = $executable; $start.Arguments = $arguments; $start.UseShellExecute = $true
		if (-not (Start-Control $request 'foreground' 0)) { return @{ status = 'blocked'; code = 'user_stopped'; retryable = $false } }
		if ([OwlComputerUse.DesktopGuard]::UserRevision -ne $inputRevision) { return New-ActBlock 'input_conflict' 'The user resumed input while launch status was shown; the app was not opened.' 'wait, then reobserve' 750 }
		$launched = [Diagnostics.Process]::Start($start)
		$pidValue = 0
		if ($launched) { $pidValue = $launched.Id }
		$deadline = [DateTime]::UtcNow.AddSeconds(4)
		do {
			$windows = @([OwlComputerUse.Win32.WindowTools]::ListWindows())
			$target = $windows | Where-Object { $pidValue -gt 0 -and $_.Pid -eq $pidValue } | Select-Object -First 1
			if (-not $target -and $expectedProcess) {
				$target = $windows | Where-Object { $_.Process -eq $expectedProcess -and ($before -notcontains $_.Hwnd) } | Select-Object -First 1
			}
			if (-not $target -and $expectedProcess) {
				$target = $windows | Where-Object { $_.Process -eq $expectedProcess -and $_.Foreground } | Select-Object -First 1
			}
			if ($target) { return @{ status = 'confirmed'; code = 'app_window_ready'; target = Convert-FullWindow $target; retryable = $false; message = 'The launch was accepted and an application window is available.' } }
			Start-Sleep -Milliseconds 100
		} while ([DateTime]::UtcNow -lt $deadline -and -not [OwlComputerUse.DesktopGuard]::StopRequested)
		return @{ status = 'issued'; code = 'app_launch_issued'; retryable = $false; nextAction = 'computer_observe to enumerate windows; do not launch again automatically'; message = 'The launch was accepted; a matching window has not yet been identified.' }
	} catch {
		return @{ status = 'unknown'; code = 'app_launch_unknown'; retryable = $false; nextAction = 'computer_observe before deciding any next action'; message = $_.Exception.Message }
	} finally { if ($launched) { $launched.Dispose() } }
}

function Invoke-ActCore($request, [string]$mode) {
	$observation = $script:Observation
	$script:Observation = $null
	$action = [string]$request.action
	if (-not $observation -or $request.observationId -ne $observation.id) { return New-ActBlock 'stale_observation' 'Reobserve the target before acting.' }
	if (([DateTime]::UtcNow - $observation.created).TotalSeconds -gt 120) { return New-ActBlock 'observation_expired' 'The observation expired; obtain current window evidence.' }
	if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'blocked'; code = 'physical_escape'; retryable = $false; message = 'Desktop input was explicitly stopped with Escape.' } }
	if ($action -eq 'open_app') { return Invoke-AppOpen $request $mode $observation }
	if (-not $observation.identity) { return New-ActBlock 'target_unavailable' 'No target window is bound. Select a current window or explicitly open the requested app.' 'computer_observe or authorized open_app' }
	if (-not [OwlComputerUse.DesktopGuard]::Monitoring) { return New-ActBlock 'input_monitor_unavailable' 'Desktop input monitoring could not start.' 'restart the driver and reobserve' }
	$hwnd = $observation.identity.hwnd
	if ([OwlComputerUse.DesktopGuard]::WindowRevision($hwnd) -ne $observation.targetRevision) {
		[OwlComputerUse.DesktopGuard]::Release()
		return New-ActBlock 'target_intervened' 'The target received user input; reobserve it before deciding the next action.'
	}
	try { $identity = Get-WindowIdentity $hwnd }
	catch { return New-ActBlock 'target_gone' 'The target window closed; refresh the window list or explicitly open the app.' 'computer_observe or authorized open_app' }
	if ($identity.pid -ne $observation.identity.pid -or $identity.started -ne $observation.identity.started) { return New-ActBlock 'target_replaced' 'The target process identity changed; reobserve.' }
	if (($identity.rect -join ',') -ne ($observation.identity.rect -join ',')) { return New-ActBlock 'geometry_changed' 'The target moved or resized; obtain fresh coordinates.' }
	$element = $null
	if ($request.elementId) {
		$element = $observation.elements[[string]$request.elementId]
		if (-not $element) { return New-ActBlock 'stale_element' 'The referenced control is not in this observation.' }
		if ($element.password -or -not $element.enabled) { return New-ActBlock 'element_unavailable' 'The control is unavailable for this operation.' }
	}
	$backgroundAction = $null
	if ($action -in @('invoke', 'set_value', 'select', 'toggle')) { $backgroundAction = $action }
	elseif ($element -and $action -eq 'click' -and ($null -eq $request.button -or $request.button -eq '' -or $request.button -eq 'left') -and -not $request.double) {
		if ($element.patterns -contains 'Invoke') { $backgroundAction = 'invoke' }
		elseif ($element.patterns -contains 'SelectionItem') { $backgroundAction = 'select' }
		elseif ($element.patterns -contains 'Toggle') { $backgroundAction = 'toggle' }
	}
	elseif ($element -and $action -eq 'type' -and $request.replace -eq $true -and $element.patterns -contains 'Value') { $backgroundAction = 'set_value' }
	elseif ($element -and $action -eq 'scroll' -and $element.patterns -contains 'Scroll') { $backgroundAction = 'scroll' }
	if ($mode -eq 'background' -and -not $backgroundAction) {
		$result = New-ActBlock 'exclusive_required' 'No equivalent background UIA pattern is exposed for this action.' 'use inputMode auto or foreground with fresh observation'
		$result.requiresExclusive = $true; return $result
	}
	if (-not [OwlComputerUse.DesktopGuard]::AcquireWindow($hwnd)) { return New-ActBlock 'target_busy' 'Another Owl worker owns this application window or its dialogs.' 'wait, then reobserve' 750 }
	$inputRevision = [OwlComputerUse.DesktopGuard]::UserRevision
	$useUia = $backgroundAction -and ($mode -ne 'foreground' -or $action -in @('invoke', 'set_value', 'select', 'toggle'))
	$uiaRequest = @{ hwnd = $hwnd; pid = $identity.pid; started = $identity.started; element = $element;
		windowRevision = $observation.targetRevision; globalRevision = $inputRevision; exclusive = $false;
		showControl = $false; controlRequestId = [long]$request.id; controlMode = ''; testHoldMs = (Get-ControlHold $request);
		windowRect = @{ x = $identity.rect[0]; y = $identity.rect[1]; width = $identity.rect[2]; height = $identity.rect[3] };
		text = [string]$request.text; delta = [int]$request.delta; horizontal = [bool]$request.horizontal }
	$backgroundSafe = $false
	if ($useUia) {
		if (-not $element) { return New-ActBlock 'element_required' 'This UIA action requires an observed elementId.' }
		$uiaRequest.action = 'plan'; $uiaRequest.requestedAction = $backgroundAction
		try { $plan = Invoke-Uia $uiaRequest }
		catch { return New-ActBlock 'uia_plan_unavailable' 'The action backend could not be inspected; no action was sent.' }
		if ($plan.status -ne 'confirmed') { return $plan }
		if ($plan.code -ne 'action_plan' -or $plan.requestedAction -ne $backgroundAction -or $plan.backgroundSafe -isnot [bool] -or $plan.backend -isnot [string] -or [string]::IsNullOrWhiteSpace($plan.backend)) {
			return New-ActBlock 'uia_plan_unavailable' 'The helper returned no valid action backend; no action was sent.'
		}
		$backgroundSafe = $plan.backgroundSafe
		$uiaRequest.expectedBackend = $plan.backend
		if ($mode -eq 'background' -and -not $backgroundSafe) {
			$result = New-ActBlock 'background_backend_unavailable' 'This control has no verified nonactivating backend for the requested action.' 'use inputMode auto or foreground with fresh observation'
			$result.requiresExclusive = $true; return $result
		}
	}
	# Pattern availability alone does not establish that a provider stays in the
	# background. Choose one executor before any semantic operation is invoked.
	$exclusive = $mode -eq 'foreground' -or -not $useUia -or -not $backgroundSafe
	$executedAction = $(if ($useUia) { $backgroundAction } else { $action })
	$script:Execution.executedMode = $(if ($exclusive) { 'foreground' } else { 'background' })
	$script:Execution.executedAction = $executedAction
	if ($exclusive -and $mode -eq 'auto') {
		$script:Execution.fallbackReason = $(if ($useUia) { 'background_backend_requires_foreground' } else { 'no_equivalent_background_pattern' })
	}
	if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'blocked'; code = 'physical_escape'; retryable = $false } }
	if ([OwlComputerUse.DesktopGuard]::WindowRevision($hwnd) -ne $observation.targetRevision) { return New-ActBlock 'target_intervened' 'The target received input while its backend was inspected; reobserve before acting.' }
	try { $plannedIdentity = Get-WindowIdentity $hwnd }
	catch { return New-ActBlock 'target_gone' 'The target closed while its backend was inspected; reobserve.' }
	if ($plannedIdentity.pid -ne $identity.pid -or $plannedIdentity.started -ne $identity.started -or ($plannedIdentity.rect -join ',') -ne ($identity.rect -join ',')) {
		return New-ActBlock 'geometry_changed' 'Target identity or geometry changed while its backend was inspected; reobserve.'
	}
	if ($exclusive) {
		$idle = Wait-ForegroundIdle $observation $mode
		if ($idle.status -ne 'confirmed') { return $idle }
		$inputRevision = $idle.revision
		$uiaRequest.globalRevision = $inputRevision
		if (-not [OwlComputerUse.DesktopGuard]::Acquire()) { return New-ActBlock 'desktop_busy' 'Another Owl worker is performing a foreground action.' 'wait, then reobserve' 750 }
		if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'blocked'; code = 'physical_escape'; retryable = $false } }
		if ([OwlComputerUse.DesktopGuard]::UserRevision -ne $inputRevision) { return New-ActBlock 'input_conflict' 'The user resumed input before foreground focus; no action was sent.' 'wait, then reobserve' 750 }
		if ($action -notin @('focus', 'restore') -and [OwlComputerUse.DesktopGuard]::ForegroundHwnd() -ne $hwnd) {
			if (-not (Start-Control $request 'foreground' $hwnd)) { return @{ status = 'blocked'; code = 'user_stopped'; retryable = $false } }
			if ([OwlComputerUse.DesktopGuard]::UserRevision -ne $inputRevision) { return New-ActBlock 'input_conflict' 'The user resumed input while control status was shown; no focus change was requested.' 'wait, then reobserve' 750 }
			if (-not [OwlComputerUse.Win32.WindowTools]::Focus($hwnd)) { return New-ActBlock 'foreground_unavailable' ('The target could not be brought to the foreground; no input was sent. ' + [OwlComputerUse.Win32.WindowTools]::LastFocusDiagnostics) }
		}
		if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'blocked'; code = 'physical_escape'; retryable = $false } }
		if ([OwlComputerUse.DesktopGuard]::UserRevision -ne $inputRevision) { return New-ActBlock 'input_conflict' 'The user resumed input while foreground focus was being acquired; no action was sent.' 'wait, then reobserve' 750 }
		$latest = Get-WindowIdentity $hwnd
		if ($latest.pid -ne $identity.pid -or $latest.started -ne $identity.started -or ($latest.rect -join ',') -ne ($identity.rect -join ',')) {
			return New-ActBlock 'geometry_changed' 'Restoring/focusing changed target geometry; reobserve before using its controls or coordinates.'
		}
	} else { [OwlComputerUse.DesktopGuard]::ReleaseDesktop() }
	$uiaRequest.exclusive = $exclusive; $uiaRequest.showControl = $true; $uiaRequest.controlMode = $script:Execution.executedMode
	if ($useUia) {
		if (-not $element) { return New-ActBlock 'element_required' 'This UIA action requires an observed elementId.' }
		$uiaRequest.action = $executedAction
		$foreground = [OwlComputerUse.DesktopGuard]::ForegroundHwnd()
		$result = Invoke-Uia $uiaRequest
		if ([OwlComputerUse.DesktopGuard]::StopRequested) { return @{ status = 'unknown'; code = 'physical_escape'; retryable = $false; message = 'Escape stopped desktop control; do not replay an action whose outcome is unknown.' } }
		if ([OwlComputerUse.DesktopGuard]::WindowRevision($hwnd) -ne $observation.targetRevision) {
			return @{ status = 'unknown'; code = 'target_intervened'; retryable = $false; nextAction = 'computer_observe; do not replay automatically'; message = 'The target received user input during the UIA operation.' }
		}
		$after = [OwlComputerUse.DesktopGuard]::ForegroundHwnd()
		if (-not $exclusive -and [OwlComputerUse.DesktopGuard]::RootOwner($foreground) -ne [OwlComputerUse.DesktopGuard]::RootOwner($hwnd) -and [OwlComputerUse.DesktopGuard]::RootOwner($after) -eq [OwlComputerUse.DesktopGuard]::RootOwner($hwnd)) {
			$afterRow = [OwlComputerUse.Win32.WindowTools]::Describe([IntPtr]$after)
			$script:Execution.executedMode = 'foreground'; $script:Execution.fallbackReason = 'uia_provider_activated_target'
			return @{ status = 'unknown'; code = 'background_focus_changed'; requiresExclusive = $true; retryable = $false;
				message = ('The application brought itself forward; no input fallback or replay was executed. before=' + $foreground + ' after=' + $after + ' target=' + $hwnd + ' beforeOwner=' + [OwlComputerUse.DesktopGuard]::RootOwner($foreground) + ' afterOwner=' + [OwlComputerUse.DesktopGuard]::RootOwner($after) + ' targetOwner=' + [OwlComputerUse.DesktopGuard]::RootOwner($hwnd) + ' afterClass=' + $afterRow.Class + ' afterTitle=' + $afterRow.Title + ' afterPid=' + $afterRow.Pid + ' uiaStatus=' + $result.status + ' uiaCode=' + $result.code) }
		}
		if ($result.status -eq 'blocked' -and $result.code -in @('unsupported_pattern', 'uia_unavailable', 'scroll_unavailable') -and $action -in @('click', 'type', 'scroll')) {
			# These helper codes precede invocation. Unknown/partial results never take
			# another executor; a fresh observation is required even for this safe retry.
			if ($result -is [Collections.IDictionary]) {
				$result.retryable = $true; $result.requiresExclusive = $true
				$result.nextAction = 'computer_observe, then repeat the requested click/type/scroll with inputMode foreground if the user is idle'
			} else {
				$result | Add-Member -NotePropertyName retryable -NotePropertyValue $true -Force
				$result | Add-Member -NotePropertyName requiresExclusive -NotePropertyValue $true -Force
				$result | Add-Member -NotePropertyName nextAction -NotePropertyValue 'computer_observe, then repeat the requested click/type/scroll with inputMode foreground if the user is idle' -Force
			}
		}
		return $result
	}
	if ($element) {
		$uiaRequest.showControl = $false
		$uiaRequest.action = 'validate'; $valid = Invoke-Uia $uiaRequest
		if ($valid.status -ne 'confirmed') { return $valid }
		$uiaRequest.showControl = $true
	}
	$issued = $false
	try {
		switch ($action) {
			'focus' {
				if (-not (Start-Control $request 'foreground' $hwnd)) { return @{ status = 'blocked'; code = 'user_stopped'; retryable = $false } }
				$issued = $true; $ok = [OwlComputerUse.Win32.WindowTools]::Focus($hwnd)
				if ($ok) { return @{ status = 'confirmed'; code = 'foreground_verified' } }
				return @{ status = 'unknown'; code = 'foreground_not_verified'; retryable = $false; message = [OwlComputerUse.Win32.WindowTools]::LastFocusDiagnostics }
			}
			'restore' {
				if (-not (Start-Control $request 'foreground' $hwnd)) { return @{ status = 'blocked'; code = 'user_stopped'; retryable = $false } }
				$issued = $true; [OwlComputerUse.Win32.WindowTools]::Restore($hwnd) | Out-Null
				Start-Sleep -Milliseconds 80
				if ([OwlComputerUse.DesktopGuard]::Visible($hwnd)) { return @{ status = 'confirmed'; code = 'restored_verified' } }
				return @{ status = 'unknown'; code = 'restore_not_verified'; retryable = $false }
			}
			{ $_ -in @('click', 'scroll') } {
				if ($element) { $x = [int][Math]::Round($element.rect.x + $element.rect.width / 2); $y = [int][Math]::Round($element.rect.y + $element.rect.height / 2) }
				else {
					$shot = $observation.screenshot
					if (-not $shot) { return New-ActBlock 'image_required' 'Coordinate actions require this observation screenshot.' }
					if ($null -eq $request.x -or $null -eq $request.y -or [double]::IsNaN([double]$request.x) -or [double]::IsNaN([double]$request.y) -or [double]::IsInfinity([double]$request.x) -or [double]::IsInfinity([double]$request.y) -or [double]$request.x -lt 0 -or [double]$request.y -lt 0 -or [double]$request.x -ge $shot.imageWidth -or [double]$request.y -ge $shot.imageHeight) { return New-ActBlock 'point_out_of_bounds' 'Use finite coordinates within the current screenshot.' }
					$x = $shot.originX + [int][Math]::Floor([double]$request.x * $shot.screenWidth / $shot.imageWidth)
					$y = $shot.originY + [int][Math]::Floor([double]$request.y * $shot.screenHeight / $shot.imageHeight)
				}
				if (-not [OwlComputerUse.Kernel]::InputStillSafe($hwnd, $inputRevision)) { return New-ActBlock 'input_conflict' 'Foreground or user input changed before mouse injection; no click/scroll was sent.' }
				[OwlComputerUse.ControlOverlay]::AvoidPoint($x, $y)
				$hit = [OwlComputerUse.Win32.WindowTools]::InfoAt($x, $y)
				if ($hit.Hwnd -ne $hwnd) { return New-ActBlock 'target_obscured' 'The intended point is obscured by another window.' }
				if (-not (Start-Control $request 'foreground' $hwnd)) { return @{ status = 'blocked'; code = 'user_stopped'; retryable = $false } }
				[OwlComputerUse.ControlOverlay]::AvoidPoint($x, $y)
				$hit = [OwlComputerUse.Win32.WindowTools]::InfoAt($x, $y)
				if ($hit.Hwnd -ne $hwnd -or -not [OwlComputerUse.Kernel]::InputStillSafe($hwnd, $inputRevision)) { return New-ActBlock 'input_conflict' 'The target changed while showing control status; no mouse input was sent.' }
				[OwlComputerUse.Kernel]::MoveMouse($x, $y)
				if (-not [OwlComputerUse.Kernel]::InputStillSafe($hwnd, $inputRevision)) { return New-ActBlock 'input_conflict' 'User input changed during pointer positioning; no click/scroll was sent.' }
				$issued = $true
				if ($action -eq 'click') {
					$complete = [OwlComputerUse.Kernel]::ClickMouseGuarded([string]$request.button, [bool]$request.double, $hwnd, $inputRevision)
					if (-not $complete) { return @{ status = 'partial'; code = 'input_interrupted'; retryable = $false; nextAction = 'computer_observe; do not replay automatically' } }
				} else { [OwlComputerUse.Kernel]::ScrollWheel([int]$request.delta, [bool]$request.horizontal) }
				return @{ status = 'issued'; code = 'input_issued' }
			}
			'type' {
				if (-not [OwlComputerUse.Kernel]::InputStillSafe($hwnd, $inputRevision)) { return New-ActBlock 'input_conflict' 'The target lost foreground before typing; no text was sent.' }
				if ($element) {
					$uiaRequest.action = 'focus_element'; $focused = Invoke-Uia $uiaRequest
					if ($focused.status -ne 'confirmed') { return $focused }
				}
				if (-not (Start-Control $request 'foreground' $hwnd)) { return @{ status = 'blocked'; code = 'user_stopped'; retryable = $false } }
				if ($request.replace -eq $true) {
					$issued = $true
					if (-not [OwlComputerUse.Kernel]::KeyComboGuarded([int[]]@(0x11), [int[]]@(0x41), $hwnd, $inputRevision)) {
						return @{ status = 'partial'; code = 'input_interrupted'; typedCharacters = 0; retryable = $false }
					}
				}
				$issued = $true
				$typing = [OwlComputerUse.Kernel]::TypeTextGuarded([string]$request.text, $hwnd, $inputRevision)
				if (-not $typing.Complete) {
					$code = 'input_interrupted'
					if ($typing.Failure) { $code = 'native_input_failed' }
					if ([OwlComputerUse.DesktopGuard]::StopRequested) { $code = 'physical_escape' }
					return @{ status = 'partial'; code = $code; typedCharacters = $typing.TypedCharacters; retryable = $false; nextAction = 'computer_observe; do not replay automatically' }
				}
				return @{ status = 'issued'; code = 'text_input_issued'; typedCharacters = $typing.TypedCharacters }
			}
			'key' {
				if (-not [OwlComputerUse.Kernel]::InputStillSafe($hwnd, $inputRevision)) { return New-ActBlock 'input_conflict' 'Foreground or user input changed before the shortcut; no key was sent.' }
				$down = @(); $tap = @()
				foreach ($key in $request.down) { $down += [int]$key }
				foreach ($key in $request.tap) { $tap += [int]$key }
				if (($down -contains 0x5b -or $down -contains 0x5c) -and $tap -contains 0x4c) { return @{ status = 'blocked'; code = 'blocked_key_combo' } }
				if ($down -contains 0x11 -and $down -contains 0x12 -and $tap -contains 0x2e) { return @{ status = 'blocked'; code = 'blocked_key_combo' } }
				if (-not (Start-Control $request 'foreground' $hwnd)) { return @{ status = 'blocked'; code = 'user_stopped'; retryable = $false } }
				$issued = $true
				$complete = [OwlComputerUse.Kernel]::KeyComboGuarded([int[]]$down, [int[]]$tap, $hwnd, $inputRevision)
				if ($complete) { return @{ status = 'issued'; code = 'key_input_issued' } }
				return @{ status = 'partial'; code = 'input_interrupted'; retryable = $false }
			}
			default { return New-ActBlock 'unsupported_action' 'This action is not supported by the driver.' }
		}
	} catch {
		return @{ status = $(if ($issued) { 'unknown' } else { 'blocked' }); code = 'native_input_failed'; retryable = -not $issued; message = $_.Exception.Message }
	}
}

function Invoke-Act($request) {
	$mode = 'auto'
	if ($request.inputMode) { $mode = [string]$request.inputMode }
	$script:Execution = @{ requestedMode = $mode }
	$script:ActionClock = [Diagnostics.Stopwatch]::StartNew()
	try {
		if ($mode -notin @('auto', 'background', 'foreground')) { return New-ActBlock 'invalid_input_mode' 'inputMode must be auto, background, or foreground.' }
		$result = Invoke-ActCore $request $mode
		$public = @{}
		if ($result -is [Collections.IDictionary]) { foreach ($key in $result.Keys) { $public[$key] = $result[$key] } }
		else { foreach ($property in $result.PSObject.Properties) { $public[$property.Name] = $property.Value } }
		foreach ($key in $script:Execution.Keys) { $public[$key] = $script:Execution[$key] }
		if ([OwlComputerUse.DesktopGuard]::StopRequested) {
			$public.code = 'physical_escape'; $public.retryable = $false
		}
		return $public
	} finally {
		[OwlComputerUse.Kernel]::ReleaseHeldKeys()
		[OwlComputerUse.DesktopGuard]::ReleaseDesktop()
		[OwlComputerUse.ControlOverlay]::End()
		$script:ActionClock = $null
	}
}

# ---------------------------------------------------------------------------
# 主循环：一行请求 → 一行响应
# ---------------------------------------------------------------------------
try { while ($true) {
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
		if ($req.cmd -in @('click', 'type', 'key', 'scroll', 'focus', 'restore')) {
			throw 'legacy_action_requires_observation: use observe, then act with its observationId'
		}
		switch ($req.cmd) {
			'_test_input' {
				if ($env:OWL_COMPUTER_USE_NATIVE_TEST -ne '1') { throw 'native test recorder is disabled' }
				[OwlComputerUse.DesktopGuard]::ReportExternalInput([long]$req.hwnd, [bool]$req.interaction)
				$data = @{ recorded = $true }
			}
			'observe' { $data = Invoke-Observe $req }
			'act' { $data = Invoke-Act $req }
			'release' {
				$script:Observation = $null
				[OwlComputerUse.DesktopGuard]::Release()
				[OwlComputerUse.ControlOverlay]::Shutdown()
				$data = @{ released = $true; status = 'confirmed' }
			}
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
			'windows' {
				$data = Get-WindowRowsPayload
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
} } finally {
	$script:Observation = $null
	[OwlComputerUse.DesktopGuard]::Release()
	[OwlComputerUse.DesktopGuard]::Stop()
}
