// Exercise the production PowerShell decision path with inert desktop stand-ins.
// This never starts the native worker, opens a window, or calls a UIA provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("The production PowerShell contract is Windows-only");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "owl-cu-driver-plan-"));
const driver = join(root, "src", "driver", "computer-driver.ps1");
const source = readFileSync(driver);
assert.ok(source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "PowerShell keeps its UTF-8 BOM");
try {
	const script = join(temporary, "PlanningContract.ps1");
	writeFileSync(script, `\ufeff${String.raw`
param([string]$Driver)
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile($Driver, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('New-ActBlock', 'Get-ControlHold', 'Start-Control', 'Wait-ForegroundIdle', 'Convert-FullWindow', 'Invoke-AppOpen', 'Invoke-ActCore', 'Invoke-Act')) {
    $definition = $tree.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }.GetNewClosure(), $true)
    if (-not $definition) { throw ('Missing production function ' + $name) }
    # Replace only time and process creation in this inert contract. The production
    # decision functions themselves are parsed from the actual driver source.
    $text = $definition.Extent.Text.Replace('[Diagnostics.Stopwatch]::StartNew()', '(New-TestClock)')
    $text = $text.Replace('[Diagnostics.Process]::Start($start)', '(Start-ContractApp $start)')
    Invoke-Expression $text
}
$uiaDefinition = $tree.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Uia' }, $true)
Invoke-Expression ($uiaDefinition.Extent.Text -replace '^function Invoke-Uia', 'function Invoke-ProductionUia')
Add-Type -TypeDefinition @'
using System;
namespace OwlComputerUse {
    public sealed class ChildResult { public bool TimedOut; public int ExitCode; public string Output = ""; }
    public static class DesktopGuard {
        public static bool Monitoring = true, StopRequested, DesktopAvailable = true;
        public static long UserRevision = 10, TargetRevision = 1, Foreground = 99;
        public static int DesktopAcquires;
        public static bool InputDuringQuietRead, InputOnAcquire;
        private static int quietForMs = 2000;
        public static int QuietForMs {
            get {
                int quiet = quietForMs;
                if (InputDuringQuietRead) { InputDuringQuietRead = false; UserRevision++; quietForMs = 0; }
                return quiet;
            }
            set { quietForMs = value; }
        }
        public static int ChildArgumentCount;
        public static ChildResult Child = new ChildResult();
        public static ChildResult RunChild(string executable, string request, int timeout) { ChildArgumentCount = 3; return Child; }
        public static ChildResult RunChild(string executable, string request, int timeout, long hwnd, long targetRevision, long globalRevision, bool exclusive, bool showControl, long controlRequestId, string controlMode, int hold) { ChildArgumentCount = 11; return Child; }
        public static long WindowRevision(long hwnd) { return TargetRevision; }
        public static bool AcquireWindow(long hwnd) { return true; }
        public static bool Acquire() { DesktopAcquires++; if (InputOnAcquire) UserRevision++; return DesktopAvailable; }
        public static void Release() { }
        public static void ReleaseDesktop() { }
        public static void HoldForControlTest(int ms) { }
        public static long ForegroundHwnd() { return Foreground; }
        public static long RootOwner(long hwnd) { return hwnd; }
    }
    public static class Kernel { public static void ReleaseHeldKeys() { } }
    public static class ControlOverlay {
        public static int Begins, Ends;
        public static string Mode;
        public static bool Begin(string mode, long hwnd, long id) { Begins++; Mode = mode; return true; }
        public static void End() { Ends++; }
    }
}
namespace OwlComputerUse.Win32 {
    public sealed class WindowRow {
        public long Hwnd = 123;
        public int Pid = 50, Left = 10, Top = 20, Right = 310, Bottom = 220;
        public string Title = "fixture", Class = "fixture", Process = "fixture";
        public bool Minimized, Foreground = true;
    }
    public static class WindowTools {
        public static int FocusCalls;
        public static string LastFocusDiagnostics = "fixture";
        public static bool Focus(long hwnd) { FocusCalls++; OwlComputerUse.DesktopGuard.Foreground = hwnd; return true; }
        public static WindowRow[] ListWindows() { return new WindowRow[] { new WindowRow() }; }
    }
}
'@
$script:Checks = 0
function Check([bool]$value, [string]$label) {
    if (-not $value) { throw ('RED: ' + $label) }
    $script:Checks++; Write-Output ('PASS ' + $label)
}
function Get-WindowIdentity([long]$hwnd) {
    if ($script:IdentityEffect -eq 'closed') { throw 'inert target closed' }
    if ($script:IdentityEffect -eq 'replaced') { return @{hwnd=123;pid=51;started=61;rect=@(10,20,300,200)} }
    if ($script:IdentityEffect -eq 'moved') { return @{hwnd=123;pid=50;started=60;rect=@(11,20,300,200)} }
    return @{ hwnd = 123; pid = 50; started = 60; rect = @(10,20,300,200) }
}
function Get-UiaExecutable { return 'inert-contract-helper' }
function New-TestClock {
    $clock = New-Object PSObject -Property @{StartedAt=$script:FakeNow}
    $clock | Add-Member ScriptProperty ElapsedMilliseconds { [long]($script:FakeNow - $this.StartedAt) }
    return $clock
}
function Start-Sleep([int]$Milliseconds) {
    if ($Milliseconds -le 0 -or $Milliseconds -gt 50) { throw 'The idle poll interval must stay within 1..50 ms' }
    if ([OwlComputerUse.DesktopGuard]::DesktopAcquires -ne 0 -or [OwlComputerUse.ControlOverlay]::Begins -ne 0 -or [OwlComputerUse.Win32.WindowTools]::FocusCalls -ne 0 -or $script:AppStarts -ne 0) { throw 'Foreground ownership, HUD, focus or launch occurred before idle' }
    $script:FakeNow += $Milliseconds; $script:FakeSleeps++
    if ($script:SleepEffect -eq 'become_idle' -and $script:FakeNow -ge 500) {
        [OwlComputerUse.DesktopGuard]::UserRevision = 11
        [OwlComputerUse.DesktopGuard]::QuietForMs = 800
    }
    if ($script:SleepEffect -eq 'stop') { [OwlComputerUse.DesktopGuard]::StopRequested = $true }
    if ($script:SleepEffect -eq 'target_input') { [OwlComputerUse.DesktopGuard]::TargetRevision++ }
    if ($script:SleepEffect -in @('closed','moved','replaced')) { $script:IdentityEffect = $script:SleepEffect }
    if ($script:SleepEffect -eq 'monitor_lost') { [OwlComputerUse.DesktopGuard]::Monitoring = $false }
}
function Start-ContractApp($start) {
    $script:AppStarts++
    $process = New-Object PSObject -Property @{Id=50}
    $process | Add-Member ScriptMethod Dispose { }
    return $process
}
function Reset([bool]$safe = $false) {
    $script:FakeNow = 0; $script:FakeSleeps = 0; $script:SleepEffect = ''; $script:IdentityEffect = ''; $script:AppStarts = 0
    [OwlComputerUse.DesktopGuard]::Monitoring = $true
    [OwlComputerUse.DesktopGuard]::StopRequested = $false
    [OwlComputerUse.DesktopGuard]::UserRevision = 10
    [OwlComputerUse.DesktopGuard]::TargetRevision = 1
    [OwlComputerUse.DesktopGuard]::Foreground = 99
    [OwlComputerUse.DesktopGuard]::QuietForMs = 2000
    [OwlComputerUse.DesktopGuard]::InputDuringQuietRead = $false
    [OwlComputerUse.DesktopGuard]::InputOnAcquire = $false
    [OwlComputerUse.DesktopGuard]::DesktopAcquires = 0
    [OwlComputerUse.DesktopGuard]::DesktopAvailable = $true
    [OwlComputerUse.ControlOverlay]::Begins = 0
    [OwlComputerUse.Win32.WindowTools]::FocusCalls = 0
    $script:PlanSafe = $safe; $script:PlanEffect = ''; $script:ActualStatus = 'confirmed'
    $script:PlanBackend = $(if($safe){'win32_edit_message'}else{'uia_provider'})
    $script:Calls = New-Object 'Collections.Generic.List[object]'
    $script:Observation = @{ id = 'fresh'; identity = (Get-WindowIdentity 123); created = [DateTime]::UtcNow;
        targetRevision = 1; revision = 10; screenshot = $null;
        elements = @{ e1 = @{ id = 'e1'; name = 'fixture'; password = $false; enabled = $true; patterns = @('Invoke','Value'); rect = @{x=10;y=20;width=100;height=50} } } }
}
function Invoke-Uia($request) {
    $copy = @{}; foreach ($key in $request.Keys) { $copy[$key] = $request[$key] }; $script:Calls.Add($copy)
    if ($request.action -eq 'plan') {
        if ($script:PlanEffect -eq 'target_input') { [OwlComputerUse.DesktopGuard]::TargetRevision++ }
        if ($script:PlanEffect -eq 'other_window_input_then_idle') {
            [OwlComputerUse.DesktopGuard]::UserRevision++
            [OwlComputerUse.DesktopGuard]::QuietForMs = 1000
        }
        if ($script:PlanEffect -eq 'stop') { [OwlComputerUse.DesktopGuard]::StopRequested = $true }
        if ($script:PlanEffect -eq 'unavailable') { return @{status='blocked';code='uia_plan_unavailable'} }
        if ($script:PlanEffect -eq 'throw') { throw 'inert helper unavailable' }
        if ($script:PlanEffect -eq 'slow') { $script:FakeNow += 6500 }
        return @{status='confirmed';code='action_plan';requestedAction=$request.requestedAction;
            backend=$script:PlanBackend;
            backgroundSafe=$script:PlanSafe;requiresExclusive=(-not $script:PlanSafe)}
    }
    return @{status=$script:ActualStatus;code='fixture_result'}
}
function Request([string]$action, [string]$mode = 'auto') {
    return @{id=1;observationId='fresh';action=$action;inputMode=$mode;elementId='e1';replace=$true;text='fixture text'}
}

Reset
[OwlComputerUse.DesktopGuard]::QuietForMs = 100
$result = Invoke-Act (Request 'click')
Check ($result.code -eq 'user_busy' -and $script:Calls.Count -eq 1 -and $script:Calls[0].action -eq 'plan' -and $script:FakeNow -eq 8000 -and $script:FakeSleeps -eq 160 -and $result.idleWaitMs -eq 8000) 'auto waits a bounded eight seconds before rejecting a continuously busy desktop'
Check ([OwlComputerUse.ControlOverlay]::Begins -eq 0 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'busy planning shows no control HUD and never focuses'

Reset
[OwlComputerUse.DesktopGuard]::QuietForMs = 100
$script:SleepEffect = 'become_idle'
$result = Invoke-Act (Request 'click')
Check ($result.status -eq 'confirmed' -and $script:FakeNow -eq 500 -and $script:Calls.Count -eq 2 -and $script:Calls[1].globalRevision -eq 11) 'auto catches natural idle locally and invokes the planned action exactly once with its fresh global revision'
Check ($result.idleWaitMs -eq 500 -and $result.idleQuietForMs -eq 800 -and $result.idleGrantedAtMs -gt 0 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 1) 'idle grant metadata matches the wait and foreground control is acquired only afterward'

foreach ($effect in @('stop','target_input','closed','moved','replaced','monitor_lost')) {
    Reset
    [OwlComputerUse.DesktopGuard]::QuietForMs = 100
    $script:SleepEffect = $effect
    $result = Invoke-Act (Request 'type')
    $expected = @{stop='physical_escape';target_input='target_intervened';closed='target_gone';moved='geometry_changed';replaced='target_replaced';monitor_lost='input_monitor_unavailable'}[$effect]
    Check ($result.code -eq $expected -and $script:FakeSleeps -eq 1 -and $script:Calls.Count -eq 1 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0 -and [OwlComputerUse.ControlOverlay]::Begins -eq 0 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) ('waiting aborts immediately without control when ' + $effect)
}

Reset
[OwlComputerUse.DesktopGuard]::QuietForMs = 100
$script:PlanEffect = 'slow'
$result = Invoke-Act (Request 'type')
Check ($result.code -eq 'user_busy' -and $script:FakeNow -eq 8000 -and $result.idleWaitMs -eq 1500 -and $script:Calls.Count -eq 1) 'planning time reduces the local idle wait so the native action retains its request budget'

Reset
[OwlComputerUse.DesktopGuard]::QuietForMs = 100
$script:SleepEffect = 'become_idle'
$result = Invoke-Act (Request 'set_value' 'foreground')
Check ($result.code -eq 'user_busy' -and $script:FakeSleeps -eq 0 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0) 'explicit foreground never waits or refreshes its observation revision'

Reset
[OwlComputerUse.DesktopGuard]::InputOnAcquire = $true
$result = Invoke-Act (Request 'set_value')
Check ($result.code -eq 'input_conflict' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.ControlOverlay]::Begins -eq 0 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'input after the idle grant and mutex acquisition cannot trigger a HUD or focus'

Reset
[OwlComputerUse.DesktopGuard]::QuietForMs = 100
$script:SleepEffect = 'become_idle'
$request = Request 'open_app'; $request.app = 'Fixture!App'
$result = Invoke-Act $request
Check ($result.code -eq 'app_window_ready' -and $result.executedMode -eq 'foreground' -and $script:FakeNow -eq 500 -and $script:AppStarts -eq 1 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 1) 'open_app uses the same bounded local idle grant and launches once only after it'

Reset
[OwlComputerUse.DesktopGuard]::QuietForMs = 100
$request = Request 'open_app'; $request.app = 'Fixture!App'
$result = Invoke-Act $request
Check ($result.code -eq 'user_busy' -and $script:FakeNow -eq 8000 -and $script:AppStarts -eq 0 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0 -and [OwlComputerUse.ControlOverlay]::Begins -eq 0) 'continuously busy open_app is bounded and never launches or acquires foreground'

Reset
[OwlComputerUse.DesktopGuard]::QuietForMs = 100
$script:SleepEffect = 'stop'
$request = Request 'open_app'; $request.app = 'Fixture!App'
$result = Invoke-Act $request
Check ($result.code -eq 'physical_escape' -and $result.retryable -eq $false -and $script:FakeSleeps -eq 1 -and $script:AppStarts -eq 0) 'open_app waiting stops at the first poll without a launch'

Reset
[OwlComputerUse.DesktopGuard]::UserRevision = 11
$request = Request 'open_app' 'foreground'; $request.app = 'Fixture!App'
$result = Invoke-Act $request
Check ($result.code -eq 'user_intervened' -and $script:FakeSleeps -eq 0 -and $script:AppStarts -eq 0 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0) 'explicit foreground open_app rejects a stale global token without waiting or launching'

Reset
[OwlComputerUse.DesktopGuard]::InputDuringQuietRead = $true
$request = Request 'open_app'; $request.app = 'Fixture!App'
$result = Invoke-Act $request
Check ($result.code -eq 'input_conflict' -and $script:AppStarts -eq 0 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0) 'open_app also rejects input racing the quiet snapshot'

Reset
$result = Invoke-Act (Request 'click')
Check ($result.status -eq 'confirmed' -and $script:Calls.Count -eq 2) 'auto executes one semantic action after a successful plan'
Check ($script:Calls[1].expectedBackend -eq 'uia_provider') 'the actual semantic request is pinned to the backend selected by its plan'
Check ($script:Calls[1].action -eq 'invoke' -and $script:Calls[1].exclusive -eq $true -and $result.executedAction -eq 'invoke' -and $result.executedMode -eq 'foreground') 'auto preserves mapped Invoke in foreground instead of guessing click coordinates'
Check ($script:Calls[0].showControl -ne $true -and $script:Calls[1].controlMode -eq 'foreground' -and [OwlComputerUse.ControlOverlay]::Mode -eq 'foreground') 'control starts only after the actual foreground mode is selected'

Reset
$result = Invoke-Act (Request 'type')
Check ($result.status -eq 'confirmed' -and $script:Calls[1].action -eq 'set_value' -and $script:Calls[1].exclusive -eq $true) 'auto replacement preserves semantic SetValue when foreground is required'

Reset
[OwlComputerUse.DesktopGuard]::InputDuringQuietRead = $true
$result = Invoke-Act (Request 'type')
Check ($result.code -eq 'input_conflict' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0 -and [OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0 -and [OwlComputerUse.ControlOverlay]::Begins -eq 0) 'input during the quiet snapshot cannot become the accepted foreground revision'

Reset
$script:PlanEffect = 'other_window_input_then_idle'
$result = Invoke-Act (Request 'type')
Check ($result.status -eq 'confirmed' -and $script:Calls.Count -eq 2 -and $script:Calls[1].globalRevision -eq 11 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 1) 'auto uses a fresh global revision after other-window activity during planning has become idle'

Reset
$script:PlanEffect = 'other_window_input_then_idle'
$result = Invoke-Act (Request 'set_value' 'foreground')
Check ($result.code -eq 'user_intervened' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'explicit foreground still requires the observation global revision after planning'

Reset
$result = Invoke-Act (Request 'click' 'background')
Check ($result.status -eq 'blocked' -and $result.requiresExclusive -eq $true -and $script:Calls.Count -eq 1) 'explicit background blocks an unverified provider before invocation'
Check ([OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0 -and [OwlComputerUse.ControlOverlay]::Begins -eq 0) 'rejected background does not acquire foreground control or show HUD'

Reset $true
[OwlComputerUse.DesktopGuard]::QuietForMs = 0
$result = Invoke-Act (Request 'type')
Check ($result.status -eq 'confirmed' -and $result.executedMode -eq 'background' -and $script:Calls[1].exclusive -eq $false) 'verified native backend keeps background operation while another window is busy'
Check ($script:Calls[1].expectedBackend -eq 'win32_edit_message') 'a verified background request also pins its native backend'
Check ([OwlComputerUse.DesktopGuard]::DesktopAcquires -eq 0 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'verified background operation never focuses or acquires desktop'

Reset
$script:ActualStatus = 'unknown'
$result = Invoke-Act (Request 'type')
Check ($result.status -eq 'unknown' -and $script:Calls.Count -eq 2 -and $script:Calls[1].action -eq 'set_value') 'an unknown semantic outcome is never replayed through another executor'

Reset
[OwlComputerUse.DesktopGuard]::DesktopAvailable = $false
$result = Invoke-Act (Request 'type')
Check ($result.code -eq 'desktop_busy' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'foreground fallback respects the desktop mutex before any semantic action'

Reset
$script:PlanEffect = 'target_input'
$result = Invoke-Act (Request 'click')
Check ($result.status -eq 'blocked' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'target input during planning prevents focus and mutation'

Reset
$script:PlanEffect = 'stop'
$result = Invoke-Act (Request 'click')
Check ($result.status -eq 'blocked' -and $result.retryable -eq $false -and $script:Calls.Count -eq 1 -and [OwlComputerUse.ControlOverlay]::Begins -eq 0) 'explicit stop during planning prevents all actual control'

Reset
$script:PlanEffect = 'unavailable'
$result = Invoke-Act (Request 'click')
Check ($result.status -eq 'blocked' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'unavailable planning never probes an action by performing it'

Reset
$script:PlanEffect = 'throw'
$result = Invoke-Act (Request 'click')
Check ($result.code -eq 'uia_plan_unavailable' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.ControlOverlay]::Begins -eq 0) 'a planning exception fails without desktop side effects'

foreach ($invalidBackend in @('', ' ', 42)) {
    Reset
    $script:PlanBackend = $invalidBackend
    $result = Invoke-Act (Request 'type')
    Check ($result.code -eq 'uia_plan_unavailable' -and $script:Calls.Count -eq 1 -and [OwlComputerUse.Win32.WindowTools]::FocusCalls -eq 0) 'a missing or non-string planned backend blocks before focus or action'
}

[OwlComputerUse.DesktopGuard]::Child.TimedOut = $true
$result = Invoke-ProductionUia @{action='plan';hwnd=123;showControl=$true}
Check ($result.status -eq 'blocked' -and $result.code -eq 'uia_plan_timeout' -and [OwlComputerUse.DesktopGuard]::ChildArgumentCount -eq 3) 'production plan timeout stays read-only and cannot arm the parent control handshake'
$result = Invoke-ProductionUia @{action='set_value';hwnd=123;showControl=$true}
Check ($result.status -eq 'unknown' -and [OwlComputerUse.DesktopGuard]::ChildArgumentCount -eq 11) 'an actual semantic timeout preserves unknown outcome'
[OwlComputerUse.DesktopGuard]::Child.TimedOut = $false
[OwlComputerUse.DesktopGuard]::Child.ExitCode = 1
$result = Invoke-ProductionUia @{action='plan';hwnd=123}
Check ($result.status -eq 'blocked') 'a read-only planning child failure is never mislabeled as an executed unknown action'
Write-Output ($script:Checks.ToString() + ' production PowerShell planning checks passed; no desktop API was called.')
`}`, "utf8");
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Driver", driver], { encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	process.stdout.write(result.stdout);
} finally {
	const target = realpathSync(temporary);
	assert.ok(target.startsWith(`${realpathSync(tmpdir())}${sep}`) && target.includes("owl-cu-driver-plan-"));
	rmSync(target, { recursive: true, force: true });
}
