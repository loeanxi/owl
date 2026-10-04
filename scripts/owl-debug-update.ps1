[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateRange(1, [int]::MaxValue)]
	[int]$ParentProcessId,
	[string]$BuildScript = (Join-Path $PSScriptRoot '..\..\scripts\owl-native-dev.ps1')
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }

$createdNew = $false
$mutex = New-Object Threading.Mutex($true, 'Local\OwlDebugUpdate', [ref]$createdNew)
if (-not $createdNew) {
	Write-Host 'An Owl debug update is already running.' -ForegroundColor Yellow
	$mutex.Dispose()
	exit 2
}

try {
	if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
		throw "Full build script not found: $BuildScript"
	}

	Write-Host 'Owl debug update' -ForegroundColor Green
	Write-Host '  Waiting for the current Owl process to exit before rebuilding and restarting.'
	Wait-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
	Start-Sleep -Milliseconds 300

	& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $BuildScript
	$exitCode = $LASTEXITCODE
	if ($null -eq $exitCode) { $exitCode = 0 }
	if ($exitCode -ne 0) {
		Write-Host "`nDebug update failed with exit code $exitCode. The full build error is shown above." -ForegroundColor Red
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
	$mutex.ReleaseMutex()
	$mutex.Dispose()
}
