// owl computer-use 内核：GDI 截屏（BitBlt）+ user32 输入注入（SendInput）。
//
// 编译：由 computer-driver.ps1 用进程外 csc（net48 in-box，C#5）编成 DLL 后
// 字节加载，%TEMP% 按内容哈希缓存 —— 与 mirror/windows-capture.cs 同一套路。
// 本内核只用 GDI/user32，不碰 WinRT，因此无需 winmd 引用；保持 C#5 语法
// （无字符串内插 / 无 null 条件 / 无表达式体成员）。
//
// 坐标约定：全部屏幕坐标为「虚拟屏幕坐标」（主显器左上角为 (0,0)，副显器
// 可为负）；鼠标绝对移动按虚拟屏归一化到 0..65535（MOUSEEVENTF_VIRTUALDESK）。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Diagnostics;

namespace OwlComputerUse
{
    public sealed class CaptureResult
    {
        public byte[] Jpeg;
        public int ImageWidth;
        public int ImageHeight;
        public int ScreenWidth;
        public int ScreenHeight;
        public int OriginX;
        public int OriginY;
    }

    public sealed class TypingResult
    {
        public int TypedCharacters;
        public bool Complete;
        public string Failure;
    }

    public static class Kernel
    {
        private const int SM_XVIRTUALSCREEN = 76;
        private const int SM_YVIRTUALSCREEN = 77;
        private const int SM_CXVIRTUALSCREEN = 78;
        private const int SM_CYVIRTUALSCREEN = 79;

        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_HWHEEL = 0x1000;
        private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;

        private const uint SRCCOPY = 0x00CC0020;
        private const uint CAPTUREBLT = 0x40000000;

        private static readonly object Gate = new object();
        // Per-process marker: foreign automation is interference just like human input.
        // A full-PID bijection in 32 bits survives WOW64 input translation as well.
        private static readonly IntPtr InputTag = new IntPtr(Process.GetCurrentProcess().Id ^ 0x4f570000);
        private static readonly HashSet<int> HeldKeys = new HashSet<int>();

        /// <summary>启用物理像素 DPI 感知，保证截屏/坐标在缩放显示下不失真。幂等。</summary>
        public static void Initialize()
        {
            try
            {
                // Win10 1803+ per-monitor v2；失败回退 SetProcessDPIAware。
                if (!SetProcessDpiAwarenessContext(new IntPtr(-4)))
                {
                    SetProcessDPIAware();
                }
            }
            catch
            {
                try { SetProcessDPIAware(); } catch { }
            }
        }

        // ------------------------------------------------------------------
        // 截屏：monitorIndex -1 = 主显示器，-2 = 虚拟屏（全部显示器），>=0 =
        // EnumDisplayMonitors 枚举序号的物理显示器。输出 JPEG（≤maxWidth 宽）。
        // ------------------------------------------------------------------
        public static CaptureResult Capture(int monitorIndex, int maxWidth, int quality)
        {
            if (maxWidth < 256) maxWidth = 256;
            if (quality < 30) quality = 30;
            if (quality > 95) quality = 95;

            int originX, originY, width, height;
            GetTargetRect(monitorIndex, out originX, out originY, out width, out height);
            return CaptureRect(originX, originY, width, height, maxWidth, quality);
        }

        public static CaptureResult CaptureRect(int originX, int originY, int width, int height, int maxWidth, int quality)
        {
            maxWidth = Math.Max(256, Math.Min(4096, maxWidth));
            quality = Math.Max(30, Math.Min(95, quality));
            if (width <= 0 || height <= 0) throw new Exception("capture target has empty size");
            if ((long)width * height > 64000000) throw new Exception("capture target is too large");

            CaptureResult result = new CaptureResult();
            result.OriginX = originX;
            result.OriginY = originY;
            result.ScreenWidth = width;
            result.ScreenHeight = height;

            lock (Gate)
            {
                IntPtr hdcScreen = GetDC(IntPtr.Zero);
                if (hdcScreen == IntPtr.Zero) throw new Exception("GetDC failed");
                IntPtr hBitmap = IntPtr.Zero;
                IntPtr hdcMem = IntPtr.Zero;
                try
                {
                    hdcMem = CreateCompatibleDC(hdcScreen);
                    if (hdcMem == IntPtr.Zero) throw new Exception("CreateCompatibleDC failed");
                    hBitmap = CreateCompatibleBitmap(hdcScreen, width, height);
                    if (hBitmap == IntPtr.Zero) throw new Exception("CreateCompatibleBitmap failed");
                    IntPtr prev = SelectObject(hdcMem, hBitmap);
                    try
                    {
                        if (!BitBlt(hdcMem, 0, 0, width, height, hdcScreen, originX, originY, SRCCOPY | CAPTUREBLT))
                            throw new Exception("BitBlt failed");
                        using (Bitmap raw = Image.FromHbitmap(hBitmap))
                        {
                            Bitmap target = raw;
                            if (raw.Width > maxWidth)
                            {
                                int scaledHeight = (int)Math.Round((double)raw.Height * maxWidth / raw.Width);
                                if (scaledHeight < 1) scaledHeight = 1;
                                target = new Bitmap(maxWidth, scaledHeight);
                                using (Graphics g = Graphics.FromImage(target))
                                {
                                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                    g.DrawImage(raw, 0, 0, maxWidth, scaledHeight);
                                }
                            }
                            try
                            {
                                result.ImageWidth = target.Width;
                                result.ImageHeight = target.Height;
                                result.Jpeg = EncodeJpeg(target, quality);
                            }
                            finally
                            {
                                if (!ReferenceEquals(target, raw)) target.Dispose();
                            }
                        }
                    }
                    finally
                    {
                        SelectObject(hdcMem, prev);
                    }
                }
                finally
                {
                    if (hBitmap != IntPtr.Zero) DeleteObject(hBitmap);
                    if (hdcMem != IntPtr.Zero) DeleteDC(hdcMem);
                    ReleaseDC(IntPtr.Zero, hdcScreen);
                }
            }
            return result;
        }

        private static byte[] EncodeJpeg(Bitmap bitmap, int quality)
        {
            ImageCodecInfo jpegCodec = null;
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            for (int i = 0; i < codecs.Length; i++)
            {
                if (codecs[i].MimeType == "image/jpeg") { jpegCodec = codecs[i]; break; }
            }
            if (jpegCodec == null) throw new Exception("jpeg encoder not found");
            EncoderParameters parameters = new EncoderParameters(1);
            EncoderParameter parameter = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            parameters.Param[0] = parameter;
            try
            {
                using (MemoryStream stream = new MemoryStream())
                {
                    bitmap.Save(stream, jpegCodec, parameters);
                    return stream.ToArray();
                }
            }
            finally
            {
                parameter.Dispose();
                parameters.Dispose();
            }
        }

        public static CaptureResult ResizeJpeg(byte[] bytes, int maxWidth, int quality)
        {
            using (MemoryStream stream = new MemoryStream(bytes))
            using (Bitmap source = new Bitmap(stream))
            {
                CaptureResult result = new CaptureResult();
                int width = Math.Min(source.Width, Math.Max(256, Math.Min(4096, maxWidth)));
                int height = Math.Max(1, (int)Math.Round((double)source.Height * width / source.Width));
                using (Bitmap target = new Bitmap(width, height))
                {
                    using (Graphics graphics = Graphics.FromImage(target))
                    { graphics.InterpolationMode = InterpolationMode.HighQualityBicubic; graphics.DrawImage(source, 0, 0, width, height); }
                    result.ImageWidth = width; result.ImageHeight = height;
                    result.Jpeg = EncodeJpeg(target, Math.Max(30, Math.Min(95, quality)));
                }
                return result;
            }
        }

        private static void GetTargetRect(int monitorIndex, out int originX, out int originY, out int width, out int height)
        {
            if (monitorIndex == -2)
            {
                originX = GetSystemMetrics(SM_XVIRTUALSCREEN);
                originY = GetSystemMetrics(SM_YVIRTUALSCREEN);
                width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
                height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
                return;
            }
            if (monitorIndex == -1)
            {
                originX = 0;
                originY = 0;
                width = GetSystemMetrics(0);  // SM_CXSCREEN
                height = GetSystemMetrics(1); // SM_CYSCREEN
                return;
            }
            List<Rect> monitors = new List<Rect>();
            MonitorEnumProc proc = delegate(IntPtr hMonitor, IntPtr hdcMonitor, ref Rect rect, IntPtr data)
            {
                MonitorInfo info = new MonitorInfo();
                info.cbSize = Marshal.SizeOf(typeof(MonitorInfo));
                if (GetMonitorInfo(hMonitor, ref info)) monitors.Add(info.rcMonitor);
                return true;
            };
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
            if (monitorIndex >= monitors.Count) throw new Exception("monitor index out of range (" + monitors.Count + " monitors)");
            Rect target = monitors[monitorIndex];
            originX = target.left;
            originY = target.top;
            width = target.right - target.left;
            height = target.bottom - target.top;
        }

        // ------------------------------------------------------------------
        // 鼠标：屏幕坐标 → 虚拟屏归一化 → SendInput
        // ------------------------------------------------------------------
        public static void MoveMouse(int x, int y)
        {
            int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int cx = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int cy = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            int[] normalized = NormalizeCoordinates(x, y, vx, vy, cx, cy);

            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 0; // INPUT_MOUSE
            inputs[0].u.mi.dx = normalized[0];
            inputs[0].u.mi.dy = normalized[1];
            inputs[0].u.mi.mouseData = 0;
            inputs[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            DispatchMouse(inputs);
        }

        public static int[] NormalizeCoordinates(int x, int y, int vx, int vy, int cx, int cy)
        {
            if (cx <= 0 || cy <= 0) throw new Exception("invalid virtual screen metrics");
            long rx = (long)x - vx, ry = (long)y - vy;
            if (rx < 0 || ry < 0 || rx >= cx || ry >= cy)
                throw new ArgumentOutOfRangeException("coordinates", "point is outside the virtual desktop");
            return new int[] { (int)(rx * 65536 / cx), (int)(ry * 65536 / cy) };
        }

        public static void ClickMouse(string button, bool doubleClick)
        {
            uint down, up;
            if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
            else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
            else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }

            int rounds = doubleClick ? 2 : 1;
            for (int i = 0; i < rounds; i++)
            {
                INPUT[] inputs = new INPUT[2];
                inputs[0].type = 0;
                inputs[0].u.mi.dwFlags = down;
                inputs[1].type = 0;
                inputs[1].u.mi.dwFlags = up;
                DispatchMouse(inputs);
                if (rounds > 1 && i == 0) Thread.Sleep(40);
            }
        }

        public static bool ClickMouseGuarded(string button, bool doubleClick, long hwnd, long revision)
        {
            int rounds = doubleClick ? 2 : 1;
            for (int i = 0; i < rounds; i++)
            {
                if (DesktopGuard.StopRequested || DesktopGuard.UserRevision != revision || DesktopGuard.WindowAtCursor() != hwnd) return false;
                ClickMouse(button, false);
                if (i + 1 < rounds) Thread.Sleep(40);
            }
            return true;
        }

        public static void ScrollWheel(int delta, bool horizontal)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 0;
            inputs[0].u.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
            inputs[0].u.mi.mouseData = unchecked((uint)delta);
            DispatchMouse(inputs);
        }

        private static void DispatchMouse(INPUT[] inputs)
        {
            for (int i = 0; i < inputs.Length; i++) inputs[i].u.mi.dwExtraInfo = InputTag;
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length)
            {
                List<INPUT> release = new List<INPUT>();
                for (int i = 0; i < sent; i++)
                {
                    uint flags = inputs[i].u.mi.dwFlags, up = 0;
                    if ((flags & MOUSEEVENTF_LEFTDOWN) != 0) up = MOUSEEVENTF_LEFTUP;
                    else if ((flags & MOUSEEVENTF_RIGHTDOWN) != 0) up = MOUSEEVENTF_RIGHTUP;
                    else if ((flags & MOUSEEVENTF_MIDDLEDOWN) != 0) up = MOUSEEVENTF_MIDDLEUP;
                    if (up == 0) continue;
                    INPUT input = new INPUT(); input.type = 0; input.u.mi.dwFlags = up; input.u.mi.dwExtraInfo = InputTag;
                    release.Add(input);
                }
                if (release.Count > 0) SendInput((uint)release.Count, release.ToArray(), Marshal.SizeOf(typeof(INPUT)));
                throw new Exception("SendInput(mouse) blocked or partially accepted");
            }
        }

        // ------------------------------------------------------------------
        // 键盘
        // ------------------------------------------------------------------
        public static void TypeText(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            // 换行/制表走实体键（KEYEVENTF_UNICODE 的 \n 在多数应用里不产生回车）。
            foreach (char ch in text)
            {
                if (ch == '\n') { TapKey(0x0D, 0x1C); continue; }
                if (ch == '\r') continue;
                if (ch == '\t') { TapKey(0x09, 0x0F); continue; }
                INPUT[] inputs = new INPUT[2];
                inputs[0].type = 1; // INPUT_KEYBOARD
                inputs[0].u.ki.wVk = 0;
                inputs[0].u.ki.wScan = ch;
                inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
                inputs[1].type = 1;
                inputs[1].u.ki.wVk = 0;
                inputs[1].u.ki.wScan = ch;
                inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                DispatchKeyboard(inputs);
            }
        }

        /// <summary>按住 downVks（顺序按下）→ 敲 tapVks → 逆序松开 downVks。</summary>
        public static void KeyCombo(int[] downVks, int[] tapVks)
        {
            try
            {
                DispatchKeyboard(ComboInputs(downVks, tapVks));
            }
            finally { ReleaseHeldKeys(); }
        }

        private static INPUT[] ComboInputs(int[] downVks, int[] tapVks)
        {
            List<INPUT> inputs = new List<INPUT>();
            foreach (int key in downVks) inputs.Add(KeyInput(key, false));
            foreach (int key in tapVks) { inputs.Add(KeyInput(key, false)); inputs.Add(KeyInput(key, true)); }
            for (int i = downVks.Length - 1; i >= 0; i--) inputs.Add(KeyInput(downVks[i], true));
            return inputs.ToArray();
        }

        private static INPUT KeyInput(int key, bool up)
        {
            if (key < 1 || key > 255) throw new ArgumentOutOfRangeException("key");
            INPUT input = new INPUT(); input.type = 1; input.u.ki.wVk = (ushort)key;
            input.u.ki.wScan = (ushort)ScanOf(key); input.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : (uint)0;
            return input;
        }

        public static void ReleaseHeldKeys()
        {
            foreach (int key in new List<int>(HeldKeys))
            {
                try { SendKeyState(key, ScanOf(key), true); } catch { }
                HeldKeys.Remove(key);
            }
        }

        public static bool InputStillSafe(long hwnd, long revision)
        {
            return !DesktopGuard.StopRequested && DesktopGuard.UserRevision == revision && DesktopGuard.ForegroundHwnd() == hwnd;
        }

        public static TypingResult TypeTextGuarded(string text, long hwnd, long revision)
        {
            TypingResult result = new TypingResult();
            if (text == null) text = "";
            // A bounded chunk keeps cancellation/user takeover responsive even for long text.
            foreach (char ch in text)
            {
                if (!InputStillSafe(hwnd, revision)) break;
                try { TypeText(ch.ToString()); result.TypedCharacters++; }
                catch (Exception error) { result.Failure = error.Message; break; }
            }
            result.Complete = result.TypedCharacters == text.Length;
            return result;
        }

        public static bool KeyComboGuarded(int[] downVks, int[] tapVks, long hwnd, long revision)
        {
            if (!InputStillSafe(hwnd, revision)) return false;
            // One OS submission contains every down/tap/up. Worker cancellation between
            // submissions cannot leave a shortcut modifier held in another application.
            KeyCombo(downVks, tapVks);
            return true;
        }

        private static void TapKey(int vk, int scan)
        {
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = 1;
            inputs[0].u.ki.wVk = (ushort)vk;
            inputs[0].u.ki.wScan = (ushort)scan;
            inputs[0].u.ki.dwFlags = 0;
            inputs[1].type = 1;
            inputs[1].u.ki.wVk = (ushort)vk;
            inputs[1].u.ki.wScan = (ushort)scan;
            inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
            DispatchKeyboard(inputs);
        }

        private static void SendKeyState(int vk, int scan, bool up)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 1;
            inputs[0].u.ki.wVk = (ushort)vk;
            inputs[0].u.ki.wScan = (ushort)scan;
            inputs[0].u.ki.dwFlags = up ? KEYEVENTF_KEYUP : (uint)0;
            DispatchKeyboard(inputs);
        }

        private static int ScanOf(int vk)
        {
            return MapVirtualKey(vk, 0); // MAPVK_VK_TO_VSC
        }

        private static void DispatchKeyboard(INPUT[] inputs)
        {
            for (int i = 0; i < inputs.Length; i++) inputs[i].u.ki.dwExtraInfo = InputTag;
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            // Track only keys the OS accepted, never a caller's requested-but-blocked key.
            for (int i = 0; i < sent; i++)
            {
                if (inputs[i].u.ki.wVk == 0) continue;
                if ((inputs[i].u.ki.dwFlags & KEYEVENTF_KEYUP) == 0) HeldKeys.Add(inputs[i].u.ki.wVk);
                else HeldKeys.Remove(inputs[i].u.ki.wVk);
            }
            if (sent != inputs.Length)
            {
                List<INPUT> release = new List<INPUT>();
                for (int i = 0; i < sent; i++)
                {
                    if ((inputs[i].u.ki.dwFlags & KEYEVENTF_KEYUP) != 0) continue;
                    INPUT up = inputs[i]; up.u.ki.dwFlags |= KEYEVENTF_KEYUP; release.Add(up);
                }
                if (release.Count > 0) SendInput((uint)release.Count, release.ToArray(), Marshal.SizeOf(typeof(INPUT)));
                throw new Exception("SendInput(keyboard) blocked or partially accepted");
            }
        }

        public static IntPtr OwnInputTag { get { return InputTag; } }

        public static int[] CursorPosition()
        {
            POINT point = new POINT();
            if (!GetCursorPos(ref point)) throw new Exception("GetCursorPos failed");
            return new int[] { point.x, point.y };
        }

        // ------------------------------------------------------------------
        // interop
        // ------------------------------------------------------------------
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(ref POINT point);
        [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] private static extern int MapVirtualKey(int code, int mapType);
        [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
        [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
        [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
        [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

        private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect { public int left; public int top; public int right; public int bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MonitorInfo
        {
            public int cbSize;
            public Rect rcMonitor;
            public Rect rcWork;
            public uint dwFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }
    }

    public sealed class ChildResult
    {
        public bool TimedOut;
        public int ExitCode;
        public string Output;
        public string Error;
    }

    // The hook has its own message pump. The PowerShell request loop can block on stdin
    // without suppressing takeover detection. Native mutex ownership is the request thread.
    public static class DesktopGuard
    {
        private static long revision;
        private static int lastExternalTick = Environment.TickCount;
        private static int stopRequested;
        private static Thread hookThread;
        private static uint hookThreadId;
        private static IntPtr mouseHook, keyboardHook;
        private static HookProc mouseProc, keyboardProc;
        private static readonly ManualResetEvent HookReady = new ManualResetEvent(false);
        private static Mutex lease;
        private static bool ownsLease;
        private static readonly object WindowGate = new object();
        private static readonly Dictionary<long, long> WindowInputs = new Dictionary<long, long>();
        private static readonly Dictionary<long, Mutex> WindowLeases = new Dictionary<long, Mutex>();
        private static readonly HashSet<long> OwnedWindows = new HashSet<long>();
        private static long gestureWindow, gestureOwner;
        private static int gestureButtons;
        public static bool Monitoring { get; private set; }
        public static long UserRevision { get { return Interlocked.Read(ref revision); } }
        public static bool StopRequested { get { return Interlocked.CompareExchange(ref stopRequested, 0, 0) != 0; } }
        public static int QuietForMs
        {
            get
            {
                uint elapsed = unchecked((uint)(Environment.TickCount - Interlocked.CompareExchange(ref lastExternalTick, 0, 0)));
                return elapsed > int.MaxValue ? int.MaxValue : (int)elapsed;
            }
        }

        public static void Start()
        {
            if (hookThread != null) return;
            hookThread = new Thread(delegate()
            {
                hookThreadId = GetCurrentThreadId();
                MSG message;
                PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
                mouseProc = delegate(int code, IntPtr w, IntPtr l)
                {
                    if (code >= 0)
                    {
                        MouseHook input = (MouseHook)Marshal.PtrToStructure(l, typeof(MouseHook));
                        if (input.Extra != Kernel.OwnInputTag)
                        {
                            IntPtr hit = WindowFromPoint(input.Pt), root = GetAncestor(hit, 2);
                            long hwnd = (root == IntPtr.Zero ? hit : root).ToInt64();
                            long owner = RootOwner(hwnd);
                            int messageId = w.ToInt32();
                            int button = messageId == 0x201 || messageId == 0x202 ? 1
                                : messageId == 0x204 || messageId == 0x205 ? 2
                                : messageId == 0x207 || messageId == 0x208 ? 4
                                : messageId == 0x20b || messageId == 0x20c ? 8 : 0;
                            bool down = messageId == 0x201 || messageId == 0x204 || messageId == 0x207 || messageId == 0x20b;
                            if (down)
                            {
                                if (gestureButtons == 0) { gestureWindow = hwnd; gestureOwner = owner; }
                                gestureButtons |= button;
                            }
                            if (gestureButtons != 0) { hwnd = gestureWindow; owner = gestureOwner; }
                            // Crossing/hovering over the AI window is not editing it. A drag,
                            // button transition or wheel is a real interaction with its target.
                            RecordExternalInput(hwnd, owner, messageId != 0x200 || gestureButtons != 0);
                            if (!down && button != 0) gestureButtons &= ~button;
                        }
                    }
                    return CallNextHookEx(mouseHook, code, w, l);
                };
                keyboardProc = delegate(int code, IntPtr w, IntPtr l)
                {
                    if (code >= 0)
                    {
                        KeyboardHook input = (KeyboardHook)Marshal.PtrToStructure(l, typeof(KeyboardHook));
                        if (input.Extra != Kernel.OwnInputTag)
                        {
                            if (input.Vk == 0x1b && (w.ToInt32() == 0x100 || w.ToInt32() == 0x104))
                                Interlocked.Exchange(ref stopRequested, 1);
                            long hwnd = ForegroundHwnd();
                            RecordExternalInput(hwnd, RootOwner(hwnd), true);
                        }
                    }
                    return CallNextHookEx(keyboardHook, code, w, l);
                };
                mouseHook = SetWindowsHookEx(14, mouseProc, GetModuleHandle(null), 0);
                keyboardHook = SetWindowsHookEx(13, keyboardProc, GetModuleHandle(null), 0);
                Monitoring = mouseHook != IntPtr.Zero && keyboardHook != IntPtr.Zero;
                HookReady.Set();
                try { while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); } }
                finally
                {
                    if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
                    if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
                    Monitoring = false;
                }
            });
            hookThread.IsBackground = true;
            hookThread.Start();
            if (!HookReady.WaitOne(3000)) throw new Exception("input monitor did not start");
            AppDomain.CurrentDomain.ProcessExit += delegate { Stop(); };
        }

        public static void Stop()
        {
            Kernel.ReleaseHeldKeys();
            if (hookThreadId != 0) PostThreadMessage(hookThreadId, 0x12, IntPtr.Zero, IntPtr.Zero);
            if (hookThread != null && hookThread != Thread.CurrentThread) hookThread.Join(250);
        }

        public static bool Acquire()
        {
            if (ownsLease) return true;
            if (lease == null) lease = new Mutex(false, "Local\\OwlComputerUse-Desktop-" + Process.GetCurrentProcess().SessionId);
            try { ownsLease = lease.WaitOne(0); }
            catch (AbandonedMutexException) { ownsLease = true; }
            return ownsLease;
        }

        public static void Release()
        {
            ReleaseDesktop();
            foreach (long hwnd in new List<long>(OwnedWindows))
            { WindowLeases[hwnd].ReleaseMutex(); OwnedWindows.Remove(hwnd); }
        }

        public static void ReleaseDesktop()
        {
            Kernel.ReleaseHeldKeys();
            if (ownsLease) { ownsLease = false; lease.ReleaseMutex(); }
        }

        public static bool AcquireWindow(long hwnd)
        {
            hwnd = RootOwner(hwnd);
            if (OwnedWindows.Contains(hwnd)) return true;
            Mutex windowLease;
            if (!WindowLeases.TryGetValue(hwnd, out windowLease))
            {
                windowLease = new Mutex(false, "Local\\OwlComputerUse-Window-" + Process.GetCurrentProcess().SessionId + "-" + hwnd);
                WindowLeases[hwnd] = windowLease;
            }
            bool acquired;
            try { acquired = windowLease.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; }
            if (acquired) OwnedWindows.Add(hwnd);
            return acquired;
        }

        public static long RootOwner(long hwnd)
        {
            IntPtr current = new IntPtr(hwnd), root = GetAncestor(current, 2);
            if (root != IntPtr.Zero) current = root;
            uint processId;
            GetWindowThreadProcessId(current, out processId);
            // Include this application's dialogs, but do not merge another process's
            // owned/projection window into Owl's chat window input scope.
            for (int depth = 0; depth < 16; depth++)
            {
                IntPtr owner = GetWindow(current, 4); // GW_OWNER
                uint ownerProcess;
                if (owner == IntPtr.Zero || GetWindowThreadProcessId(owner, out ownerProcess) == 0 || ownerProcess != processId) break;
                current = owner;
            }
            return current == IntPtr.Zero ? hwnd : current.ToInt64();
        }

        public static long WindowRevision(long hwnd)
        {
            long owner = RootOwner(hwnd), value;
            lock (WindowGate) return WindowInputs.TryGetValue(owner, out value) ? value : 0;
        }

        // The native self-test uses scoped events without moving the user's pointer.
        // The PowerShell command exposing this recorder is disabled outside that test.
        public static void ReportExternalInput(long hwnd, bool interaction)
        {
            RecordExternalInput(hwnd, RootOwner(hwnd), interaction);
        }

        private static void RecordExternalInput(long hwnd, long owner, bool interaction)
        {
            Interlocked.Increment(ref revision); // Every physical event still fences real SendInput.
            Interlocked.Exchange(ref lastExternalTick, Environment.TickCount);
            if (!interaction || hwnd == 0) return;
            lock (WindowGate)
            {
                long current;
                WindowInputs.TryGetValue(hwnd, out current); WindowInputs[hwnd] = current + 1;
                if (owner != 0 && owner != hwnd)
                { WindowInputs.TryGetValue(owner, out current); WindowInputs[owner] = current + 1; }
            }
        }

        public static long ForegroundHwnd() { return GetForegroundWindow().ToInt64(); }
        public static bool Exists(long hwnd) { return hwnd != 0 && IsWindow(new IntPtr(hwnd)); }
        public static bool Visible(long hwnd) { return IsWindowVisible(new IntPtr(hwnd)) && !IsIconic(new IntPtr(hwnd)); }
        public static long WindowAtCursor()
        {
            POINT point;
            if (!GetCursorPos(out point)) return 0;
            IntPtr hwnd = WindowFromPoint(point), root = GetAncestor(hwnd, 2);
            return (root == IntPtr.Zero ? hwnd : root).ToInt64();
        }
        public static int InputTick()
        {
            LASTINPUTINFO info = new LASTINPUTINFO(); info.Size = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref info)) throw new Exception("input timestamp unavailable");
            return unchecked((int)info.Tick);
        }
        public static long[] Geometry(long hwnd, bool compositor)
        {
            RECT rect;
            if (compositor && DwmGetWindowAttribute(new IntPtr(hwnd), 9, out rect, 16) == 0)
                return new long[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
            if (!GetWindowRect(new IntPtr(hwnd), out rect)) throw new Exception("window geometry unavailable");
            return new long[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
        }
        public static bool Unobscured(long hwnd)
        {
            if (!Visible(hwnd)) return false;
            long[] bounds = Geometry(hwnd, false);
            long vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
            if (bounds[0] < vx || bounds[1] < vy || bounds[0] + bounds[2] > vx + vw || bounds[1] + bounds[3] > vy + vh) return false;
            bool clear = true;
            EnumWindows(delegate(IntPtr above, IntPtr unused)
            {
                if (above.ToInt64() == hwnd) return false;
                if (!IsWindowVisible(above) || IsIconic(above)) return true;
                int cloaked;
                if (DwmGetCloaked(above, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                RECT other;
                if (GetWindowRect(above, out other) && other.Right > bounds[0] && other.Bottom > bounds[1]
                    && other.Left < bounds[0] + bounds[2] && other.Top < bounds[1] + bounds[3]) { clear = false; return false; }
                return true;
            }, IntPtr.Zero);
            return clear;
        }

        public static ChildResult RunChild(string executable, string request, int timeoutMs)
        {
            return RunChild(executable, request, timeoutMs, 0, 0, 0, false);
        }

        public static ChildResult RunChild(string executable, string request, int timeoutMs,
            long hwnd, long windowRevision, long globalRevision, bool exclusive)
        {
            ChildResult result = new ChildResult();
            StringBuilder output = new StringBuilder(), error = new StringBuilder();
            Process child = new Process();
            child.StartInfo = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Exception("UIA lifetime job could not be created");
            try
            {
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                    throw new Exception("UIA lifetime job could not be configured");
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
                {
                    if (args.Data == "{\"event\":\"guard_ready\"}")
                    {
                        // UIA providers can take seconds to locate a control. Recheck the
                        // parent's live hooks at the last possible moment before execution.
                        bool allowed = hwnd != 0 && Monitoring && !StopRequested && Exists(hwnd) && WindowRevision(hwnd) == windowRevision
                            && (!exclusive || UserRevision == globalRevision);
                        try
                        {
                            byte[] decision = Encoding.UTF8.GetBytes(allowed ? "continue\n" : "stop\n");
                            child.StandardInput.BaseStream.Write(decision, 0, decision.Length);
                            child.StandardInput.BaseStream.Flush();
                        }
                        catch (IOException) { }
                    }
                    else if (args.Data != null) { lock (output) output.AppendLine(args.Data); }
                };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) { lock (error) error.AppendLine(args.Data); } };
                child.Start();
                if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); throw new Exception("UIA lifetime job could not own helper"); }
                child.BeginOutputReadLine(); child.BeginErrorReadLine();
                // Windows PowerShell's Console.InputEncoding is commonly an OEM page;
                // the UIA helper protocol is UTF-8 regardless of that parent setting.
                byte[] bytes = Encoding.UTF8.GetBytes(request + "\n");
                child.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
                child.StandardInput.BaseStream.Flush();
                if (!child.WaitForExit(timeoutMs)) { result.TimedOut = true; child.Kill(); child.WaitForExit(); }
                else child.WaitForExit(); // Drain redirected async output.
                result.ExitCode = child.ExitCode;
                lock (output) result.Output = output.ToString();
                lock (error) result.Error = error.ToString();
                return result;
            }
            finally { CloseHandle(job); child.Dispose(); }
        }

        private delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
        private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct MouseHook { public POINT Pt; public uint Data, Flags, Time; public IntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] private struct KeyboardHook { public uint Vk, Scan, Flags, Time; public IntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr W, L; public uint Time; public POINT Pt; }
        [StructLayout(LayoutKind.Sequential)] private struct LASTINPUTINFO { public uint Size, Tick; }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long UserTime, JobTime; public uint LimitFlags; public UIntPtr MinWork, MaxWork; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
        [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
        [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG msg);
        [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc proc, IntPtr data);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetCloaked(IntPtr hwnd, int attr, out int value, int size);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string module);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int type, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
        [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}
