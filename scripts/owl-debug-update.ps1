[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateRange(1, [int]::MaxValue)]
	[int]$ParentProcessId,
	# 默认走 owl-start.ps1：分层按需重建 + 启动 + 验证 bridge HTTP 200，每步日志落
	# %TEMP%\owl-start-logs\。曾用 owl-native-dev.ps1（全量构建、无日志、exe 被残留
	# 实例锁住时直接失败且窗口一闪而过无据可查）。
	# 注意 $PSScriptRoot 在 param 默认值表达式里是空串，默认值只能在正文里算。
	[string]$BuildScript = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }

# 全程留痕：控制台窗口关掉之后依然能查现场。
$logPath = Join-Path $env:TEMP 'owl-debug-update.log'
try { Start-Transcript -Path $logPath -Append | Out-Null } catch { }

$script:UpdateMutex = $null

function Release-UpdateMutex {
	if ($null -eq $script:UpdateMutex) { return }
	try { [void]$script:UpdateMutex.ReleaseMutex() } catch { }
	try { $script:UpdateMutex.Dispose() } catch { }
	$script:UpdateMutex = $null
}

function Stop-Note([string]$Message, [int]$ExitCode, [switch]$KeepOpen) {
	Write-Host $Message -ForegroundColor Red
	# 先放锁再停下来给人看报错。锁占到按 Enter 为止时，下一次点击会被当成「已在更新」拒绝。
	Release-UpdateMutex
	try { Stop-Transcript | Out-Null } catch { }
	# 退出码 2 是锁冲突。桌面壳会观察启动后约 4 秒：这里若等 Enter，壳会以为更新已经启动并把 Owl 关掉。
	if ($KeepOpen -and $ExitCode -ne 2 -and $Host.Name -eq 'ConsoleHost') {
		[void](Read-Host 'Press Enter to close this window')
	}
	exit $ExitCode
}

$createdNew = $false
try {
	$script:UpdateMutex = New-Object Threading.Mutex($false, 'Local\OwlDebugUpdate', [ref]$createdNew)
	$owned = $false
	try {
		$owned = $script:UpdateMutex.WaitOne(0)
	} catch [System.Threading.AbandonedMutexException] {
		# 上次更新进程被强杀后锁被标成遗弃；WaitOne 已经把所有权交给当前线程。
		$owned = $true
	}
	if (-not $owned) {
		try { $script:UpdateMutex.Dispose() } catch { }
		$script:UpdateMutex = $null
		Stop-Note 'An Owl debug update is already running (mutex Local\OwlDebugUpdate held). Close that build window, or end the leftover powershell if no window is open, then retry. This exit was logged to owl-debug-update.log.' 2
	}
} catch {
	Stop-Note ("Cannot create update mutex: " + $_.Exception.Message) 3
}

try {
	if (-not $BuildScript) {
		$BuildScript = Join-Path $PSScriptRoot '..\..\scripts\owl-start.ps1'
	}
	if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
		throw "Build script not found: $BuildScript"
	}

	Write-Host 'Owl debug update' -ForegroundColor Green
	Write-Host "  Transcript: $logPath"
	Write-Host '  Waiting for the current Owl process to exit before rebuilding and restarting.'
	Wait-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
	Start-Sleep -Milliseconds 300

	& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $BuildScript
	$exitCode = $LASTEXITCODE
	if ($null -eq $exitCode) { $exitCode = 0 }
	if ($exitCode -ne 0) {
		Stop-Note "Debug update failed with exit code $exitCode. The full build error is shown above and in %TEMP%\owl-start-logs\." $exitCode -KeepOpen
	}

	Write-Host "`nDebug update completed. Owl has been restarted." -ForegroundColor Green
	Start-Sleep -Seconds 1
} catch {
	Stop-Note ("Debug update failed: " + $_.Exception.Message) 1 -KeepOpen
} finally {
	Release-UpdateMutex
	try { Stop-Transcript | Out-Null } catch { }
}
