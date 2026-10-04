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

function Stop-Note([string]$Message, [int]$ExitCode) {
	Write-Host $Message -ForegroundColor Red
	try { Stop-Transcript | Out-Null } catch { }
	if ($Host.Name -eq 'ConsoleHost') {
		[void](Read-Host 'Press Enter to close this window')
	}
	exit $ExitCode
}

$createdNew = $false
$mutex = $null
try {
	$mutex = New-Object Threading.Mutex($true, 'Local\OwlDebugUpdate', [ref]$createdNew)
} catch {
	Stop-Note ("Cannot create update mutex: " + $_.Exception.Message) 3
}
if (-not $createdNew) {
	$mutex.Dispose()
	Stop-Note 'An Owl debug update is already running (mutex Local\OwlDebugUpdate held). If no update window is open, delete the stale holder or reboot; this exit was logged to owl-debug-update.log.' 2
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
		Write-Host "`nDebug update failed with exit code $exitCode. The full build error is shown above and in %TEMP%\owl-start-logs\." -ForegroundColor Red
		[void](Read-Host 'Press Enter to close this window')
		exit $exitCode
	}

	Write-Host "`nDebug update completed. Owl has been restarted." -ForegroundColor Green
	Start-Sleep -Seconds 1
} catch {
	Write-Host ("`nDebug update failed: " + $_.Exception.Message) -ForegroundColor Red
	[void](Read-Host 'Press Enter to close this window')
	exit 1
} finally {
	try { $mutex.ReleaseMutex() } catch { }
	$mutex.Dispose()
	try { Stop-Transcript | Out-Null } catch { }
}
