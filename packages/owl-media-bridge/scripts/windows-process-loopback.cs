// Process-scoped WASAPI loopback meter for the DSH media bridge waveform.
//
// Captures ONLY the render audio of explicitly targeted process ids through
// the Windows 10 (build 19041+) process-loopback activation path. Everything
// here stays in memory inside the helper process: amplitude and FFT bands are
// streamed to stdout as compact NDJSON lines and nothing is persisted.
//
// Keep this file ASCII-only: it is loaded with Add-Type, which assumes ANSI
// when the file has no BOM. User-facing wording lives in the TypeScript layer.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DshMediaBridge.Windows
{
    public sealed class ProcessLoopbackMeter
    {
        internal const string LoopbackDeviceId = "VAD\\Process_Loopback";
        private const int MaxEngines = 4;
        private const int WindowSize = 1024;
        private const int SampleRate = 48000;

        private readonly object gate = new object();
        private readonly List<LoopbackEngine> engines = new List<LoopbackEngine>();
        private readonly string[] processNames;
        private readonly int intervalMs;
        private readonly int bandCount;
        private readonly int idleExitSeconds;
        private readonly Action<string> emit;
        private bool running = true;

        private ProcessLoopbackMeter(string[] processNames, int intervalMs, int bandCount, int idleExitSeconds, Action<string> emit)
        {
            this.processNames = processNames;
            this.intervalMs = intervalMs;
            this.bandCount = bandCount;
            this.idleExitSeconds = idleExitSeconds;
            this.emit = emit;
        }

        /// <summary>
        /// Blocks while streaming merged amplitude/FFT frames for the target
        /// processes. Returns when the helper is stopped or when no matching
        /// process produced audio for the idle window.
        /// </summary>
        public static void Run(string[] processNames, int intervalMs, int bandCount, int idleExitSeconds, Action<string> emit)
        {
            if (processNames == null || processNames.Length == 0) throw new ArgumentNullException("processNames");
            if (emit == null) throw new ArgumentNullException("emit");
            if (intervalMs < 20) intervalMs = 20;
            if (intervalMs > 1000) intervalMs = 1000;
            if (bandCount < 8) bandCount = 8;
            if (bandCount > 48) bandCount = 48;
            if (idleExitSeconds < 10) idleExitSeconds = 10;

            if (Environment.OSVersion.Version.Build < 19041)
            {
                emit(ErrorLine("PROCESS_LOOPBACK_UNSUPPORTED", "Per-process audio capture needs Windows 10 version 2004 (build 19041) or newer."));
                return;
            }

            var meter = new ProcessLoopbackMeter(processNames, intervalMs, bandCount, idleExitSeconds, emit);
            meter.RunLoop();
        }

        private void RunLoop()
        {
            RefreshTargets(DateTime.UtcNow);
            var startedPids = new List<int>();
            lock (gate)
            {
                foreach (LoopbackEngine engine in engines) startedPids.Add(engine.ProcessId);
            }
            if (startedPids.Count > 0) emit(JsonObject("event", "started", "pids", JoinInts(startedPids)));

            var utcNow = DateTime.UtcNow;
            var lastRefresh = utcNow;
            var lastActiveUtc = utcNow;
            var startedUtc = utcNow;
            var lastFailureEmitUtc = DateTime.MinValue;

            while (running)
            {
                Thread.Sleep(intervalMs);
                utcNow = DateTime.UtcNow;
                if ((utcNow - lastRefresh).TotalMilliseconds >= 2000)
                {
                    lastRefresh = utcNow;
                    RefreshTargets(utcNow);
                }

                int targets;
                int active;
                lock (gate)
                {
                    targets = engines.Count;
                    active = 0;
                    foreach (LoopbackEngine engine in engines)
                    {
                        if (engine.IsHealthy) active++;
                    }
                }

                if (active > 0)
                {
                    lastActiveUtc = utcNow;
                }
                else if (targets > 0 && (utcNow - lastFailureEmitUtc).TotalSeconds >= 10)
                {
                    string failure = null;
                    bool allPermanent = true;
                    lock (gate)
                    {
                        foreach (LoopbackEngine engine in engines)
                        {
                            if (!engine.PermanentFailure) { allPermanent = false; break; }
                            if (failure == null && engine.LastError != null) failure = engine.LastError;
                        }
                    }
                    if (allPermanent && failure != null)
                    {
                        lastFailureEmitUtc = utcNow;
                        emit(ErrorLine("PROCESS_CAPTURE_FAILED", failure));
                    }
                }
                else if ((utcNow - lastActiveUtc).TotalSeconds >= idleExitSeconds
                    && (utcNow - startedUtc).TotalSeconds >= idleExitSeconds)
                {
                    emit(JsonObject("event", "stopped", "reason", "idle-no-targets"));
                    break;
                }

                EmitFrame(utcNow, targets, active);
            }

            Shutdown();
        }

        private void RefreshTargets(DateTime utcNow)
        {
            var discovered = new List<int>();
            foreach (string name in processNames)
            {
                Process[] procs = Process.GetProcessesByName(name);
                foreach (Process proc in procs)
                {
                    try { discovered.Add(proc.Id); }
                    finally { proc.Dispose(); }
                }
            }
            discovered.Sort();

            var retired = new List<LoopbackEngine>();
            lock (gate)
            {
                for (int index = engines.Count - 1; index >= 0; index--)
                {
                    if (!discovered.Contains(engines[index].ProcessId))
                    {
                        retired.Add(engines[index]);
                        engines.RemoveAt(index);
                    }
                }
                foreach (int pid in discovered)
                {
                    if (engines.Count >= MaxEngines) break;
                    bool known = false;
                    foreach (LoopbackEngine engine in engines)
                    {
                        if (engine.ProcessId == pid) { known = true; break; }
                    }
                    if (known) continue;
                    engines.Add(new LoopbackEngine(pid));
                }
            }

            // Join retired capture threads outside the gate so emission is
            // never stalled by engine teardown.
            foreach (LoopbackEngine engine in retired) engine.Dispose();
        }

        private void EmitFrame(DateTime utcNow, int targets, int active)
        {
            double bestRms = 0;
            double peak = 0;
            double[] bandSource = null;

            lock (gate)
            {
                foreach (LoopbackEngine engine in engines)
                {
                    double sumSquares;
                    int sampleCount;
                    double enginePeak;
                    engine.ConsumeAccumulators(out sumSquares, out sampleCount, out enginePeak);
                    if (sampleCount <= 0) continue;
                    double rms = Math.Sqrt(sumSquares / sampleCount);
                    if (rms > bestRms)
                    {
                        bestRms = rms;
                        bandSource = engine.CopyWindow();
                    }
                    if (enginePeak > peak) peak = enginePeak;
                }
            }

            // Perceptual gain: music sits around 0.02-0.25 linear RMS; scale up
            // and soft-clip so quiet passages stay lively without pinning.
            double rmsDisplay = Math.Min(1.0, bestRms * 3.0);
            double peakDisplay = Math.Min(1.0, peak);
            double[] bands = ComputeBands(bandSource ?? new double[WindowSize], bandCount);

            var line = new StringBuilder(64 + bandCount * 6);
            line.Append("{\"t\":").Append(ToUnixMs(utcNow));
            line.Append(",\"rms\":").Append(rmsDisplay.ToString("0.###", CultureInfo.InvariantCulture));
            line.Append(",\"peak\":").Append(peakDisplay.ToString("0.###", CultureInfo.InvariantCulture));
            line.Append(",\"bands\":[");
            for (int index = 0; index < bands.Length; index++)
            {
                if (index > 0) line.Append(',');
                line.Append(bands[index].ToString("0.###", CultureInfo.InvariantCulture));
            }
            line.Append("],\"targets\":").Append(targets);
            line.Append(",\"active\":").Append(active);
            line.Append('}');
            emit(line.ToString());
        }

        private void Shutdown()
        {
            running = false;
            lock (gate)
            {
                foreach (LoopbackEngine engine in engines) engine.Dispose();
                engines.Clear();
            }
        }

        public static double[] ComputeBands(double[] window, int bandCount)
        {
            var real = new double[WindowSize];
            var imaginary = new double[WindowSize];
            int available = window.Length < WindowSize ? window.Length : WindowSize;
            for (int index = 0; index < available; index++)
            {
                double tapered = window[index] * FftTables.Hann[index];
                real[index] = tapered;
            }

            FftTables.Transform(real, imaginary);

            double nyquist = SampleRate / 2.0;
            double lowHz = 40.0;
            double highHz = Math.Min(16000.0, nyquist);
            double binWidth = (double)SampleRate / WindowSize;
            var bands = new double[bandCount];
            for (int band = 0; band < bandCount; band++)
            {
                double edgeLow = lowHz * Math.Pow(highHz / lowHz, (double)band / bandCount);
                double edgeHigh = lowHz * Math.Pow(highHz / lowHz, (double)(band + 1) / bandCount);
                int firstBin = (int)Math.Ceiling(edgeLow / binWidth);
                int lastBin = (int)Math.Ceiling(edgeHigh / binWidth) - 1;
                if (lastBin < firstBin) lastBin = firstBin;
                if (firstBin < 1) firstBin = 1;
                if (lastBin >= WindowSize / 2) lastBin = WindowSize / 2 - 1;

                double magnitude = 0;
                for (int bin = firstBin; bin <= lastBin; bin++)
                {
                    double re = real[bin];
                    double im = imaginary[bin];
                    double binMagnitude = Math.Sqrt(re * re + im * im);
                    if (binMagnitude > magnitude) magnitude = binMagnitude;
                }
                double decibels = 20.0 * Math.Log10(magnitude + 1e-9);
                double normalized = (decibels + 66.0) / 60.0;
                if (normalized < 0) normalized = 0;
                if (normalized > 1) normalized = 1;
                bands[band] = normalized;
            }
            return bands;
        }

        internal static string JsonObject(string key, string value)
        {
            return "{\"" + key + "\":\"" + value + "\"}";
        }

        internal static string JsonObject(string key, string value, string key2, string value2)
        {
            return "{\"" + key + "\":\"" + value + "\",\"" + key2 + "\":\"" + value2 + "\"}";
        }

        public static string ErrorLine(string code, string message)
        {
            var escaped = new StringBuilder(message.Length + 24);
            escaped.Append("{\"error\":{\"code\":\"").Append(code).Append("\",\"message\":\"");
            AppendEscaped(escaped, message);
            escaped.Append("\"}}");
            return escaped.ToString();
        }

        internal static void AppendEscaped(StringBuilder builder, string value)
        {
            foreach (char ch in value)
            {
                if (ch == '"' || ch == '\\') { builder.Append('\\').Append(ch); }
                else if (ch < 0x20) { builder.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)ch); }
                else builder.Append(ch);
            }
        }

        private static string JoinInts(List<int> values)
        {
            var joined = new StringBuilder(values.Count * 7);
            joined.Append('[');
            for (int index = 0; index < values.Count; index++)
            {
                if (index > 0) joined.Append(',');
                joined.Append(values[index]);
            }
            joined.Append(']');
            return joined.ToString();
        }

        private static long ToUnixMs(DateTime utc)
        {
            return (long)(utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }

    internal static class FftTables
    {
        internal static readonly double[] Hann = BuildHann(WindowSizeConst);
        private static readonly int[] BitReverse = BuildBitReverse(WindowSizeConst);

        private const int WindowSizeConst = 1024;

        internal static void Transform(double[] real, double[] imaginary)
        {
            int n = real.Length;
            for (int index = 0; index < n; index++)
            {
                int target = BitReverse[index];
                if (target > index)
                {
                    double tmp = real[index]; real[index] = real[target]; real[target] = tmp;
                    tmp = imaginary[index]; imaginary[index] = imaginary[target]; imaginary[target] = tmp;
                }
            }
            for (int size = 2; size <= n; size <<= 1)
            {
                int half = size >> 1;
                double step = -2.0 * Math.PI / size;
                for (int start = 0; start < n; start += size)
                {
                    for (int pair = 0; pair < half; pair++)
                    {
                        double angle = step * pair;
                        double wr = Math.Cos(angle);
                        double wi = Math.Sin(angle);
                        int left = start + pair;
                        int right = left + half;
                        double tr = real[right] * wr - imaginary[right] * wi;
                        double ti = real[right] * wi + imaginary[right] * wr;
                        real[right] = real[left] - tr;
                        imaginary[right] = imaginary[left] - ti;
                        real[left] += tr;
                        imaginary[left] += ti;
                    }
                }
            }
        }

        private static double[] BuildHann(int size)
        {
            var table = new double[size];
            for (int index = 0; index < size; index++)
            {
                table[index] = 0.5 - 0.5 * Math.Cos(2.0 * Math.PI * index / size);
            }
            return table;
        }

        private static int[] BuildBitReverse(int size)
        {
            int bits = 0;
            while ((1 << bits) < size) bits++;
            var table = new int[size];
            for (int index = 0; index < size; index++)
            {
                int reversed = 0;
                for (int bit = 0; bit < bits; bit++)
                {
                    if ((index & (1 << bit)) != 0) reversed |= 1 << (bits - 1 - bit);
                }
                table[index] = reversed;
            }
            return table;
        }
    }

    /// <summary>Keeps FFT sizing constants reachable from static initializers.</summary>
    internal static class ProcessLoopbackBandwidth
    {
        internal const int WindowSize = 1024;
    }

    internal sealed class LoopbackEngine : IDisposable
    {
        private const uint StreamFlagsLoopbackEventCallback = 0x00020000 | 0x00040000;
        private const uint StreamOptionsLoopback = 0x00000020;
        private const int BufferFlagsSilent = 0x2;

        private readonly object gate = new object();
        private readonly ManualResetEvent done = new ManualResetEvent(false);
        private readonly double[] window = new double[ProcessLoopbackBandwidth.WindowSize];
        private Thread thread;
        private volatile bool running = true;
        private volatile bool healthy;
        private volatile bool permanentFailure;
        private volatile string lastError;
        private int processIdField;

        public LoopbackEngine(int processId)
        {
            processIdField = processId;
            thread = new Thread(ThreadMain);
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
        }

        public int ProcessId { get { return processIdField; } }
        public bool IsHealthy { get { return healthy && !permanentFailure; } }
        public bool PermanentFailure { get { return permanentFailure; } }
        public string LastError { get { return lastError; } }

        public void ConsumeAccumulators(out double sumSquares, out int sampleCount, out double peak)
        {
            lock (gate)
            {
                sumSquares = pendingSumSquares;
                sampleCount = pendingSampleCount;
                peak = pendingPeak;
                pendingSumSquares = 0;
                pendingSampleCount = 0;
                pendingPeak = 0;
            }
        }

        public double[] CopyWindow()
        {
            lock (gate)
            {
                var copy = new double[window.Length];
                Array.Copy(window, copy, window.Length);
                return copy;
            }
        }

        public void Dispose()
        {
            running = false;
            done.Set();
            Thread worker = thread;
            thread = null;
            if (worker != null && worker.Join(900)) return;
            // Leave the background thread to die with the process; it only
            // waits on its own event handles and never blocks shutdown.
        }

        private void ThreadMain()
        {
            try
            {
                CaptureLoop();
            }
            catch (Exception error)
            {
                lastError = error.Message;
                permanentFailure = true;
            }
            finally
            {
                done.Set();
            }
        }

        private void CaptureLoop()
        {
            IWASAudioClient client = null;
            IAudioCaptureClient capture = null;
            IntPtr waveEvent = IntPtr.Zero;
            bool started = false;
            try
            {
                client = ActivateLoopbackClient(processIdField);
                ApplyLoopbackClientProperties(client);
                InitializeFloatFormat(client);

                waveEvent = NativeMethods.CreateEventW(IntPtr.Zero, 0, 0, null);
                if (waveEvent == IntPtr.Zero) throw new CaptureException("Failed to create the capture event.");
                ThrowIfFailed(client.SetEventHandle(waveEvent));

                Guid captureIid = typeof(IAudioCaptureClient).GUID;
                object captureUnknown;
                ThrowIfFailed(client.GetService(ref captureIid, out captureUnknown));
                capture = (IAudioCaptureClient)captureUnknown;

                ThrowIfFailed(client.Start());
                started = true;
                healthy = true;

                while (running)
                {
                    int wait = NativeMethods.WaitForSingleObject(waveEvent, 500);
                    if (!running) break;
                    if (wait == 0 || wait == 0x00000102) DrainPackets(capture);
                }
            }
            catch (CaptureException)
            {
                permanentFailure = true;
                throw;
            }
            finally
            {
                if (started && client != null)
                {
                    try { client.Stop(); }
                    catch { /* best effort */ }
                }
                if (waveEvent != IntPtr.Zero) NativeMethods.CloseHandle(waveEvent);
                ReleaseComObject(capture);
                ReleaseComObject(client);
                healthy = false;
            }
        }

        private void DrainPackets(IAudioCaptureClient capture)
        {
            while (running)
            {
                int packetFrames;
                int hr = capture.GetNextPacketSize(out packetFrames);
                if (hr < 0) { permanentFailure = true; return; }
                if (packetFrames <= 0) return;

                IntPtr data;
                int frames;
                uint flags;
                long devicePosition;
                long qpcPosition;
                hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                if (hr < 0) { permanentFailure = true; return; }

                if (data != IntPtr.Zero && (flags & BufferFlagsSilent) == 0 && frames > 0)
                {
                    Accumulate(data, frames);
                }

                hr = capture.ReleaseBuffer(frames);
                if (hr < 0) { permanentFailure = true; return; }
            }
        }

        private void Accumulate(IntPtr data, int frames)
        {
            int channelCount = 2;
            int needed = frames * channelCount;
            if (scratch.Length < needed) scratch = new float[Math.Max(needed, 2048)];
            Marshal.Copy(data, scratch, 0, needed);

            lock (gate)
            {
                for (int frame = 0; frame < frames; frame++)
                {
                    double left = scratch[frame * channelCount];
                    double right = scratch[frame * channelCount + 1];
                    double mono = (left + right) * 0.5;
                    pendingSumSquares += mono * mono;
                    double magnitude = Math.Abs(mono);
                    if (magnitude > pendingPeak) pendingPeak = magnitude;
                    window[windowHead] = mono;
                    windowHead = (windowHead + 1) % window.Length;
                }
                pendingSampleCount += frames;
            }
        }

        private float[] scratch = new float[2048];
        private double pendingSumSquares;
        private int pendingSampleCount;
        private double pendingPeak;
        private int windowHead;

        private static IWASAudioClient ActivateLoopbackClient(int processId)
        {
            var handler = new AgileActivationHandler();
            IntPtr activationParams = Marshal.AllocHGlobal(12);
            IntPtr variant = IntPtr.Zero;
            try
            {
                Marshal.WriteInt32(activationParams, 0, 1);              // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
                Marshal.WriteInt32(activationParams, 4, 0);              // PROCESS_LOOPBACK_MODE_PROCESS_TARGET_ONLY
                Marshal.WriteInt32(activationParams, 8, processId);      // TargetProcessId

                int pointerOffset = IntPtr.Size == 8 ? 16 : 12;
                int variantSize = pointerOffset + IntPtr.Size;
                variant = Marshal.AllocHGlobal(variantSize);
                for (int offset = 0; offset < variantSize; offset += 4) Marshal.WriteInt32(variant, offset, 0);
                Marshal.WriteInt16(variant, 0, 65);                      // VT_BLOB
                Marshal.WriteInt32(variant, pointerOffset - IntPtr.Size, 12); // blob.cbSize

                // blob.pBlobData lives at the trailing pointer-sized slot; write it
                // explicitly so both x86 and x64 layouts are honored.
                if (IntPtr.Size == 8) Marshal.WriteInt64(variant, 16, activationParams.ToInt64());
                else Marshal.WriteInt32(variant, 12, activationParams.ToInt32());

                Guid clientIid = typeof(IWASAudioClient).GUID;
                IActivateAudioInterfaceAsyncOperation operation;
                int hr = NativeMethods.ActivateAudioInterfaceAsync(
                    ProcessLoopbackMeter.LoopbackDeviceId,
                    ref clientIid,
                    variant,
                    handler,
                    out operation);
                if (hr < 0) throw new CaptureException(HrMessage(hr, "activating the process loopback audio interface"));
                if (!handler.Wait(8000)) throw new CaptureException("Timed out activating the process loopback audio interface.");

                int resultHr;
                object activated;
                operation.ActivateResult(out resultHr, out activated);
                if (resultHr < 0 || activated == null)
                {
                    throw new CaptureException(HrMessage(resultHr, "the process loopback activation was rejected"));
                }
                return (IWASAudioClient)activated;
            }
            finally
            {
                if (variant != IntPtr.Zero) Marshal.FreeHGlobal(variant);
                Marshal.FreeHGlobal(activationParams);
            }
        }

        private static void ApplyLoopbackClientProperties(IWASAudioClient client)
        {
            IntPtr properties = Marshal.AllocHGlobal(16);
            try
            {
                Marshal.WriteInt32(properties, 0, 16);   // cbSize
                Marshal.WriteInt32(properties, 4, 0);    // bIsOffload
                Marshal.WriteInt32(properties, 8, 0);    // AudioCategory_Other
                Marshal.WriteInt32(properties, 12, unchecked((int)StreamOptionsLoopback));
                ThrowIfFailed(client.SetClientProperties(properties));
            }
            finally
            {
                Marshal.FreeHGlobal(properties);
            }
        }

        private static void InitializeFloatFormat(IWASAudioClient client)
        {
            IntPtr format = Marshal.AllocHGlobal(18);
            try
            {
                Marshal.WriteInt16(format, 0, 3);          // WAVE_FORMAT_IEEE_FLOAT
                Marshal.WriteInt16(format, 2, 2);          // channels
                Marshal.WriteInt32(format, 4, 48000);      // samples per second
                Marshal.WriteInt32(format, 8, 384000);     // average bytes per second
                Marshal.WriteInt16(format, 12, 8);         // block align
                Marshal.WriteInt16(format, 14, 32);        // bits per sample
                Marshal.WriteInt16(format, 16, 0);         // extension size
                ThrowIfFailed(client.Initialize(
                    0,                                     // shared mode
                    unchecked((int)StreamFlagsLoopbackEventCallback),
                    200000,                                // 20 ms buffer
                    0,
                    format,
                    IntPtr.Zero));
            }
            finally
            {
                Marshal.FreeHGlobal(format);
            }
        }

        private static void ThrowIfFailed(int hr)
        {
            if (hr < 0) throw new CaptureException(HrMessage(hr, "initializing the process loopback stream"));
        }

        internal static string HrMessage(int hr, string stage)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0} failed with HRESULT 0x{1:X8}.",
                stage,
                hr);
        }

        private static void ReleaseComObject(object value)
        {
            if (value != null && Marshal.IsComObject(value))
            {
                try { Marshal.ReleaseComObject(value); }
                catch { /* best effort */ }
            }
        }
    }

    internal sealed class CaptureException : Exception
    {
        public CaptureException(string message) : base(message) { }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    internal sealed class AgileActivationHandler : IActivateAudioInterfaceCompletionHandler, ICustomQueryInterface
    {
        private readonly ManualResetEvent completed = new ManualResetEvent(false);
        private IMarshal freeThreadedMarshaler;
        private IActivateAudioInterfaceAsyncOperation operation;

        public AgileActivationHandler()
        {
            IntPtr self = IntPtr.Zero;
            try
            {
                self = Marshal.GetIUnknownForObject(this);
                IntPtr marshalUnknown;
                if (NativeMethods.CoCreateFreeThreadedMarshaler(self, out marshalUnknown) >= 0 && marshalUnknown != IntPtr.Zero)
                {
                    freeThreadedMarshaler = (IMarshal)Marshal.GetObjectForIUnknown(marshalUnknown);
                    Marshal.Release(marshalUnknown);
                }
            }
            finally
            {
                if (self != IntPtr.Zero) Marshal.Release(self);
            }
        }

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            operation = activateOperation;
            completed.Set();
        }

        public CustomQueryInterfaceResult GetInterface(ref Guid iid, out IntPtr ppv)
        {
            ppv = IntPtr.Zero;
            IMarshal marshal = freeThreadedMarshaler;
            if (marshal != null && iid.Equals(typeof(IMarshal).GUID))
            {
                IntPtr unknown = Marshal.GetIUnknownForObject(marshal);
                try
                {
                    int hr = Marshal.QueryInterface(unknown, ref iid, out ppv);
                    return hr >= 0 && ppv != IntPtr.Zero
                        ? CustomQueryInterfaceResult.Handled
                        : CustomQueryInterfaceResult.Failed;
                }
                finally
                {
                    Marshal.Release(unknown);
                }
            }
            return CustomQueryInterfaceResult.NotHandled;
        }

        public bool Wait(int milliseconds)
        {
            return completed.WaitOne(milliseconds);
        }
    }

    internal static class NativeMethods
    {
        [DllImport("mmdevapi.dll")]
        internal static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfaceId,
            ref Guid riid,
            IntPtr activationParams,
            [MarshalAs(UnmanagedType.Interface)] IActivateAudioInterfaceCompletionHandler handler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("ole32.dll")]
        internal static extern int CoCreateFreeThreadedMarshaler(IntPtr punkOuter, out IntPtr ppunkMarshal);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr CreateEventW(IntPtr attributes, uint manualReset, uint initialState, string name);

        [DllImport("kernel32.dll")]
        internal static extern int WaitForSingleObject(IntPtr handle, int milliseconds);

        [DllImport("kernel32.dll")]
        internal static extern bool CloseHandle(IntPtr handle);
    }

    [ComImport, Guid("94EA2B94-E9CC-41E0-B50F-5D0CB047C9C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted([MarshalAs(UnmanagedType.Interface)] IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("72A22DF6-A11E-4964-833E-2E1DAB53E917"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IActivateAudioInterfaceAsyncOperation
    {
        void ActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("00000003-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMarshal
    {
    }

    /// <summary>
    /// IAudioClient followed by the three IAudioClient2 members, flattened into
    /// one declaration so the vtable order stays exact.
    /// </summary>
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWASAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        int GetBufferSize(out uint bufferFrames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint paddingFrames);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr deviceFormat);
        int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        int IsOffloadCapable(int category, [MarshalAs(UnmanagedType.Bool)] out bool offloadCapable);
        int SetClientProperties(IntPtr properties);
        int GetBufferSizeLimits(IntPtr format, [MarshalAs(UnmanagedType.Bool)] bool eventDriven, out long minBufferDuration, out long maxBufferDuration);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out int frames, out uint flags, out long devicePosition, out long qpcPosition);
        int ReleaseBuffer(int frames);
        int GetNextPacketSize(out int framesInNextPacket);
    }
}
