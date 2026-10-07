param(
  [Parameter(Mandatory = $true)][string]$WorkerPath,
  [int]$Fps = 20,
  [int]$Samples = 100,
  [string]$OutputPath = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public sealed class OwlMotionFixture : Form {
  static OwlMotionFixture form;
  static readonly ManualResetEvent ready = new ManualResetEvent(false);
  volatile bool running = true;
  int paintPending;
  int phase;
  static int paintCount;
  public static int PaintCount { get { return Thread.VolatileRead(ref paintCount); } }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWaitableTimerEx(IntPtr attributes, string name, uint flags, uint access);
  [DllImport("kernel32.dll")] static extern bool SetWaitableTimer(IntPtr handle, ref long due, int period, IntPtr callback, IntPtr arg, bool resume);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  OwlMotionFixture() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    Bounds = new Rectangle(40, 80, 906, 547);
    DoubleBuffered = true;
    Shown += (s, e) => {
      SetWindowPos(Handle, new IntPtr(1), 0, 0, 0, 0, 0x10 | 0x1 | 0x2);
      var animation = new Thread(() => {
        IntPtr timer = CreateWaitableTimerEx(IntPtr.Zero, null, 2, 0x00100002);
        try {
          while (running) {
            if (Interlocked.Exchange(ref paintPending, 1) == 0) {
              try { BeginInvoke(new Action(() => { phase++; Invalidate(); Update(); Interlocked.Exchange(ref paintPending, 0); })); }
              catch (InvalidOperationException) { break; }
            }
            long due = -166667;
            SetWaitableTimer(timer, ref due, 0, IntPtr.Zero, IntPtr.Zero, false);
            WaitForSingleObject(timer, 1000);
          }
        } finally { CloseHandle(timer); }
      });
      animation.IsBackground = true;
      animation.Start();
      ready.Set();
    };
    FormClosed += (s, e) => { running = false; };
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnPaint(PaintEventArgs e) {
    Interlocked.Increment(ref paintCount);
    using (var gradient = new LinearGradientBrush(ClientRectangle, Color.DarkSlateBlue, Color.Orange, phase % 180))
      e.Graphics.FillRectangle(gradient, ClientRectangle);
    for (int y = 40; y < 540; y += 30)
      for (int x = 0; x < 900; x += 36)
        using (var brush = new SolidBrush(Color.FromArgb((x + phase * 3) % 255, (y + phase * 5) % 255, (x + y) % 255)))
          e.Graphics.FillEllipse(brush, x + phase % 12, y, 24, 24);
    int timestamp = (int)(Stopwatch.GetTimestamp() * 1000L / Stopwatch.Frequency) & 0x3ffffff;
    for (int bit = 0; bit < 26; bit++)
      e.Graphics.FillRectangle((timestamp & (1 << bit)) != 0 ? Brushes.White : Brushes.Black, bit * 12, 0, 12, 24);
  }
  public static long Start() {
    var thread = new Thread(() => {
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      form = new OwlMotionFixture();
      Application.Run(form);
    });
    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();
    if (!ready.WaitOne(5000)) throw new Exception("animation fixture did not start");
    return form.Handle.ToInt64();
  }
  public static void Stop() { if (form != null && !form.IsDisposed) form.BeginInvoke(new Action(() => form.Close())); }
}
'@ -ReferencedAssemblies System.Drawing,System.Windows.Forms
$targetHandle = [OwlMotionFixture]::Start()
$worker = New-Object Diagnostics.Process
$worker.StartInfo.FileName = 'powershell.exe'
$worker.StartInfo.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $WorkerPath + '" capture -Hwnd ' + $targetHandle + ' -NoAutoRestore -CaptureDiagnostics -Fps ' + $Fps + ' -FrameTimeoutMs 250'
$worker.StartInfo.UseShellExecute = $false
$worker.StartInfo.CreateNoWindow = $true
$worker.StartInfo.RedirectStandardOutput = $true
$worker.StartInfo.RedirectStandardError = $true
$rows = New-Object Collections.Generic.List[object]
function Percentile($values, [double]$quantile) {
  $sorted = @($values | Sort-Object)
  if (-not $sorted.Count) { return $null }
  return $sorted[[Math]::Min($sorted.Count - 1, [int][Math]::Floor($sorted.Count * $quantile))]
}
try {
  [void]$worker.Start()
  $stderr = $worker.StandardError.ReadToEndAsync()
  $lineTask = $worker.StandardOutput.ReadLineAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  $warmup = 10
  $lastTick = 0
  $measuredAt = 0
  $startCpu = 0
  $startPaints = 0
  while ($rows.Count -lt $Samples -and [DateTime]::UtcNow -lt $deadline) {
    if (-not $lineTask.Wait(1000)) {
      if ($worker.HasExited) { throw $stderr.Result }
      continue
    }
    $line = $lineTask.Result
    $received = [long][Math]::Floor([Diagnostics.Stopwatch]::GetTimestamp() * 1000.0 / [Diagnostics.Stopwatch]::Frequency) -band 0x3ffffff
    $lineTask = $worker.StandardOutput.ReadLineAsync()
    if (-not $line) { continue }
    $message = $line | ConvertFrom-Json
    if ($message.event -eq 'error') { throw $message.message }
    if ($message.event -ne 'frame') { continue }
    if ($warmup -gt 0) { $warmup--; continue }
    if (-not $measuredAt) {
      $measuredAt = [Diagnostics.Stopwatch]::GetTimestamp()
      $worker.Refresh()
      $startCpu = $worker.TotalProcessorTime.TotalMilliseconds
      $startPaints = [OwlMotionFixture]::PaintCount
    }
    $bytes = [Convert]::FromBase64String($message.data)
    $stream = New-Object IO.MemoryStream(,$bytes)
    $bitmap = New-Object Drawing.Bitmap($stream)
    try {
      $painted = 0
      for ($bit = 0; $bit -lt 26; $bit++) {
        if ($bitmap.GetPixel($bit * 12 + 6, 12).R -gt 127) { $painted = $painted -bor (1 -shl $bit) }
      }
      $age = ($received - $painted) -band 0x3ffffff
      $interval = if ($lastTick) { ($received - $lastTick) -band 0x3ffffff } else { 0 }
      $lastTick = $received
      $rows.Add(@{ ageMs = $age; intervalMs = $interval; bytes = $bytes.Length; copyMs = $message.copyMs; encodeMs = $message.encodeMs })
    } finally { $bitmap.Dispose(); $stream.Dispose() }
  }
  if ($rows.Count -lt $Samples) { throw "Only received $($rows.Count) of $Samples frames" }
  $intervals = @($rows | ForEach-Object { $_.intervalMs } | Where-Object { $_ -gt 0 })
  $meanInterval = ($intervals | Measure-Object -Average).Average
  $measuredMilliseconds = ([Diagnostics.Stopwatch]::GetTimestamp() - $measuredAt) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
  $worker.Refresh()
  $cpuOneCore = ($worker.TotalProcessorTime.TotalMilliseconds - $startCpu) * 100.0 / $measuredMilliseconds
  $summary = @{
    requestedFps = $Fps; samples = $rows.Count; observedFps = [Math]::Round(1000 / $meanInterval, 2)
    ageP50Ms = Percentile ($rows | ForEach-Object { $_.ageMs }) 0.5
    ageP95Ms = Percentile ($rows | ForEach-Object { $_.ageMs }) 0.95
    intervalP95Ms = Percentile $intervals 0.95
    copyP50Ms = Percentile ($rows | ForEach-Object { $_.copyMs }) 0.5
    encodeP50Ms = Percentile ($rows | ForEach-Object { $_.encodeMs }) 0.5
    bytesPerFrame = [Math]::Round(($rows | ForEach-Object { $_.bytes } | Measure-Object -Average).Average)
    producerFps = [Math]::Round(([OwlMotionFixture]::PaintCount - $startPaints) * 1000.0 / $measuredMilliseconds, 2)
    cpuOneCorePercent = [Math]::Round($cpuOneCore, 2)
    cpuMachinePercent = [Math]::Round($cpuOneCore / [Environment]::ProcessorCount, 2)
    logicalProcessors = [Environment]::ProcessorCount
  }
  if ($OutputPath) { @{ summary = $summary; frames = $rows } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding UTF8 }
  $summary | ConvertTo-Json -Compress
} finally {
  if ($worker.Id -and -not $worker.HasExited) { $worker.Kill(); $worker.WaitForExit(3000) | Out-Null }
  $worker.Dispose()
  [OwlMotionFixture]::Stop()
}
