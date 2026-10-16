// Independent, non-activating desktop control status. C#5 / inbox WinForms.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace OwlComputerUse
{
    public static class NativeProtocol
    {
        private static readonly object OutputGate = new object();
        private static readonly Stream Output = Console.OpenStandardOutput();
        private static readonly Encoding Utf8 = new UTF8Encoding(false);

        public static void WriteJsonLine(string line)
        {
            byte[] bytes = Utf8.GetBytes(line + "\n");
            lock (OutputGate) { Output.Write(bytes, 0, bytes.Length); Output.Flush(); }
        }
    }

    public static class ControlOverlay
    {
        private const string OwnerProperty = "Owl.ComputerUse.Overlay.OwnerPid";
        private const string MarkerProperty = "Owl.ComputerUse.Overlay.Marker";
        private const int Marker = 0x4f574c43;
        private static readonly object RegistryGate = new object();
        private static readonly HashSet<long> Owned = new HashSet<long>();
        private static readonly object StartGate = new object();
        private static string InstanceId = Guid.NewGuid().ToString("N");
        private static readonly int ProcessId = Process.GetCurrentProcess().Id;
        private static readonly ManualResetEvent Ready = new ManualResetEvent(false);
        private static Thread thread;
        private static Exception startupError;
        private static Capsule capsule;
        private static Edge[] edges;
        private static ApplicationContext context;
        private static Mutex slotLease;
        private static int slot;
        private static bool active, published, stopping;
        private static int stopPending, captureSuspensions, uiFailure;
        private static long requestId, targetHwnd;
        private static string mode;
        private static Rectangle stopBounds;
        private static bool stopVisible;
        private static long stopCapsuleHwnd;
        [ThreadStatic] private static UiDispatch executingDispatch;

        public static bool OwnsWindow(long hwnd)
        {
            if (hwnd == 0) return false;
            IntPtr root = GetAncestor(new IntPtr(hwnd), 2);
            IntPtr window = root == IntPtr.Zero ? new IntPtr(hwnd) : root;
            lock (RegistryGate) if (!Owned.Contains(window.ToInt64())) return false;
            uint pid; GetWindowThreadProcessId(window, out pid);
            return pid == ProcessId;
        }

        // Other Owl workers register the same marker together with their actual PID.
        // Do not infer ownership from a user-controlled title or from a rectangle.
        public static bool RecognizesWindow(long hwnd)
        {
            if (OwnsWindow(hwnd)) return true;
            IntPtr window = new IntPtr(hwnd), root = GetAncestor(window, 2);
            if (root != IntPtr.Zero) window = root;
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            long styles = GetWindowLong(window, -20);
            return pid != 0 && GetProp(window, OwnerProperty).ToInt64() == pid
                && GetProp(window, MarkerProperty).ToInt64() == Marker
                && (styles & 0x08000080) == 0x08000080;
        }

        internal static void Register(IntPtr hwnd)
        {
            lock (RegistryGate) Owned.Add(hwnd.ToInt64());
            SetProp(hwnd, OwnerProperty, new IntPtr(ProcessId));
            SetProp(hwnd, MarkerProperty, new IntPtr(Marker));
            // Test inspectors need real HUD pixels; production capture omits the chrome.
            if (Environment.GetEnvironmentVariable("OWL_COMPUTER_USE_NATIVE_TEST") != "1")
            {
                try { SetWindowDisplayAffinity(hwnd, 0x11); } catch (EntryPointNotFoundException) { }
            }
        }

        internal static void Unregister(IntPtr hwnd)
        {
            RemoveProp(hwnd, MarkerProperty); RemoveProp(hwnd, OwnerProperty);
            lock (RegistryGate) Owned.Remove(hwnd.ToInt64());
        }

        public static long WindowAtPoint(int x, int y)
        {
            POINT point = new POINT(); point.X = x; point.Y = y;
            IntPtr hit = WindowFromPoint(point), root = GetAncestor(hit, 2);
            if (root != IntPtr.Zero) hit = root;
            if (!RecognizesWindow(hit.ToInt64()) || (GetWindowLong(hit, -20) & 0x20) == 0) return hit.ToInt64();
            long found = 0;
            EnumWindows(delegate(IntPtr window, IntPtr unused)
            {
                if (!IsWindowVisible(window) || IsIconic(window)) return true;
                if (RecognizesWindow(window.ToInt64()) && (GetWindowLong(window, -20) & 0x20) != 0) return true;
                int cloaked;
                if (DwmGetCloaked(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                RECT bounds;
                if (!GetWindowRect(window, out bounds) || x < bounds.Left || x >= bounds.Right || y < bounds.Top || y >= bounds.Bottom) return true;
                found = window.ToInt64(); return false;
            }, IntPtr.Zero);
            return found;
        }

        public static bool IsStopPoint(int x, int y)
        {
            long owner;
            lock (RegistryGate)
            {
                if (!stopVisible || !stopBounds.Contains(x, y)) return false;
                owner = stopCapsuleHwnd;
            }
            POINT point = new POINT(); point.X = x; point.Y = y;
            IntPtr hit = WindowFromPoint(point), root = GetAncestor(hit, 2);
            return owner != 0 && (root == IntPtr.Zero ? hit : root).ToInt64() == owner && OwnsWindow(owner);
        }

        // Low-level hooks must never synchronously ask a UI thread to hit-test.
        // This conservative top-level lookup also retains other workers' capsules.
        public static long WindowAtPointForHook(int x, int y)
        {
            long found = 0;
            EnumWindows(delegate(IntPtr window, IntPtr unused)
            {
                if (!IsWindowVisible(window) || IsIconic(window)) return true;
                if (RecognizesWindow(window.ToInt64()) && (GetWindowLong(window, -20) & 0x20) != 0) return true;
                int cloaked;
                if (DwmGetCloaked(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                RECT bounds;
                if (!GetWindowRect(window, out bounds) || x < bounds.Left || x >= bounds.Right || y < bounds.Top || y >= bounds.Bottom) return true;
                found = window.ToInt64(); return false;
            }, IntPtr.Zero);
            return found;
        }

        public static bool IsStopPointForHook(int x, int y, long topWindow)
        {
            lock (RegistryGate)
                return stopVisible && stopBounds.Contains(x, y) && topWindow != 0
                    && topWindow == stopCapsuleHwnd && Owned.Contains(topWindow);
        }

        public static void RequestUserStop()
        {
            // The latch precedes GUI work and stdout; long provider calls must stop too.
            DesktopGuard.RequestStop();
            Interlocked.Exchange(ref stopPending, 1);
            Capsule current = capsule;
            if (current == null || current.IsDisposed || !current.IsHandleCreated) return;
            if (Thread.CurrentThread == thread) PublishStop();
            else { try { current.BeginInvoke(new Action(PublishStop)); } catch (InvalidOperationException) { } }
        }

        private static void PublishStop()
        {
            if (!published || requestId <= 0 || stopping) return;
            stopping = true;
            active = false;
            try { NativeProtocol.WriteJsonLine("{\"event\":\"control_stop\",\"controlId\":\"" + InstanceId + "\",\"requestId\":" + Number(requestId) + "}"); }
            catch (IOException) { }
            capsule.Stopping = true;
            capsule.Text = "Owl 正在停止控制…"; capsule.AccessibleName = capsule.Text;
            capsule.Stop.Enabled = false;
            capsule.Stop.Text = "停止中";
            capsule.Refresh();
        }

        private static void HandleUiFailure(Exception error)
        {
            DesktopGuard.RequestStop();
            Interlocked.Exchange(ref stopPending, 1);
            active = false;
            if (Interlocked.Exchange(ref uiFailure, 1) != 0) return;
            try { Console.Error.WriteLine("Owl computer-control overlay failed:\n" + error); } catch (IOException) { }
            try
            {
                NativeProtocol.WriteJsonLine("{\"event\":\"control_error\",\"controlId\":\"" + InstanceId
                    + "\",\"requestId\":" + Number(requestId) + ",\"code\":\"overlay_ui_failed\"}");
                if (published && requestId > 0 && !stopping)
                    NativeProtocol.WriteJsonLine("{\"event\":\"control_stop\",\"controlId\":\"" + InstanceId + "\",\"requestId\":" + Number(requestId) + "}");
            }
            catch (IOException) { }
            stopping = true; published = false;
            lock (RegistryGate) stopVisible = false;
            // Do not repaint a failed control or allow WinForms' modal exception UI.
            try { if (capsule != null && !capsule.IsDisposed) capsule.Hide(); } catch (Exception) { }
            if (edges != null) foreach (Edge edge in edges) { try { if (!edge.IsDisposed) edge.Hide(); } catch (Exception) { } }
            try { if (context != null) context.ExitThread(); } catch (Exception) { }
        }

        public static bool Begin(string selectedMode, long hwnd, long currentRequestId)
        {
            EnsureThread();
            bool began = false;
            bool inspect = Environment.GetEnvironmentVariable("OWL_COMPUTER_USE_NATIVE_TEST") == "1";
            bool before = inspect && hwnd != 0 && DesktopGuard.Unobscured(hwnd);
            long hitBefore = 0;
            if (inspect && hwnd != 0)
            {
                long[] bounds = DesktopGuard.Geometry(hwnd, false);
                hitBefore = WindowAtPoint((int)(bounds[0] + bounds[2] / 2), (int)(bounds[1] + bounds[3] / 2));
            }
            RunOnUi(delegate()
            {
                if (DesktopGuard.StopRequested) throw new OperationCanceledException("control was stopped before the overlay was shown");
                if (active && published && requestId == currentRequestId) return;
                requestId = currentRequestId; targetHwnd = hwnd;
                mode = selectedMode == "background" ? "background" : "foreground";
                published = false; active = true; stopping = false;
                capsule.Stopping = false; capsule.Mode = mode;
                capsule.Text = "Owl 正在控制你的电脑";
                capsule.Stop.Enabled = false; capsule.Stop.Text = "停止";
                Layout();
                ThrowIfUiCancelled();
                if (captureSuspensions == 0) ShowForms();
                string probes = "";
                if (inspect)
                {
                    bool after = hwnd != 0 && DesktopGuard.Unobscured(hwnd);
                    long hitAfter = 0;
                    if (hwnd != 0)
                    {
                        long[] bounds = DesktopGuard.Geometry(hwnd, false);
                        hitAfter = WindowAtPoint((int)(bounds[0] + bounds[2] / 2), (int)(bounds[1] + bounds[3] / 2));
                    }
                    probes = ",\"targetUnobscuredBefore\":" + Boolean(before) + ",\"targetUnobscuredAfter\":" + Boolean(after)
                        + ",\"targetHitBefore\":" + Number(hitBefore) + ",\"targetHitAfter\":" + Number(hitAfter);
                }
                Rectangle location = capsule.Bounds;
                ThrowIfUiCancelled();
                NativeProtocol.WriteJsonLine("{\"event\":\"control_started\",\"controlId\":\"" + InstanceId
                    + "\",\"requestId\":" + Number(requestId) + ",\"mode\":\"" + mode + "\",\"capsuleHwnd\":" + Number(capsule.Handle.ToInt64())
                    + ",\"stopHwnd\":" + Number(capsule.Stop.Handle.ToInt64()) + ",\"bounds\":{\"x\":" + Number(location.X)
                    + ",\"y\":" + Number(location.Y) + ",\"width\":" + Number(location.Width) + ",\"height\":" + Number(location.Height) + "}" + probes + "}");
                published = true;
                if (Interlocked.CompareExchange(ref stopPending, 0, 0) != 0) PublishStop();
                else capsule.Stop.Enabled = true;
                began = true;
            });
            return began;
        }

        public static void End()
        {
            if (capsule == null) return;
            RunOnUi(delegate()
            {
                active = false;
                // A stop request is shown as stopping until the supervisor really exits.
                if (!stopping && Interlocked.CompareExchange(ref stopPending, 0, 0) == 0) HideForms();
            });
        }

        public static void AvoidPoint(int x, int y)
        {
            if (capsule == null) return;
            RunOnUi(delegate()
            {
                if (!capsule.Visible || !capsule.Bounds.Contains(x, y)) return;
                Rectangle area = Screen.FromPoint(new Point(x, y)).WorkingArea;
                Point[] alternatives = new Point[] {
                    new Point(area.Left + 12, area.Bottom - capsule.Height - 12),
                    new Point(area.Right - capsule.Width - 12, area.Bottom - capsule.Height - 12),
                    new Point(area.Left + 12, area.Top + 12),
                    new Point(area.Right - capsule.Width - 12, area.Top + 12)
                };
                foreach (Point point in alternatives)
                {
                    if (!new Rectangle(point, capsule.Size).Contains(x, y)) { capsule.Location = point; UpdateStopBounds(); return; }
                }
                throw new InvalidOperationException("status capsule cannot avoid this desktop point");
            });
        }

        // GDI fallback must see the underlying pixels, not a black excluded rectangle.
        public static bool SuspendForCapture()
        {
            if (capsule == null) return false;
            RunOnUi(delegate() { captureSuspensions++; HideForms(); });
            return true;
        }

        public static void ResumeAfterCapture(bool suspended)
        {
            if (!suspended || capsule == null) return;
            RunOnUi(delegate() { captureSuspensions = Math.Max(0, captureSuspensions - 1); if (captureSuspensions == 0 && (active || stopping)) ShowForms(); });
        }

        public static void Shutdown()
        {
            Capsule current = capsule;
            if (current == null) return;
            try { RunOnUi(delegate() { active = false; published = false; HideForms(); context.ExitThread(); }); } catch (InvalidOperationException) { }
            Thread currentThread = thread;
            if (currentThread != null && currentThread != Thread.CurrentThread) currentThread.Join(500);
            lock (StartGate)
            {
                if (currentThread != null && !currentThread.IsAlive)
                {
                    thread = null; capsule = null; edges = null; context = null;
                    startupError = null; active = false; published = false; stopping = false;
                    requestId = 0; captureSuspensions = 0; stopPending = 0; uiFailure = 0; Ready.Reset();
                    InstanceId = Guid.NewGuid().ToString("N");
                }
            }
        }

        private static void EnsureThread()
        {
            lock (StartGate)
            {
                if (thread == null)
                {
                    thread = new Thread(delegate()
                    {
                        ThreadExceptionEventHandler onUiException = delegate(object sender, ThreadExceptionEventArgs args) { HandleUiFailure(args.Exception); };
                        try
                        {
                            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException, true);
                            Application.ThreadException += onUiException;
                            context = new ApplicationContext();
                            capsule = new Capsule();
                            edges = new Edge[] { new Edge(), new Edge(), new Edge(), new Edge() };
                            IntPtr handle = capsule.Handle;
                            foreach (Edge edge in edges) { IntPtr unused = edge.Handle; }
                            for (slot = 0; slot < 8; slot++)
                            {
                                Mutex candidate = new Mutex(false, "Local\\OwlCU-OverlaySlot-" + Process.GetCurrentProcess().SessionId + "-" + slot);
                                bool acquired;
                                try { acquired = candidate.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                                if (acquired) { slotLease = candidate; break; }
                                candidate.Dispose();
                            }
                            if (slotLease == null) slot = ProcessId % 8;
                            Ready.Set();
                            Application.Run(context);
                        }
                        catch (Exception error) { startupError = error; Ready.Set(); HandleUiFailure(error); }
                        finally
                        {
                            if (edges != null) foreach (Edge edge in edges) edge.Dispose();
                            if (capsule != null) capsule.Dispose();
                            if (slotLease != null) { slotLease.ReleaseMutex(); slotLease.Dispose(); slotLease = null; }
                            Application.ThreadException -= onUiException;
                        }
                    });
                    thread.IsBackground = true;
                    thread.SetApartmentState(ApartmentState.STA);
                    thread.Start();
                }
            }
            if (!Ready.WaitOne(2500)) throw new InvalidOperationException("control overlay did not initialize");
            if (startupError != null) throw new InvalidOperationException("control overlay unavailable", startupError);
        }

        private static void RunOnUi(Action action)
        {
            Capsule current = capsule;
            if (current == null || current.IsDisposed) throw new InvalidOperationException("control overlay has closed");
            if (Thread.CurrentThread == thread) { ThrowIfUiCancelled(); action(); ThrowIfUiCancelled(); return; }
            UiDispatch work = new UiDispatch();
            current.BeginInvoke(new Action(delegate()
            {
                UiDispatch previous = executingDispatch;
                executingDispatch = work;
                try { ThrowIfUiCancelled(); action(); ThrowIfUiCancelled(); }
                catch (Exception error)
                {
                    work.Error = error;
                    if (!(error is TimeoutException) && !(error is OperationCanceledException)) HandleUiFailure(error);
                }
                finally
                {
                    try
                    {
                        if (Interlocked.CompareExchange(ref work.Cancelled, 0, 0) != 0)
                        { active = false; published = false; HideForms(); }
                    }
                    catch (Exception error) { if (work.Error == null) work.Error = error; }
                    finally
                    {
                        executingDispatch = previous;
                        lock (work.Gate) { work.Completed = true; Monitor.PulseAll(work.Gate); }
                    }
                }
            }));
            lock (work.Gate)
            {
                while (!work.Completed)
                {
                    int remaining = 2500 - (int)work.Clock.ElapsedMilliseconds;
                    if (remaining <= 0)
                    {
                        Interlocked.Exchange(ref work.Cancelled, 1);
                        throw new TimeoutException("control overlay UI did not respond within 2500 ms");
                    }
                    Monitor.Wait(work.Gate, remaining);
                }
            }
            if (work.Error != null) throw new InvalidOperationException("control overlay UI failed", work.Error);
        }

        private sealed class UiDispatch
        {
            internal readonly object Gate = new object();
            internal readonly Stopwatch Clock = Stopwatch.StartNew();
            internal int Cancelled;
            internal bool Completed;
            internal Exception Error;
        }

        private static void ThrowIfUiCancelled()
        {
            if (Interlocked.CompareExchange(ref uiFailure, 0, 0) != 0)
                throw new InvalidOperationException("control overlay UI has failed and control was stopped");
            UiDispatch work = executingDispatch;
            if (work == null) return;
            if (work.Clock.ElapsedMilliseconds >= 2500) Interlocked.Exchange(ref work.Cancelled, 1);
            if (Interlocked.CompareExchange(ref work.Cancelled, 0, 0) != 0)
                throw new TimeoutException("control overlay UI request expired");
        }

        private static void Layout()
        {
            Screen monitor = targetHwnd == 0 ? Screen.PrimaryScreen : Screen.FromHandle(new IntPtr(targetHwnd));
            Rectangle area = monitor.WorkingArea, border = monitor.Bounds;
            if (targetHwnd != 0 && DesktopGuard.Visible(targetHwnd))
            {
                long[] bounds = DesktopGuard.Geometry(targetHwnd, false);
                Rectangle candidate = new Rectangle((int)bounds[0], (int)bounds[1], (int)bounds[2], (int)bounds[3]);
                if (candidate.Width > 0 && candidate.Height > 0) border = candidate;
            }
            int dpi = 96;
            try { if (targetHwnd != 0) dpi = (int)GetDpiForWindow(new IntPtr(targetHwnd)); } catch (EntryPointNotFoundException) { }
            capsule.UiScale = Math.Max(1f, dpi / 96f);
            capsule.Size = new Size(Math.Min(area.Width - 24, (int)(368 * capsule.UiScale)), (int)(64 * capsule.UiScale));
            int y = area.Top + 12 + slot * (capsule.Height + 8);
            if (y + capsule.Height > area.Bottom) y = Math.Max(area.Top, area.Bottom - capsule.Height - 12);
            capsule.Location = new Point(area.Left + (area.Width - capsule.Width) / 2, y);
            capsule.LayoutStop();
            int thickness = Math.Max(2, (int)(2 * capsule.UiScale));
            edges[0].Bounds = new Rectangle(border.Left, border.Top, border.Width, thickness);
            edges[1].Bounds = new Rectangle(border.Left, border.Bottom - thickness, border.Width, thickness);
            edges[2].Bounds = new Rectangle(border.Left, border.Top + thickness, thickness, Math.Max(1, border.Height - thickness * 2));
            edges[3].Bounds = new Rectangle(border.Right - thickness, border.Top + thickness, thickness, Math.Max(1, border.Height - thickness * 2));
            UpdateStopBounds();
        }

        private static void ShowForms()
        {
            foreach (Edge edge in edges)
            {
                ThrowIfUiCancelled(); edge.Show(); ThrowIfUiCancelled();
                if (!SetWindowPos(edge.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x53))
                    throw new InvalidOperationException("control overlay edge could not be shown above other windows");
                edge.Refresh();
            }
            ThrowIfUiCancelled(); capsule.Show(); ThrowIfUiCancelled();
            if (!SetWindowPos(capsule.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x53))
                throw new InvalidOperationException("control overlay capsule could not be shown above other windows");
            capsule.Refresh(); UpdateStopBounds();
            ThrowIfUiCancelled();
        }
        private static void HideForms()
        {
            capsule.Hide(); foreach (Edge edge in edges) edge.Hide();
            lock (RegistryGate) stopVisible = false;
        }
        private static void UpdateStopBounds()
        {
            Rectangle bounds = capsule.RectangleToScreen(capsule.Stop.Bounds);
            long hwnd = capsule.Handle.ToInt64();
            bool visible = capsule.Visible;
            lock (RegistryGate)
            {
                stopBounds = bounds; stopCapsuleHwnd = hwnd; stopVisible = visible;
            }
        }
        private static string Number(long value) { return value.ToString(CultureInfo.InvariantCulture); }
        private static string Boolean(bool value) { return value ? "true" : "false"; }

        private class StatusForm : Form
        {
            private IntPtr registeredHandle;
            internal StatusForm()
            {
                // WinForms focuses managed TopMost forms in SetVisibleCore even with
                // ShowWithoutActivation. ShowForms maintains z-order without activation.
                Text = ""; FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual; AutoScaleMode = AutoScaleMode.None;
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            }
            protected override bool ShowWithoutActivation { get { return true; } }
            protected override CreateParams CreateParams
            {
                get { CreateParams value = base.CreateParams; value.ExStyle |= 0x08000000 | 0x00000080; return value; }
            }
            protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); registeredHandle = Handle; Register(registeredHandle); }
            protected override void OnHandleDestroyed(EventArgs e) { Unregister(registeredHandle); registeredHandle = IntPtr.Zero; base.OnHandleDestroyed(e); }
            protected override void WndProc(ref Message message)
            {
                if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE, preserve the click.
                base.WndProc(ref message);
            }
        }
        private sealed class Edge : StatusForm
        {
            internal Edge() { BackColor = Color.FromArgb(44, 190, 220); Opacity = 0.82; }
            protected override CreateParams CreateParams
            {
                get { CreateParams value = base.CreateParams; value.ExStyle |= 0x20; return value; }
            }
            protected override void WndProc(ref Message message)
            {
                if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; }
                base.WndProc(ref message);
            }
        }
        private sealed class Capsule : StatusForm
        {
            internal readonly Button Stop;
            internal string Mode;
            internal bool Stopping;
            internal float UiScale = 1;
            private Font stopFont;
            private readonly List<Font> ownedFonts = new List<Font>();
            internal Capsule()
            {
                BackColor = Color.FromArgb(17, 26, 35);
                Text = "Owl 正在控制你的电脑"; AccessibleName = Text;
                Stop = new Button { Text = "停止", TabStop = false, FlatStyle = FlatStyle.Flat,
                    BackColor = Color.FromArgb(32, 75, 88), ForeColor = Color.FromArgb(219, 246, 251), UseVisualStyleBackColor = false };
                Stop.FlatAppearance.BorderSize = 0; Stop.AccessibleName = "停止 Owl 控制";
                Stop.MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) RequestUserStop(); };
                Stop.Click += delegate { RequestUserStop(); };
                Controls.Add(Stop);
            }
            internal void LayoutStop()
            {
                if (stopFont == null || Math.Abs(stopFont.Size - 12 * UiScale) > 0.01f)
                {
                    stopFont = new Font("Microsoft YaHei UI", 12 * UiScale, FontStyle.Regular, GraphicsUnit.Pixel);
                    ownedFonts.Add(stopFont);
                    Stop.Font = stopFont;
                }
                Stop.Bounds = new Rectangle(Width - (int)(82 * UiScale), (int)(15 * UiScale), (int)(68 * UiScale), (int)(34 * UiScale));
            }
            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (Pen pen = new Pen(Color.FromArgb(55, 128, 148), Math.Max(1, UiScale))) e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
                using (Brush dot = new SolidBrush(Color.FromArgb(94, 220, 238))) e.Graphics.FillEllipse(dot, 14 * UiScale, 22 * UiScale, 8 * UiScale, 8 * UiScale);
                using (Font title = new Font("Microsoft YaHei UI", 14 * UiScale, FontStyle.Regular, GraphicsUnit.Pixel))
                    TextRenderer.DrawText(e.Graphics, Stopping ? "Owl 正在停止控制…" : "Owl 正在控制你的电脑", title,
                        new Rectangle((int)(31 * UiScale), (int)(10 * UiScale), Width - (int)(120 * UiScale), (int)(24 * UiScale)), Color.FromArgb(234, 246, 249), TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
                using (Font subtitle = new Font("Microsoft YaHei UI", 11 * UiScale, FontStyle.Regular, GraphicsUnit.Pixel))
                    TextRenderer.DrawText(e.Graphics, Stopping ? "正在撤销控制，请稍候" : Mode == "background" ? "后台操作 · 窗口控件" : "前台控制 · 键盘与鼠标", subtitle,
                        new Rectangle((int)(31 * UiScale), (int)(35 * UiScale), Width - (int)(120 * UiScale), (int)(18 * UiScale)), Color.FromArgb(133, 177, 190), TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            }
            protected override void Dispose(bool disposing)
            {
                base.Dispose(disposing);
                if (disposing)
                {
                    foreach (Font font in ownedFonts) font.Dispose();
                    ownedFonts.Clear(); stopFont = null;
                }
            }
        }

        private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetProp(IntPtr hwnd, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr RemoveProp(IntPtr hwnd, string name);
        [DllImport("user32.dll")] private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc proc, IntPtr data);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetCloaked(IntPtr hwnd, int attribute, out int value, int size);
    }
}
