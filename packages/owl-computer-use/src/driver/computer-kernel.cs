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
            if (width <= 0 || height <= 0) throw new Exception("capture target has empty size");

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
            if (cx <= 0 || cy <= 0) throw new Exception("invalid virtual screen metrics");
            uint nx = (uint)(((long)(x - vx) * 65536) / cx);
            uint ny = (uint)(((long)(y - vy) * 65536) / cy);
            if (nx > 65535) nx = 65535;
            if (ny > 65535) ny = 65535;

            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 0; // INPUT_MOUSE
            inputs[0].u.mi.dx = (int)nx;
            inputs[0].u.mi.dy = (int)ny;
            inputs[0].u.mi.mouseData = 0;
            inputs[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            DispatchMouse(inputs);
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
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length) throw new Exception("SendInput(mouse) blocked or failed");
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
            ushort[] scans = new ushort[downVks.Length + tapVks.Length + 1];
            for (int i = 0; i < downVks.Length; i++)
            {
                SendKeyState(downVks[i], ScanOf(downVks[i]), false);
                Thread.Sleep(15);
            }
            for (int i = 0; i < tapVks.Length; i++)
            {
                TapKey(tapVks[i], ScanOf(tapVks[i]));
                Thread.Sleep(15);
            }
            for (int i = downVks.Length - 1; i >= 0; i--)
            {
                SendKeyState(downVks[i], ScanOf(downVks[i]), true);
            }
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
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length) throw new Exception("SendInput(keyboard) blocked or failed");
        }

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
}
