# owl mirror worker: enumerate windows / WGC capture loop / restore / launch.
# JSON lines on stdout (UTF-8), one event per line:
#   {"event":"window","hwnd":N,"title":"...","process":"...","w":N,"h":N,"minimized":bool,"class":"..."}
#   {"event":"frame","seq":N,"w":N,"h":N,"data":"<base64 jpeg>"}
#   {"event":"status","iconic":bool,"autoRestored":N,"frameSeq":N}
#   {"event":"error","message":"..."}
#   {"event":"ready"}
#
# 捕获内核（windows-capture.cs）由本脚本用进程外 csc 带系统 winmd 引用编译成
# DLL 并缓存（%TEMP% 按 cs 内容哈希），再字节加载 —— 进程内 Add-Type 既没有
# winmd 引用能力，net48 的 IInspectable vtable 互操作也不可靠。文件必须保存为
# UTF-8 with BOM（PowerShell 5.1 的要求，否则中文字符串按 GBK 误读）。
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'capture', 'restore', 'launch', 'probe', 'embed', 'move', 'unembed', 'clientorigin', 'movewin', 'host', 'guard')]
  [string]$Command,

  [long]$Hwnd = 0,
  [long]$ParentHwnd = 0,
  [long]$Style = -1,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 400,
  [int]$H = 300,
  [int]$Fps = 20,
  [int]$Quality = 70,
  [int]$MaxWidth = 1280,
  [int]$FrameTimeoutMs = 1500,
  [switch]$CaptureDiagnostics,
  [switch]$NoAutoRestore,
  # 侧栏形态：吃掉最小化（清 WS_MINIMIZEBOX）。放大/悬浮不传，保持「最小化后拉回」。
  [switch]$SwallowMinimize,
  [switch]$Projection,
  [string]$ControlPath = '',
  [string]$GeometryId = '',
  [switch]$HasBaseRect,
  [int]$BaseX = 0,
  [int]$BaseY = 0,
  [int]$BaseW = 0,
  [int]$BaseH = 0,
  [long]$BaseParent = 0,
  [long]$ExpectedPid = 0,
  [int]$GuardPid = 0,
  [int]$GuardToken = 0,
  [string]$GuardMarker = '',
  # 再次 embed 时带回第一次读到的原始样式（含 WS_POPUP 高位），避免用已改过的样式覆盖。
  [switch]$HasBaseStyle,
  [long]$BaseStyle = 0
)

$ErrorActionPreference = 'Stop'
$script:AutoRestored = 0
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-JsonLine([string]$line) {
  $bytes = $Utf8NoBom.GetBytes($line + [Environment]::NewLine)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Escape-Json([string]$text) {
  if ($null -eq $text) { return '' }
  $escaped = $text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
  return $escaped
}

# ---------------------------------------------------------------------------
# window interop (list / restore): pure user32, no WinRT
# ---------------------------------------------------------------------------
$user32 = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OwlMirrorWin32 {
    public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert);
    [DllImport("user32.dll")] public static extern bool DeleteMenu(IntPtr hMenu, uint uPosition, uint uFlags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    public static extern int DwmGetWindowRectAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmFlush();
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref PT point);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT rect, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr RemoveProp(IntPtr hwnd, string name);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
    public struct PT { public int X; public int Y; }

    public struct ProjectionBounds {
        public RECT Capture;
        public RECT Crop;
        public PT ClientOffset;
    }

    public static bool TryAndroidSurface(IntPtr root, out RECT surface) {
        RECT found = new RECT();
        long largest = 0;
        int bestVisibility = -1;
        uint rootPid;
        GetWindowThreadProcessId(root, out rootPid);
        EnumChildWindows(root, (child, unused) => {
            if (GetClassName(child) != "subWin") return true;
            uint pid;
            GetWindowThreadProcessId(child, out pid);
            if (pid == 0 || pid == rootPid) return true;
            try {
                using (var process = System.Diagnostics.Process.GetProcessById((int)pid)) {
                    if (!String.Equals(process.ProcessName, "AndrowsVm", StringComparison.OrdinalIgnoreCase)) return true;
                }
            } catch { return true; }
            RECT client;
            PT origin = new PT();
            if (!GetClientRect(child, out client) || !ClientToScreen(child, ref origin)) return true;
            int w = client.Right - client.Left, h = client.Bottom - client.Top;
            long area = (long)w * h;
            int visibility = IsWindowVisible(child) ? 2 : ((GetStyle(child) & 0x10000000L) != 0 ? 1 : 0);
            if (w < 80 || h < 80 || visibility < bestVisibility || (visibility == bestVisibility && area <= largest)) return true;
            found.Left = origin.X; found.Top = origin.Y;
            found.Right = origin.X + w; found.Bottom = origin.Y + h;
            largest = area;
            bestVisibility = visibility;
            return true;
        }, IntPtr.Zero);
        surface = found;
        return largest > 0;
    }

    public static RECT MinimumSurfaceWindowRect(IntPtr root, RECT surface) {
        RECT outer, client;
        PT origin = new PT();
        if (!GetWindowRect(root, out outer) || !GetClientRect(root, out client) || !ClientToScreen(root, ref origin))
            throw new InvalidOperationException("Android host bounds unavailable");
        if (surface.Left < outer.Left || surface.Top < outer.Top)
            throw new InvalidOperationException("Android surface starts outside its host");
        int rightBorder = Math.Max(0, outer.Right - origin.X - (client.Right - client.Left));
        int bottomBorder = Math.Max(0, outer.Bottom - origin.Y - (client.Bottom - client.Top));
        outer.Right = surface.Right + rightBorder;
        outer.Bottom = surface.Bottom + bottomBorder;
        return outer;
    }

    public static RECT RequiredSurfaceWindowRect(IntPtr root, RECT surface) {
        RECT required = MinimumSurfaceWindowRect(root, surface);
        RECT current;
        if (!GetWindowRect(root, out current)) throw new InvalidOperationException("Android host bounds unavailable");
        required.Right = Math.Max(required.Right, current.Right);
        required.Bottom = Math.Max(required.Bottom, current.Bottom);
        return required;
    }

    public static ProjectionBounds ReadProjectionBounds(IntPtr hwnd, double scale) {
        // WGC omits DWM's invisible resize border. Synchronize the compositor
        // after placement and keep every coordinate relative to that same frame.
        DwmFlush();
        RECT outer;
        if (!GetWindowRect(hwnd, out outer)) throw new InvalidOperationException("Projection window bounds unavailable");
        RECT capture;
        int result = DwmGetWindowRectAttribute(hwnd, 9, out capture, Marshal.SizeOf(typeof(RECT)));
        if (result != 0 || capture.Right <= capture.Left || capture.Bottom <= capture.Top) capture = outer;
        PT client = new PT();
        if (!ClientToScreen(hwnd, ref client)) throw new InvalidOperationException("Projection client origin unavailable");
        RECT surface;
        if (TryAndroidSurface(hwnd, out surface)) {
            ProjectionBounds bounds = new ProjectionBounds();
            bounds.Capture = capture;
            bounds.Crop.Left = surface.Left - capture.Left;
            bounds.Crop.Top = surface.Top - capture.Top;
            bounds.Crop.Right = surface.Right - capture.Left;
            bounds.Crop.Bottom = surface.Bottom - capture.Top;
            bounds.ClientOffset.X = client.X - capture.Left;
            bounds.ClientOffset.Y = client.Y - capture.Top;
            return bounds;
        }
        return ProjectionBoundsFromRects(outer, capture, client, scale);
    }

    public static ProjectionBounds ProjectionBoundsFromRects(RECT outer, RECT capture, PT client, double scale) {
        ProjectionBounds bounds = new ProjectionBounds();
        bounds.Capture = capture;
        bounds.Crop.Left = (int)Math.Round(4 * scale) + outer.Left - capture.Left;
        bounds.Crop.Top = (int)Math.Round(40 * scale) + outer.Top - capture.Top;
        bounds.Crop.Right = bounds.Crop.Left + (int)Math.Round(843 * scale);
        bounds.Crop.Bottom = bounds.Crop.Top + (int)Math.Round(472 * scale);
        bounds.ClientOffset.X = client.X - capture.Left;
        bounds.ClientOffset.Y = client.Y - capture.Top;
        return bounds;
    }

    public static System.Threading.Mutex LockProjection(IntPtr hwnd) {
        var mutex = new System.Threading.Mutex(false, "Local\\OwlMirrorProjection-" + hwnd.ToInt64());
        try { mutex.WaitOne(); }
        catch (System.Threading.AbandonedMutexException) { }
        return mutex;
    }

    public static RECT VisibleRestoreRect(RECT rect, IntPtr owner) {
        MONITORINFO info = new MONITORINFO();
        info.Size = Marshal.SizeOf(typeof(MONITORINFO));
        IntPtr monitor = MonitorFromRect(ref rect, 0);
        if (monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info)) {
            int iw = Math.Min(rect.Right, info.Work.Right) - Math.Max(rect.Left, info.Work.Left);
            int ih = Math.Min(rect.Bottom, info.Work.Bottom) - Math.Max(rect.Top, info.Work.Top);
            if (iw >= 80 && ih >= 80) return rect;
        }
        GetMonitorInfo(MonitorFromWindow(owner, 2), ref info);
        int w = Math.Min(906, info.Work.Right - info.Work.Left);
        int h = Math.Min(547, info.Work.Bottom - info.Work.Top);
        rect.Left = info.Work.Left + (info.Work.Right - info.Work.Left - w) / 2;
        rect.Top = info.Work.Top + (info.Work.Bottom - info.Work.Top - h) / 2;
        rect.Right = rect.Left + w;
        rect.Bottom = rect.Top + h;
        return rect;
    }

    public static bool IsCloaked(IntPtr hwnd) {
        int cloaked;
        try {
            DwmGetWindowAttribute(hwnd, 14, out cloaked, 4);
        } catch { cloaked = 0; }
        return cloaked != 0;
    }

    public static string GetTitle(IntPtr hwnd) {
        int len = GetWindowTextLength(hwnd);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string GetClassName(IntPtr hwnd) {
        var sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll", EntryPoint = "SetParent", SetLastError = true)] public static extern IntPtr SetParentRaw(IntPtr child, IntPtr parent);
    [DllImport("kernel32.dll")] public static extern void SetLastError(uint e);

    // SetParent + GetLastError 原子化：PowerShell 会在两次 P/Invoke 之间插入自己的
    // interop 调用污染 GetLastWin32Error（成功被误判为失败）。返回 0 = 成功。
    public static int TrySetParent(IntPtr child, IntPtr parent) {
        SetLastError(0);
        IntPtr prev = SetParentRaw(child, parent);
        int err = Marshal.GetLastWin32Error();
        if (prev == IntPtr.Zero && err == 0) return 0;      // 无旧父且无错误：成功
        return err;
    }

    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    public static bool LeftButtonDown() { return (GetAsyncKeyState(1) & 0x8000) != 0; }

    // 侧栏里裁掉红果自己画的标题条（最小化/最大化在那一条上）。返回 0 表示不裁。
    public const int SidebarChrome = 40;
    public static void ClipSidebarChrome(IntPtr hwnd, int width, int height, bool redraw) {
        if (width < 80 || height <= SidebarChrome) {
            SetWindowRgn(hwnd, IntPtr.Zero, redraw);
            return;
        }
        IntPtr rgn = CreateRectRgn(0, SidebarChrome, width, height);
        SetWindowRgn(hwnd, rgn, redraw);
    }
    public static void ClearClip(IntPtr hwnd) {
        SetWindowRgn(hwnd, IntPtr.Zero, true);
    }

    // 红果窗口里真正的画面。上面 40px 是「红果免费短剧」标题，左边 4px 是边，
    // 右边 62px 是应用宝自己的按钮条。侧栏只露画面，这三块裁掉。
    public const int ContentLeft = 4;
    public const int ContentTop = 40;
    public const int ContentRight = 62;
    public const int ContentBottom = 0;

    [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT rect);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr rgn);

    public static int ClipContent(IntPtr hwnd, int left, int top, int right, int bottom) {
        if (right - left < 80 || bottom - top < 80) {
            SetWindowRgn(hwnd, IntPtr.Zero, false);
            return 0;
        }
        IntPtr rgn = CreateRectRgn(left, top, right, bottom);
        return SetWindowRgn(hwnd, rgn, true);
    }

    public static bool ContentClipOk(IntPtr hwnd, int left, int top, int right, int bottom) {
        IntPtr probe = CreateRectRgn(0, 0, 0, 0);
        int kind = GetWindowRgn(hwnd, probe);
        RECT box;
        GetRgnBox(probe, out box);
        DeleteObject(probe);
        if (kind < 2) return false;
        return Math.Abs(box.Left - left) <= 2 && Math.Abs(box.Top - top) <= 2
            && Math.Abs(box.Right - right) <= 2 && Math.Abs(box.Bottom - bottom) <= 2;
    }

    // 铺满窗口的是容器。真正的画面是更小的那一块（播放器会在容器里居中，四周是空白）。
    public static bool TrySurface(IntPtr hwnd, out int left, out int top, out int right, out int bottom) {
        left = ContentLeft;
        top = ContentTop;
        right = 0;
        bottom = 0;
        RECT root;
        if (!GetWindowRect(hwnd, out root)) return false;
        int rw = root.Right - root.Left;
        int rh = root.Bottom - root.Top;
        int best = int.MaxValue;
        int bl = 0, bt = 0, br = 0, bb = 0;
        bool found = false;
        EnumChildWindows(hwnd, (child, l) => {
            RECT r;
            if (!GetWindowRect(child, out r)) return true;
            int x = r.Left - root.Left;
            int y = r.Top - root.Top;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w < 200 || h < 120 || x < -10 || y < -10) return true;
            int area = w * h;
            if (area < best) { best = area; bl = x; bt = y; br = x + w; bb = y + h; found = true; }
            return true;
        }, IntPtr.Zero);
        if (!found) return false;
        if ((br - bl) > rw - 30 && (bb - bt) > rh - 30) {
            left = ContentLeft;
            top = ContentTop;
            right = rw - ContentRight;
            bottom = rh;
            return right - left >= 80 && bottom - top >= 80;
        }
        left = bl;
        top = bt;
        right = br;
        bottom = bb;
        return true;
    }

    // 不再拉子窗口。Qt 自己排版，强行 SetWindowPos 会把底栏画成两层。
    public static void StretchToContent(IntPtr root, int contentX, int contentY, int contentW, int contentH) {
    }

    // 舞台必须落在 Owl 窗口里面。Owl 藏起来、最小化，或舞台超出窗口时，
    // 红果不能留在桌面壁纸上。
    public static bool StageInsideOwner(IntPtr owner, int sx, int sy, int sw, int sh) {
        if (owner == IntPtr.Zero || !IsWindow(owner) || !IsWindowVisible(owner) || IsIconic(owner)) return false;
        if (sw < 80 || sh < 80) return false;
        RECT o;
        if (!GetWindowRect(owner, out o)) return false;
        PT origin = new PT();
        origin.X = 0;
        origin.Y = 0;
        if (!ClientToScreen(owner, ref origin)) return false;
        int l = origin.X + sx;
        int t = origin.Y + sy;
        int r = l + sw;
        int b = t + sh;
        return l >= o.Left - 8 && t >= o.Top - 8 && r <= o.Right + 8 && b <= o.Bottom + 8;
    }

    // Size the app's client content from the stage, rather than using the old
    // player rectangle as a crop. WM_SIZE lets Qt keep layout and input
    // coordinates in sync with the available space.
    public static int PlaceStage(IntPtr hwnd, IntPtr owner, int sx, int sy, int sw, int sh) {
        double scale = Math.Max(96, GetDpiForWindow(hwnd)) / 96.0;
        int left = (int)Math.Round(ContentLeft * scale);
        int top = (int)Math.Round(ContentTop * scale);
        int right = (int)Math.Round(ContentRight * scale);
        int bottom = (int)Math.Round(ContentBottom * scale);
        int x = sx - left;
        int y = sy - top;
        int w = sw + left + right;
        int h = sh + top + bottom;
        // Do not break a press/release pair by moving the window under it.
        if (LeftButtonDown() && CursorOver(hwnd)) return 0;
        if (!IsPlacedAt(hwnd, owner, x, y, w, h) ||
            !ContentClipOk(hwnd, left, top, left + sw, top + sh)) {
            int err = PlaceOwned(hwnd, owner, x, y, w, h, true);
            if (err != 0) return err;
            ClipContent(hwnd, left, top, left + sw, top + sh);
            SuppressFrame(hwnd);
        }
        SyncQtSize(hwnd, w, h);
        return 0;
    }

    static IntPtr LargestChild(IntPtr root) {
        IntPtr child = GetWindow(root, 5);
        IntPtr best = IntPtr.Zero;
        int bestArea = 0;
        while (child != IntPtr.Zero) {
            RECT r;
            if (GetWindowRect(child, out r)) {
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w >= 160 && h >= 120 && w * h > bestArea) {
                    bestArea = w * h;
                    best = child;
                }
            }
            child = GetWindow(child, 2);
        }
        return best;
    }

    static bool cardOk = false;
    static int cardL, cardT, cardR, cardB;
    static int seenL, seenT, seenR, seenB, seenN;

    static bool NearCard(int l, int t, int r, int b, int ll, int tt, int rr, int bb) {
        return Math.Abs(l - ll) <= 12 && Math.Abs(t - tt) <= 12 && Math.Abs(r - rr) <= 12 && Math.Abs(b - bb) <= 12;
    }

    // 播放器卡片是一大块深色区域。应用宝的标题和工具条是旁边的白底，不放进这块。
    static void ConsiderCard(IntPtr hwnd) {
        RECT wr;
        if (!GetWindowRect(hwnd, out wr)) return;
        int w = wr.Right - wr.Left;
        int h = wr.Bottom - wr.Top;
        if (w < 200 || h < 200) return;
        if (!PointIsOurs(hwnd, wr.Left + w / 2, wr.Top + h / 2)) return;
        IntPtr dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return;
        int top = -1, bot = -1, left = w, right = 0;
        for (int y = 36; y < h - 8; y += 16) {
            int bestL = -1, bestR = -1, best = 0;
            int runL = -1, last = -1;
            int sy = wr.Top + y;
            for (int x = 8; x < w - 8; x += 16) {
                uint px = GetPixel(dc, wr.Left + x, sy);
                int lum = (int)((px & 0xFF) * 30 + ((px >> 8) & 0xFF) * 59 + ((px >> 16) & 0xFF) * 11) / 100;
                // 白底是应用宝的标题和工具条。播放器本身不是这块白。
                bool ink = lum < 210;
                if (ink) {
                    if (runL < 0) runL = x;
                    last = x;
                } else if (runL >= 0 && x - last > 28) {
                    int len = last - runL;
                    if (len > best) { best = len; bestL = runL; bestR = last; }
                    runL = -1;
                }
            }
            if (runL >= 0) {
                int len = last - runL;
                if (len > best) { best = len; bestL = runL; bestR = last; }
            }
            if (best >= 240) {
                if (top < 0) top = y;
                bot = y;
                if (bestL < left) left = bestL;
                if (bestR > right) right = bestR;
            }
        }
        ReleaseDC(IntPtr.Zero, dc);
        if (top < 0 || right - left < 220 || bot - top < 160) return;
        if (right - left > w - 80 && bot - top > h - 80) return;
        if (seenN > 0 && NearCard(left, top, right, bot, seenL, seenT, seenR, seenB)) seenN++;
        else { seenL = left; seenT = top; seenR = right; seenB = bot; seenN = 1; }
        if (seenN >= 2 && (!cardOk || !NearCard(left, top, right, bot, cardL, cardT, cardR, cardB))) {
            cardL = left;
            cardT = top;
            cardR = right;
            cardB = bot;
            cardOk = true;
            seenN = 0;
        }
    }

    static int pendingSyncW = -1;
    static int pendingSyncH = -1;
    static int syncedW = -1;
    static int syncedH = -1;
    static int sizeStill = 0;

    // 尺寸停稳后再告诉 Qt 一次。NOSENDCHANGING 让 Qt 还记着旧大小，按钮就点偏。
    // 只发一次，不在每拍里发，否则画面会被重新居中。
    static void SyncQtSize(IntPtr hwnd, int w, int h) {
        if (w != pendingSyncW || h != pendingSyncH) {
            pendingSyncW = w;
            pendingSyncH = h;
            sizeStill = 0;
            return;
        }
        if (sizeStill < 40) sizeStill++;
        if (sizeStill < 12 || (syncedW == w && syncedH == h) || LeftButtonDown()) return;
        PostMessage(hwnd, 0x0232, IntPtr.Zero, IntPtr.Zero); // WM_EXITSIZEMOVE
        IntPtr child = GetWindow(hwnd, 5); // GW_CHILD
        if (child != IntPtr.Zero) {
            RECT client;
            if (GetClientRect(child, out client)) {
                int packed = (client.Right & 0xFFFF) | ((client.Bottom & 0xFFFF) << 16);
                PostMessage(child, 0x0005, IntPtr.Zero, new IntPtr(packed)); // WM_SIZE，让按钮按新尺寸重排
            }
        }
        syncedW = w;
        syncedH = h;
    }

    static bool CursorOver(IntPtr hwnd) {
        PT cursor;
        if (!GetCursorPos(out cursor)) return false;
        return PointIsOurs(hwnd, cursor.X, cursor.Y);
    }
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    public static void SuppressFrame(IntPtr hwnd) {
        int policy = 1; // DWMNCRP_DISABLED
        DwmSetWindowAttribute(hwnd, 2, ref policy, 4);
        int corner = 1; // DWMWCP_DONOTROUND
        DwmSetWindowAttribute(hwnd, 33, ref corner, 4);
        int none = -2; // DWMWA_COLOR_NONE
        DwmSetWindowAttribute(hwnd, 34, ref none, 4);
    }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT point);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
    static int cachedLetterbox = 0;
    static int pendingInset = -1;
    static int pendingCount = 0;

    static bool PointIsOurs(IntPtr hwnd, int x, int y) {
        PT hitAt = new PT();
        hitAt.X = x;
        hitAt.Y = y;
        IntPtr hit = WindowFromPoint(hitAt);
        for (int i = 0; i < 8 && hit != IntPtr.Zero; i++) {
            if (hit == hwnd) return true;
            hit = GetParent(hit);
        }
        return false;
    }

    // 鼠标停在红果上、并且当前正在用 Owl 时，先把红果激活。
    // 不激活的话，应用宝会丢掉按下的那一下，按钮看起来就没反应。
    static bool BelongsTo(IntPtr root, IntPtr hwnd) {
        IntPtr walk = hwnd;
        for (int i = 0; i < 10 && walk != IntPtr.Zero; i++) {
            if (walk == root) return true;
            IntPtr parent = GetParent(walk);
            if (parent == walk) break;
            walk = parent;
        }
        return false;
    }

    public static void ActivateIfPressed(IntPtr hwnd, IntPtr owner) {
        // 按下的过程中再抢前台，这一下点击就丢了。
        if (LeftButtonDown()) return;
        PT cursor;
        if (!GetCursorPos(out cursor)) return;
        if (!PointIsOurs(hwnd, cursor.X, cursor.Y)) return;
        IntPtr fg = GetForegroundWindow();
        if (fg == hwnd || BelongsTo(hwnd, fg)) return;
        bool owlFocused = fg == owner;
        IntPtr walk = fg;
        for (int i = 0; i < 8 && walk != IntPtr.Zero && !owlFocused; i++) {
            if (walk == owner) owlFocused = true;
            walk = GetParent(walk);
        }
        if (!owlFocused) return;
        SetForegroundWindow(hwnd);
    }

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT point);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);

    // 播放页会在画面上方留一大块纯黑。量到这块黑，后面把画面居中。
    public static int LetterboxTop(IntPtr hwnd, IntPtr owner, int contentLeft, int contentTop, int contentW, int contentH) {
        RECT wr;
        if (!GetWindowRect(hwnd, out wr)) return cachedLetterbox;
        IntPtr dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return cachedLetterbox;
        int inset = 0;
        bool sawOurs = false;
        bool foundBright = false;
        // 竖屏侧栏里，横屏播放页的黑边经常超过一半高度。最多裁到还剩 160 像素画面。
        // 只抽三列、隔行取样。整屏逐点量会把跟随拖成一秒一跳。
        int limit = contentH - 160;
        if (limit < 80) limit = 80;
        int xLeft = 24;
        int xMid = contentW / 2;
        int xRight = contentW - 24;
        if (xRight < xLeft) xRight = xLeft;
        for (int y = 0; y < limit; y += 8) {
            int dark = 0;
            int n = 0;
            int sy = wr.Top + contentTop + y;
            int[] xs = new int[] { xLeft, xMid, xRight };
            for (int i = 0; i < xs.Length; i++) {
                int sx = wr.Left + contentLeft + xs[i];
                if (!PointIsOurs(hwnd, sx, sy)) continue;
                sawOurs = true;
                uint px = GetPixel(dc, sx, sy);
                int lum = (int)((px & 0xFF) * 30 + ((px >> 8) & 0xFF) * 59 + ((px >> 16) & 0xFF) * 11) / 100;
                if (lum < 14) dark++;
                n++;
            }
            if (n == 0) continue;
            if (dark * 100 / n < 85) { inset = y; foundBright = true; break; }
        }
        ReleaseDC(IntPtr.Zero, dc);
        if (!sawOurs) return cachedLetterbox;
        if (!foundBright) inset = limit;
        int next = cachedLetterbox;
        if (inset >= 80) next = inset;
        else if (inset < 24) next = 0;
        if (next == cachedLetterbox) {
            pendingInset = -1;
            pendingCount = 0;
            return cachedLetterbox;
        }
        if (next == pendingInset) pendingCount++;
        else { pendingInset = next; pendingCount = 1; }
        // 连着几拍读数一样才改裁切。单次亮暗变化会把窗口从按钮底下挪走。
        if (pendingCount >= 4) {
            cachedLetterbox = next;
            pendingInset = -1;
            pendingCount = 0;
        }
        return cachedLetterbox;
    }

    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "SetWindowPos", SetLastError = true)] public static extern bool SetWindowPosErr(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int cls, byte[] buf, int len, out int ret);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong32(IntPtr hWnd, int index, int value);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern int GetWindowLong32(IntPtr hWnd, int index);

    public static readonly int GWL_STYLE = -16;
    public static readonly long WS_CHILD = 0x40000000L;
    public static readonly long WS_CAPTION = 0x00C00000L;
    public static readonly long WS_THICKFRAME = 0x00040000L;
    public static readonly long WS_MINIMIZEBOX = 0x00020000L;

    public static long GetStyle(IntPtr hwnd) {
        long raw = IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, GWL_STYLE).ToInt64() : GetWindowLong32(hwnd, GWL_STYLE);
        return raw & 0xFFFFFFFFL;
    }

    public static void SetStyle(IntPtr hwnd, long style) {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, GWL_STYLE, new IntPtr(style));
        else SetWindowLong32(hwnd, GWL_STYLE, (int)style);
    }

    // 侧栏去掉标题栏和可调边框，窗口锁在侧栏框里。悬浮才留下边框，方便拉大小。
    public static long EmbedStyle(long style, bool sidebar) {
        long next = style & ~WS_CAPTION;
        if (sidebar) return next & ~WS_THICKFRAME;
        return next | WS_THICKFRAME;
    }

    public static long WithoutMinimizeBox(long style) {
        return style & ~WS_MINIMIZEBOX;
    }

    public static void SuppressMinimize(IntPtr hwnd) {
        IntPtr menu = GetSystemMenu(hwnd, false);
        if (menu != IntPtr.Zero) DeleteMenu(menu, 0xF020, 0); // SC_MINIMIZE / MF_BYCOMMAND
    }

    public static void RestoreSystemMenu(IntPtr hwnd) {
        GetSystemMenu(hwnd, true);
    }

    public static void ApplyBounds(IntPtr hwnd, int x, int y, int w, int h) {
        // SWP_NOZORDER(0x4) | SWP_FRAMECHANGED(0x20)（样式变更后必须发）
        SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, 0x4 | 0x20);
    }

    // 附属窗口模式：红果保持独立顶层窗口，GWLP_HWNDPARENT(-8) 设为 owl 作 owner
    // （随 owl 最小化/置顶，不被 WebView 子窗口遮挡），位置按 owl 客户区原点换算成屏幕坐标。
    public static void SetOwner(IntPtr hwnd, IntPtr owner) {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, -8, owner);
        else SetWindowLong32(hwnd, -8, (int)owner);
    }

    public static void ApplyOwned(IntPtr hwnd, IntPtr owner, int x, int y, int w, int h) {
        PlaceOwned(hwnd, owner, x, y, w, h, false);
    }

    public static void ReadClientRect(IntPtr hwnd, IntPtr owner, out int x, out int y, out int w, out int h) {
        RECT rect = new RECT();
        GetWindowRect(hwnd, out rect);
        PT origin = new PT(); origin.X = 0; origin.Y = 0;
        ClientToScreen(owner, ref origin);
        x = rect.Left - origin.X;
        y = rect.Top - origin.Y;
        w = rect.Right - rect.Left;
        h = rect.Bottom - rect.Top;
    }

    // 返回 0 表示 SetWindowPos 成功。应用宝是高完整性，中完整性调用会得到 5（拒绝访问）。
    // quiet：只改位置尺寸。拖动中不要带 FRAMECHANGED/SHOWWINDOW，否则每一拍都整帧重画，画面会闪。
    public static int PlaceOwned(IntPtr hwnd, IntPtr owner, int x, int y, int w, int h, bool quiet) {
        PT origin = new PT(); origin.X = 0; origin.Y = 0;
        ClientToScreen(owner, ref origin);
        SetLastError(0);
        // Skip the app's top-level minimum tracking size, but retain
        // WM_WINDOWPOSCHANGED / WM_SIZE so its content can resize to the stage.
        uint flags = 0x10 | 0x4 | 0x400;
        if (!quiet) flags |= 0x20 | 0x40; // FRAMECHANGED | SHOWWINDOW，只在改样式时用
        bool ok = SetWindowPosErr(hwnd, IntPtr.Zero, origin.X + x, origin.Y + y, w, h, flags);
        if (!ok) {
            int err = Marshal.GetLastWin32Error();
            return err == 0 ? 5 : err;
        }
        FitChildren(hwnd);
        return 0;
    }

    // 旧界面发来的是 568:920 的等比卡片，四周会留下黑边。把它还原成侧栏舞台：
    // 卡片贴右就是按宽限制，贴底就是按高限制，取能盖住卡片、面积更大的那一个。
    public static void ExpandCard(IntPtr owner, ref int x, ref int y, ref int w, ref int h) {
        if (w < 80 || h < 80) return;
        double aspect = (double)w / h;
        if (Math.Abs(aspect - (568.0 / 920.0)) > 0.03) return;
        RECT client;
        if (!GetClientRect(owner, out client)) return;
        int cw = client.Right - client.Left;
        int ch = client.Bottom - client.Top;
        int best = w * h;
        int bx = x, by = y, bw = w, bh = h;
        int stageBottom = ch - 36;
        int spaceBelow = stageBottom - (y + h);
        int stageTop = y - spaceBelow;
        int stageH = stageBottom - stageTop;
        if (spaceBelow >= -2 && stageTop >= 0 && stageH >= h && stageTop <= y && x >= 0 && x + w <= cw) {
            int area = w * stageH;
            if (area > best) { best = area; bx = x; by = stageTop; bw = w; bh = stageH; }
        }
        int stageRight = cw - 8;
        int spaceRight = stageRight - (x + w);
        int stageLeft = x - spaceRight;
        int stageW = stageRight - stageLeft;
        if (spaceRight >= -2 && stageLeft >= 0 && stageW >= w && stageLeft <= x && y >= 0 && y + h <= ch) {
            int area = stageW * h;
            if (area > best) { best = area; bx = stageLeft; by = y; bw = stageW; bh = h; }
        }
        x = bx; y = by; w = bw; h = bh;
    }

    // 子窗口的位置红果自己会改回去，这里不去动它们。外框跟着侧栏变，画面按手机原尺寸被外框裁切。
    public static void FitChildren(IntPtr parent) {
    }

    public static void NotifyTree(IntPtr hwnd) {
        NotifySize(hwnd);
        EnumChildWindows(hwnd, (child, l) => { NotifySize(child); return true; }, IntPtr.Zero);
    }

    public static void NotifySize(IntPtr hwnd) {
        RECT rect;
        if (!GetClientRect(hwnd, out rect)) return;
        int cw = rect.Right - rect.Left;
        int ch = rect.Bottom - rect.Top;
        if (cw < 1 || ch < 1) return;
        int packed = (cw & 0xFFFF) | ((ch & 0xFFFF) << 16);
        SendMessage(hwnd, 0x0005, IntPtr.Zero, new IntPtr(packed));
    }

    public static int IntegrityRid(uint pid) {
        IntPtr proc = pid == 0 ? GetCurrentProcess() : OpenProcess(0x1000, false, pid);
        if (proc == IntPtr.Zero) return -1;
        IntPtr token;
        if (!OpenProcessToken(proc, 8, out token)) return -1;
        byte[] buf = new byte[256];
        int ret;
        if (!GetTokenInformation(token, 25, buf, buf.Length, out ret)) return -1;
        IntPtr sid = new IntPtr(BitConverter.ToInt64(buf, 0));
        int count = Marshal.ReadByte(sid, 1);
        return Marshal.ReadInt32(sid, 8 + (count - 1) * 4);
    }

    // GW_OWNER = 4。红果是 Qt 顶层窗，会把自己的 owner / 标题栏 / 位置改回去。
    public static bool OwnedBy(IntPtr hwnd, IntPtr owner) {
        return GetWindow(hwnd, 4) == owner;
    }

    public static bool IsPlacedAt(IntPtr hwnd, IntPtr owner, int x, int y, int w, int h) {
        PT origin = new PT(); origin.X = 0; origin.Y = 0;
        ClientToScreen(owner, ref origin);
        RECT rect = new RECT();
        if (!GetWindowRect(hwnd, out rect)) return false;
        int ax = origin.X + x;
        int ay = origin.Y + y;
        return Math.Abs(rect.Left - ax) <= 6 && Math.Abs(rect.Top - ay) <= 6
            && Math.Abs((rect.Right - rect.Left) - w) <= 6
            && Math.Abs((rect.Bottom - rect.Top) - h) <= 6;
    }

    // 明显离开：四边任一偏差超过 slack。小抖动不拉，避免和 Qt 对抢。
    public static bool IsClearlyAway(IntPtr hwnd, IntPtr owner, int x, int y, int w, int h, int slack) {
        PT origin = new PT(); origin.X = 0; origin.Y = 0;
        ClientToScreen(owner, ref origin);
        RECT rect = new RECT();
        if (!GetWindowRect(hwnd, out rect)) return false;
        int ax = origin.X + x;
        int ay = origin.Y + y;
        return Math.Abs(rect.Left - ax) > slack || Math.Abs(rect.Top - ay) > slack
            || Math.Abs((rect.Right - rect.Left) - w) > slack
            || Math.Abs((rect.Bottom - rect.Top) - h) > slack;
    }

    public static bool RestoreByScRestore(IntPtr hwnd) {
        // BitDock 类 Dock 工具会吞掉 ShowWindow/SW_RESTORE；系统的 SC_RESTORE
        // 命令能穿透。
        return PostMessage(hwnd, 0x0112, (IntPtr)0xF120, IntPtr.Zero);
    }
}

// Per-worker waits, without changing the machine-wide timer resolution.
public sealed class OwlMirrorInputWaiter : IDisposable {
    IntPtr timer;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWaitableTimerExW(IntPtr attributes, string name, uint flags, uint access);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetWaitableTimer(IntPtr handle, ref long dueTime, int period, IntPtr callback, IntPtr state, bool resume);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public OwlMirrorInputWaiter() {
        timer = CreateWaitableTimerExW(IntPtr.Zero, null, 2, 0x1F0003);
        if (timer == IntPtr.Zero) timer = CreateWaitableTimerExW(IntPtr.Zero, null, 0, 0x1F0003);
    }
    public void WaitMilliseconds(double milliseconds) {
        if (!(milliseconds > 0) || double.IsInfinity(milliseconds)) return;
        long due = -(long)Math.Ceiling(milliseconds * 10000.0);
        if (timer != IntPtr.Zero && SetWaitableTimer(timer, ref due, 0, IntPtr.Zero, IntPtr.Zero, false)
            && WaitForSingleObject(timer, 0xFFFFFFFF) == 0) return;
        System.Threading.Thread.Sleep((int)Math.Ceiling(milliseconds));
    }
    public void Dispose() {
        if (timer != IntPtr.Zero) { CloseHandle(timer); timer = IntPtr.Zero; }
        GC.SuppressFinalize(this);
    }
    ~OwlMirrorInputWaiter() { Dispose(); }
}
'@
Add-Type -TypeDefinition $user32
# The bridge sends physical pixels. Disable DPI virtualization for native reads
# and moves so Windows display scaling does not apply a second coordinate scale.
[OwlMirrorWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

function Get-WindowRows {
  $rows = New-Object System.Collections.ArrayList
  $cb = [OwlMirrorWin32+EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$l)
    try {
      $title = [OwlMirrorWin32]::GetTitle($h)
      if (-not $title) { return $true }
      $visible = [OwlMirrorWin32]::IsWindowVisible($h)
      # 侧栏不在时红果会被藏起来。藏着的红果也要列出来，否则再打开侧栏会显示「没有找到」。
      $hiddenHongguo = (-not $visible) -and ($title -like '*红果*')
      if (-not $visible -and -not $hiddenHongguo) { return $true }
      if ([OwlMirrorWin32]::IsCloaked($h)) { return $true }
      $procId = 0
      [OwlMirrorWin32]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      $procName = ''
      try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $procName = $proc.ProcessName
      } catch { }
      $iconic = [bool][OwlMirrorWin32]::IsIconic($h)
      # 最小化窗口的客户区是任务栏缩略尺寸，改报窗口矩形（仅作列表展示用；
      # attach 后以实际帧尺寸为准）。藏起来的红果同样没有可用客户区。
      $rect = New-Object OwlMirrorWin32+RECT
      if ($iconic -or -not $visible) {
        [OwlMirrorWin32]::GetWindowRect($h, [ref]$rect) | Out-Null
      } else {
        [OwlMirrorWin32]::GetClientRect($h, [ref]$rect) | Out-Null
      }
      $w = $rect.Right - $rect.Left
      $hh = $rect.Bottom - $rect.Top
      if (-not $iconic -and ($w -lt 80 -or $hh -lt 60)) { return $true }
      [void]$rows.Add(@{
        hwnd = $h.ToInt64(); title = $title; process = $procName
        w = $w; h = $hh; minimized = $iconic
        cls = [OwlMirrorWin32]::GetClassName($h)
      })
    } catch { }
    return $true
  }
  [OwlMirrorWin32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $rows
}

# ---------------------------------------------------------------------------
# capture kernel: compile windows-capture.cs via out-of-proc csc (winmd refs),
# cache by content hash, load bytes.
# ---------------------------------------------------------------------------
function Get-CaptureAssembly {
  $csPath = Join-Path $PSScriptRoot 'windows-capture.cs'
  $csBytes = [IO.File]::ReadAllBytes($csPath)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha.ComputeHash($csBytes)
    $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').Substring(0, 16).ToLower()
  } finally { $sha.Dispose() }

  $cacheDir = Join-Path ([IO.Path]::GetTempPath()) ('owl-mirror-' + $hash)
  $dllPath = Join-Path $cacheDir 'OwlMirror.Capture.dll'
  if (Test-Path $dllPath) {
    return [IO.File]::ReadAllBytes($dllPath)
  }

  $cscCandidates = @(
    (Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  $csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $csc) { throw 'csc.exe (net48) not found' }

  $winmd = Join-Path $env:windir 'System32\WinMetadata'
  $gac = 'C:\Windows\Microsoft.Net\assembly\GAC_MSIL'
  $refs = @(
    (Join-Path $winmd 'Windows.Foundation.winmd'),
    (Join-Path $winmd 'Windows.Graphics.winmd'),
    (Join-Path $winmd 'Windows.UI.winmd'),
    (Join-Path $winmd 'Windows.Storage.winmd'),
    'System.Runtime.WindowsRuntime.dll'
  )
  foreach ($name in @('System.Runtime', 'System.ObjectModel', 'System.Collections')) {
    $dir = Get-ChildItem (Join-Path $gac $name) -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($dir) { $refs += (Join-Path $dir.FullName ($name + '.dll')) }
  }

  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $argList = @('-nologo', '-target:library', ('-out:' + $dllPath), $csPath)
  foreach ($ref in $refs) { $argList += ('-r:' + $ref) }
  $stdout = & $csc @argList 2>&1
  if (-not (Test-Path $dllPath)) {
    $detail = ($stdout | Out-String)
    throw ('capture kernel compile failed: ' + $detail.Substring(0, [Math]::Min(600, $detail.Length)))
  }
  return [IO.File]::ReadAllBytes($dllPath)
}

# ---------------------------------------------------------------------------
# 应用宝 Androws.exe 的清单是 requireAdministrator，窗口在高完整性。
# 桥是普通 node，SetWindowPos / SetWindowLong 会得到 ERROR_ACCESS_DENIED(5)，
# 窗口看起来「嵌入成功」但位置、样式、owner 全部不变。
# 这里留一个提权后的常驻 host（一次 UAC），中完整性 worker 把 embed/move/unembed
# 转给它。host 再拉起的 powershell 继承高完整性，原有命令逻辑不用改。
# ---------------------------------------------------------------------------
$script:ElevatedStatePath = Join-Path ([IO.Path]::GetTempPath()) 'owl-mirror-elevated.json'

function Quote-WinArg([string]$text) {
  if ($text -notmatch '[\s"]') { return $text }
  return '"' + $text.Replace('"', '""') + '"'
}

function Test-ForeignHigh([long]$TargetHwnd) {
  $mine = [OwlMirrorWin32]::IntegrityRid(0)
  if ($mine -ge 0x3000 -or $mine -lt 0) { return $false }
  $procId = [uint32]0
  [OwlMirrorWin32]::GetWindowThreadProcessId([IntPtr]$TargetHwnd, [ref]$procId) | Out-Null
  $theirs = [OwlMirrorWin32]::IntegrityRid($procId)
  return ($theirs -gt $mine)
}

function Read-ElevatedState {
  if (-not (Test-Path $script:ElevatedStatePath)) { return $null }
  try { return (Get-Content $script:ElevatedStatePath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Test-ElevatedHostAlive($info) {
  if (-not $info) { return $false }
  $procId = [int]$info.pid
  if ($procId -le 0) { return $false }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  return ([OwlMirrorWin32]::IntegrityRid([uint32]$procId) -ge 0x3000)
}

function Ensure-ElevatedHost {
  $info = Read-ElevatedState
  if (Test-ElevatedHostAlive $info) { return [int]$info.port }
  Remove-Item $script:ElevatedStatePath -ErrorAction SilentlyContinue
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  try {
    Start-Process -FilePath $ps -Verb RunAs -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, 'host'
    ) | Out-Null
  } catch {
    Write-JsonLine ('{"event":"error","message":"' + (Escape-Json ('应用宝以管理员运行，嵌入需要你在 UAC 点「是」: ' + $_.Exception.Message)) + '"}')
    exit 1
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $info = Read-ElevatedState
    if (Test-ElevatedHostAlive $info) { return [int]$info.port }
  }
  Write-JsonLine '{"event":"error","message":"应用宝以管理员运行。请在 UAC 窗口点「是」，侧栏才能把红果嵌进来。"}'
  exit 1
}

function Get-MirrorArgList {
  $items = @($Command, '-Hwnd', "$Hwnd")
  if ($Command -eq 'embed') {
    $items += @('-ParentHwnd', "$ParentHwnd", '-X', "$X", '-Y', "$Y", '-W', "$W", '-H', "$H")
    if ($SwallowMinimize) { $items += '-SwallowMinimize' }
    if ($Projection) { $items += @('-Projection', '-ControlPath', $ControlPath, '-GeometryId', $GeometryId) }
    if ($HasBaseRect) { $items += @('-HasBaseRect', '-BaseX', "$BaseX", '-BaseY', "$BaseY", '-BaseW', "$BaseW", '-BaseH', "$BaseH", '-BaseParent', "$BaseParent") }
    if ($HasBaseStyle) { $items += @('-HasBaseStyle', '-BaseStyle', "$BaseStyle") }
  } elseif ($Command -eq 'move') {
    $items += @('-X', "$X", '-Y', "$Y", '-W', "$W", '-H', "$H")
  } elseif ($Command -eq 'unembed') {
    $items += @('-Style', "$Style", '-ParentHwnd', "$ParentHwnd")
    if ($ExpectedPid -gt 0) { $items += @('-ExpectedPid', "$ExpectedPid") }
    if ($HasBaseRect) { $items += @('-HasBaseRect', '-X', "$X", '-Y', "$Y", '-W', "$W", '-H', "$H") }
  }
  return $items
}

function Test-TcpClosed($client) {
  try {
    if (-not $client.Connected) { return $true }
    $socket = $client.Client
    return ($socket.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $socket.Available -eq 0)
  } catch { return $true }
}

function Invoke-MirrorPointer([IntPtr]$target, [string]$action, [int]$px, [int]$py, [int]$delta = 0) {
  if ($action -eq 'cancel') {
    if ($script:PointerDown) {
      $position = [IntPtr](($script:PointerY -shl 16) -bor ($script:PointerX -band 0xffff))
      [OwlMirrorWin32]::PostMessage($target, 0x0202, [IntPtr]::Zero, $position) | Out-Null
    }
    $script:PointerDown = $false
    return
  }
  $bounds = New-Object OwlMirrorWin32+RECT
  [OwlMirrorWin32]::GetClientRect($target, [ref]$bounds) | Out-Null
  if ($px -lt 0 -or $py -lt 0 -or $px -ge $bounds.Right -or $py -ge $bounds.Bottom) {
    throw 'Mirror input is outside the app client area'
  }
  $position = [IntPtr](($py -shl 16) -bor ($px -band 0xffff))
  $script:PointerX = $px; $script:PointerY = $py
  switch ($action) {
    'move' {
      $buttons = if ($script:PointerDown) { 1 } else { 0 }
      [OwlMirrorWin32]::PostMessage($target, 0x0200, [IntPtr]$buttons, $position) | Out-Null
    }
    'down' {
      [OwlMirrorWin32]::PostMessage($target, 0x0200, [IntPtr]::Zero, $position) | Out-Null
      [OwlMirrorWin32]::PostMessage($target, 0x0201, [IntPtr]1, $position) | Out-Null
      $script:PointerDown = $true
    }
    'up' {
      [OwlMirrorWin32]::PostMessage($target, 0x0202, [IntPtr]::Zero, $position) | Out-Null
      $script:PointerDown = $false
    }
    'click' {
      [OwlMirrorWin32]::PostMessage($target, 0x0200, [IntPtr]::Zero, $position) | Out-Null
      [OwlMirrorWin32]::PostMessage($target, 0x0201, [IntPtr]1, $position) | Out-Null
      $script:PointerDown = $true
      Start-Sleep -Milliseconds 80
      [OwlMirrorWin32]::PostMessage($target, 0x0202, [IntPtr]::Zero, $position) | Out-Null
      $script:PointerDown = $false
    }
    'wheel' {
      if ($delta -eq 0) { return }
      $point = New-Object OwlMirrorWin32+PT
      $point.X = $px; $point.Y = $py
      [OwlMirrorWin32]::ClientToScreen($target, [ref]$point) | Out-Null
      $wheelPosition = [IntPtr](($point.Y -shl 16) -bor ($point.X -band 0xffff))
      # Keep high-resolution touchpad increments and accumulated wheel distance.
      # WM_MOUSEWHEEL has a signed 16-bit delta; a tiny movement is not a full notch.
      $wheelDelta = -[Math]::Max(-32767, [Math]::Min(32767, $delta))
      [OwlMirrorWin32]::PostMessage($target, 0x020A, [IntPtr](($wheelDelta -band 0xffff) -shl 16), $wheelPosition) | Out-Null
    }
  }
}

function Ensure-MirrorRestoreSurface([IntPtr]$target, $rect) {
  $surface = New-Object OwlMirrorWin32+RECT
  if ([OwlMirrorWin32]::TryAndroidSurface($target, [ref]$surface)) {
    $minimum = [OwlMirrorWin32]::MinimumSurfaceWindowRect($target, $surface)
    $rect.width = [Math]::Max($rect.width, $minimum.Right - $minimum.Left)
    $rect.height = [Math]::Max($rect.height, $minimum.Bottom - $minimum.Top)
  }
  return $rect
}

function Restore-MirrorWindow([IntPtr]$target, [long]$style, [long]$parent, $rect) {
  Invoke-MirrorPointer $target 'cancel' 0 0
  $rect = Ensure-MirrorRestoreSurface $target $rect
  $owner = if ($parent -gt 0 -and [OwlMirrorWin32]::IsWindow([IntPtr]$parent)) { [IntPtr]$parent } else { [IntPtr]::Zero }
  [OwlMirrorWin32]::SetOwner($target, $owner)
  [OwlMirrorWin32]::ClearClip($target)
  [OwlMirrorWin32]::RestoreSystemMenu($target)
  [OwlMirrorWin32]::SetStyle($target, $style)
  [OwlMirrorWin32]::SetWindowPos($target, [IntPtr]::Zero, $rect.x, $rect.y, $rect.width, $rect.height, 0x4 -bor 0x10 -bor 0x20) | Out-Null
  [OwlMirrorWin32]::ShowWindow($target, 4) | Out-Null
}

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
public static class OwlMirrorPump {
  public static void Drain(StreamReader reader) {
    try {
      while (reader.ReadLine() != null) {}
    } catch {}
  }

  public static void CopyUntilDisconnect(Process proc, StreamWriter writer, TcpClient client) {
    var pump = new Thread(() => {
      try {
        string line;
        while ((line = proc.StandardOutput.ReadLine()) != null) {
          lock (writer) writer.WriteLine(line);
        }
      } catch {}
    });
    pump.IsBackground = true;
    pump.Start();
    var err = new Thread(() => Drain(proc.StandardError));
    err.IsBackground = true;
    err.Start();
    while (!proc.HasExited) {
      try {
        var socket = client.Client;
        bool gone = !client.Connected || (socket.Poll(0, SelectMode.SelectRead) && socket.Available == 0);
        if (gone) {
          try { proc.Kill(); } catch {}
          break;
        }
      } catch {
        try { proc.Kill(); } catch {}
        break;
      }
      Thread.Sleep(40);
    }
    pump.Join(2000);
  }
}
'@

function Invoke-ViaElevatedHost {
  $port = Ensure-ElevatedHost
  $client = $null
  foreach ($attempt in 1..25) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $client.Connect('127.0.0.1', $port)
      break
    } catch {
      try { $client.Close() } catch {}
      $client = $null
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $client) {
    Write-JsonLine '{"event":"error","message":"提权宿主已起来，但连不上它。"}'
    exit 1
  }
  $stream = $client.GetStream()
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $writer = New-Object System.IO.StreamWriter($stream, $utf8)
  $writer.NewLine = "`n"
  $writer.AutoFlush = $true
  $payload = @{ cmd = 'run'; args = @(Get-MirrorArgList) } | ConvertTo-Json -Compress
  $writer.WriteLine($payload)
  $reader = New-Object System.IO.StreamReader($stream, $utf8)
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq '') { continue }
    Write-JsonLine $line
  }
}

function Serve-ElevatedClient($client) {
  $stream = $client.GetStream()
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $reader = New-Object System.IO.StreamReader($stream, $utf8)
  $writer = New-Object System.IO.StreamWriter($stream, $utf8)
  $writer.NewLine = "`n"
  $writer.AutoFlush = $true
  $line = $reader.ReadLine()
  if (-not $line) { return }
  $req = $line | ConvertFrom-Json
  if ($req.cmd -eq 'ping') {
    $writer.WriteLine('{"event":"pong"}')
    return
  }
  if ($req.cmd -ne 'run') {
    $writer.WriteLine('{"event":"error","message":"bad host command"}')
    return
  }
  $argItems = @($req.args | ForEach-Object { [string]$_ })
  if (@('embed', 'move', 'unembed') -notcontains $argItems[0]) {
    $writer.WriteLine('{"event":"error","message":"command not allowed"}')
    return
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $joined = ($argItems | ForEach-Object { Quote-WinArg $_ }) -join ' '
  $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File ' + (Quote-WinArg $PSCommandPath) + ' ' + $joined
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = $utf8
  $psi.StandardErrorEncoding = $utf8
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  [OwlMirrorPump]::CopyUntilDisconnect($proc, $writer, $client)
  try { if (-not $proc.HasExited) { $proc.WaitForExit(2000) } } catch {}
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
if ($Command -in @('embed', 'move', 'unembed') -and $Hwnd -gt 0 -and (Test-ForeignHigh $Hwnd)) {
  Invoke-ViaElevatedHost
  exit 0
}

switch ($Command) {

  'guard' {
    # This separate elevated process survives an abrupt bridge/worker kill. A
    # per-window token prevents an old guard from restoring a newer projection.
    try {
      [IO.File]::WriteAllText($GuardMarker + '.ready', 'ready')
      try { $watched = [Diagnostics.Process]::GetProcessById($GuardPid); $watched.WaitForExit() } catch {}
      if (-not (Test-Path -LiteralPath $GuardMarker) -or [IO.File]::ReadAllText($GuardMarker) -ne 'active') { break }
      $target = [IntPtr]$Hwnd
      $leaseLock = [OwlMirrorWin32]::LockProjection($target)
      try {
        $currentPid = [uint32]0
        [OwlMirrorWin32]::GetWindowThreadProcessId($target, [ref]$currentPid) | Out-Null
        if ($currentPid -ne $ExpectedPid -or [OwlMirrorWin32]::GetProp($target, 'OwlMirrorProjectionLease').ToInt64() -ne $GuardToken) { break }
        if ([OwlMirrorWin32]::GetTitle($target) -notlike '*红果*') { break }
        [OwlMirrorWin32]::PostMessage($target, 0x001F, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        [OwlMirrorWin32]::PostMessage($target, 0x0202, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Restore-MirrorWindow $target $Style $ParentHwnd @{ x = $X; y = $Y; width = $W; height = $H }
        [OwlMirrorWin32]::RemoveProp($target, 'OwlMirrorProjectionLease') | Out-Null
      } finally { $leaseLock.ReleaseMutex(); $leaseLock.Dispose() }
    } finally {
      if ($GuardMarker) {
        Remove-Item -LiteralPath $GuardMarker -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ($GuardMarker + '.ready') -ErrorAction SilentlyContinue
      }
    }
  }


  'host' {
    $mutex = New-Object System.Threading.Mutex($false, 'Local\OwlMirrorElevatedHost')
    if (-not $mutex.WaitOne(0)) { exit 0 }
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    @{ pid = $PID; port = $port } | ConvertTo-Json -Compress | Set-Content -Path $script:ElevatedStatePath -Encoding ASCII
    while ($true) {
      $client = $listener.AcceptTcpClient()
      try { Serve-ElevatedClient $client } catch { }
      try { $client.Close() } catch { }
    }
  }

  'list' {
    foreach ($row in (Get-WindowRows)) {
      $json = '{"event":"window","hwnd":' + $row.hwnd +
        ',"title":"' + (Escape-Json $row.title) +
        '","process":"' + (Escape-Json $row.process) +
        '","w":' + $row.w + ',"h":' + $row.h +
        ',"minimized":' + ($row.minimized.ToString().ToLower()) +
        ',"class":"' + (Escape-Json $row.cls) + '"}'
      Write-JsonLine $json
    }
    Write-JsonLine '{"event":"ready"}'
  }

  'restore' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $ok = [OwlMirrorWin32]::RestoreByScRestore([IntPtr]$Hwnd)
    Write-JsonLine ('{"event":"restored","ok":' + ($ok.ToString().ToLower()) + '}')
    Write-JsonLine '{"event":"ready"}'
  }

  'launch' {
    # 应用宝电脑版: registry uninstall entry -> DisplayIcon path -> sibling launcher
    $paths = @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $entry = $null
    foreach ($path in $paths) {
      $hit = Get-ItemProperty $path -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq '腾讯应用宝' } |
        Select-Object -First 1
      if ($hit) { $entry = $hit; break }
    }
    if (-not $entry -or -not $entry.DisplayIcon) {
      Write-JsonLine '{"event":"error","message":"Androws (YingYongBao PC) not found in registry"}'
      exit 1
    }
    $iconPath = ($entry.DisplayIcon -split ',')[0].Trim()
    $dir = Split-Path -Parent $iconPath
    $launcher = Join-Path $dir 'AndrowsLauncher.exe'
    if (Test-Path $launcher) {
      # 与红果桌面快捷方式一致：直接按包名拉起红果，跳过应用宝商店。
      Start-Process -FilePath $launcher -WorkingDirectory $dir -ArgumentList @('--from', '2', '--launch-pkg-name', 'com.phoenix.read', '--launch-proc-name', 'Androws.exe')
      Write-JsonLine '{"event":"launched","how":"launcher"}'
    } elseif (Test-Path $iconPath) {
      Start-Process -FilePath $iconPath -WorkingDirectory $dir
      Write-JsonLine '{"event":"launched","how":"displayicon"}'
    } else {
      Write-JsonLine '{"event":"error","message":"launcher exe not found: ' + (Escape-Json $launcher) + '"}'
      exit 1
    }
    Write-JsonLine '{"event":"ready"}'
  }

  'capture' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $hwndPtr = [IntPtr]$Hwnd

    if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
      [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
      Start-Sleep -Milliseconds 900
    }
    if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
      Write-JsonLine '{"event":"error","message":"window is minimized and could not be restored"}'
      exit 1
    }

    $asmBytes = Get-CaptureAssembly
    [void][System.Reflection.Assembly]::Load([byte[]]$asmBytes)
    $session = [OwlMirror.CaptureSession]::Start($hwndPtr)
    Write-JsonLine '{"event":"status","iconic":false,"autoRestored":0,"frameSeq":0}'

    $lastIconic = $false
    $lastStatusTick = [System.Diagnostics.Stopwatch]::StartNew()

    while ($true) {
      try {
        $iconic = [OwlMirrorWin32]::IsIconic($hwndPtr)
        if ($iconic -ne $lastIconic -or $lastStatusTick.ElapsedMilliseconds -gt 5000) {
          $lastIconic = $iconic
          $lastStatusTick.Restart()
          Write-JsonLine ('{"event":"status","iconic":' + ($iconic.ToString().ToLower()) + ',"autoRestored":' + $script:AutoRestored + ',"frameSeq":' + $session.FrameSeq + '}')
        }
        if ($iconic) {
          if (-not $NoAutoRestore) {
            # BitDock 等停靠工具会把后台窗口收纳成最小化；SC_RESTORE 拉回来继续抓
            [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
            $script:AutoRestored++
            Write-JsonLine ('{"event":"status","iconic":false,"autoRestored":' + $script:AutoRestored + ',"frameSeq":' + $session.FrameSeq + ',"autoRestore":true}')
          }
          Start-Sleep -Milliseconds 600
          continue
        }

        $w = 0; $h = 0
        $jpeg = $session.GrabFrameJpeg($FrameTimeoutMs, $Quality, $MaxWidth, [ref]$w, [ref]$h)
        if ($jpeg) {
          $b64 = [Convert]::ToBase64String($jpeg)
          $diagnostics = if ($CaptureDiagnostics) {
            ',"copyMs":' + $session.LastCopyMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture) + ',"encodeMs":' + $session.LastEncodeMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)
          } else { '' }
          Write-JsonLine ('{"event":"frame","seq":' + $session.FrameSeq + ',"w":' + $w + ',"h":' + $h + $diagnostics + ',"data":"' + $b64 + '"}')
        }
        $session.WaitForNextFrame($Fps)
      } catch {
        Write-JsonLine ('{"event":"error","message":"' + (Escape-Json $_.Exception.Message) + '"}')
        try { $session.Dispose() } catch { }
        exit 1
      }
    }
  }

  'movewin' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $hwndPtr = [IntPtr]$Hwnd
    # X/Y 传 -99999 表示保持原位（只调尺寸）；W/H 同理传 -99999 保持原值
    $rect = New-Object OwlMirrorWin32+RECT
    [OwlMirrorWin32]::GetWindowRect($hwndPtr, [ref]$rect) | Out-Null
    $nx = if ($X -le -99999) { $rect.Left } else { $X }
    $ny = if ($Y -le -99999) { $rect.Top } else { $Y }
    $nw = if ($W -le -99999) { $rect.Right - $rect.Left } else { $W }
    $nh = if ($H -le -99999) { $rect.Bottom - $rect.Top } else { $H }
    # SWP_NOZORDER(0x4)
    [OwlMirrorWin32]::SetWindowPos($hwndPtr, [IntPtr]::Zero, $nx, $ny, $nw, $nh, 0x4) | Out-Null
    Write-JsonLine '{"event":"moved"}'
    Write-JsonLine '{"event":"ready"}'
  }
  'clientorigin' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $hwndPtr = [IntPtr]$Hwnd
    $pt = New-Object OwlMirrorWin32+PT
    $pt.X = 0; $pt.Y = 0
    [OwlMirrorWin32]::ClientToScreen($hwndPtr, [ref]$pt) | Out-Null
    Write-JsonLine ('{"event":"clientorigin","x":' + $pt.X + ',"y":' + $pt.Y + '}')
    Write-JsonLine '{"event":"ready"}'
  }
  'probe' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $hwndPtr = [IntPtr]$Hwnd
    $rect = New-Object OwlMirrorWin32+RECT
    [OwlMirrorWin32]::GetWindowRect($hwndPtr, [ref]$rect) | Out-Null
    $json = '{"event":"probe","parent":' + [OwlMirrorWin32]::GetParent($hwndPtr).ToInt64() +
      ',"style":' + [OwlMirrorWin32]::GetStyle($hwndPtr) +
      ',"x":' + $rect.Left + ',"y":' + $rect.Top +
      ',"w":' + ($rect.Right - $rect.Left) + ',"h":' + ($rect.Bottom - $rect.Top) +
      ',"visible":' + ([OwlMirrorWin32]::IsWindowVisible($hwndPtr)).ToString().ToLower() +
      ',"iconic":' + ([OwlMirrorWin32]::IsIconic($hwndPtr)).ToString().ToLower() + '}'
    Write-JsonLine $json
    Write-JsonLine '{"event":"ready"}'
  }

  'embed' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    if (-not $PSBoundParameters.ContainsKey('ParentHwnd') -or $ParentHwnd -le 0) {
      Write-JsonLine '{"event":"error","message":"missing -ParentHwnd"}'; exit 1
    }
    $hwndPtr = [IntPtr]$Hwnd
    $parentPtr = [IntPtr]$ParentHwnd
    if ($Projection) {
      $targetPid = [uint32]0
      [OwlMirrorWin32]::GetWindowThreadProcessId($hwndPtr, [ref]$targetPid) | Out-Null
      $targetProcess = Get-Process -Id $targetPid -ErrorAction Stop
      if ($targetProcess.ProcessName -ne 'Androws' -or [OwlMirrorWin32]::GetTitle($hwndPtr) -notlike '*红果*' -or -not $ControlPath -or -not $GeometryId) {
        throw 'Projection requires a Hongguo window and a session control channel'
      }
    }

    # 被收起时先拉一次再摆。摆进去之后不改样式、不裁标题，标题栏留在窗口里。
    if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
      [OwlMirrorWin32]::ShowWindow($hwndPtr, 9) | Out-Null
      [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
      Start-Sleep -Milliseconds 200
    }

    $originalStyle = if ($HasBaseStyle) { $BaseStyle } else { [OwlMirrorWin32]::GetStyle($hwndPtr) }
    $originalParent = if ($HasBaseRect) { $BaseParent } else { [OwlMirrorWin32]::GetParent($hwndPtr).ToInt64() }
    $before = New-Object OwlMirrorWin32+RECT
    [OwlMirrorWin32]::GetWindowRect($hwndPtr, [ref]$before) | Out-Null
    $originalRect = if ($HasBaseRect) {
      @{ x = $BaseX; y = $BaseY; width = $BaseW; height = $BaseH }
    } else {
      @{ x = $before.Left; y = $before.Top; width = $before.Right - $before.Left; height = $before.Bottom - $before.Top }
    }
    if ($Projection) {
      $before.Left = $originalRect.x; $before.Top = $originalRect.y
      $before.Right = $before.Left + $originalRect.width; $before.Bottom = $before.Top + $originalRect.height
      $before = [OwlMirrorWin32]::VisibleRestoreRect($before, $parentPtr)
      $originalRect = @{ x = $before.Left; y = $before.Top; width = $before.Right - $before.Left; height = $before.Bottom - $before.Top }
      $originalRect = Ensure-MirrorRestoreSurface $hwndPtr $originalRect
    }
    $geometry = $null
    $clientOffset = $null
    $controlReader = $null
    $script:PointerDown = $false
    $script:PointerX = 0; $script:PointerY = 0
    if ($Projection) {
      Write-JsonLine (@{ event = 'prepared'; originalStyle = $originalStyle; originalParent = $originalParent; originalRect = $originalRect; originalProcessId = $targetPid } | ConvertTo-Json -Depth 4 -Compress)
    }
    if (-not $Projection) {
      [OwlMirrorWin32]::ClearClip($hwndPtr)
      [OwlMirrorWin32]::SetOwner($hwndPtr, $parentPtr)
    }
    $ownerShown = [OwlMirrorWin32]::StageInsideOwner($parentPtr, $X, $Y, $W, $H)
    if ($Projection) {
      $controlStream = [IO.File]::Open($ControlPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $controlReader = New-Object IO.StreamReader($controlStream, $Utf8NoBom)
      $controlBuffer = ''
      $leasePath = $ControlPath + '.lease'
      [IO.File]::WriteAllText($leasePath, 'active')
      $leaseToken = [BitConverter]::ToInt32([Guid]::NewGuid().ToByteArray(), 0) -band 0x7fffffff
      $guardArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, 'guard', '-Hwnd', "$Hwnd", '-GuardPid', "$PID", '-GuardToken', "$leaseToken", '-GuardMarker', $leasePath, '-ExpectedPid', "$targetPid", '-Style', "$originalStyle", '-ParentHwnd', "$originalParent", '-X', "$($originalRect.x)", '-Y', "$($originalRect.y)", '-W', "$($originalRect.width)", '-H', "$($originalRect.height)")
      $guardCommand = ($guardArgs | ForEach-Object { Quote-WinArg $_ }) -join ' '
      $guard = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $guardCommand -WindowStyle Hidden -PassThru
      $guardDeadline = [DateTime]::UtcNow.AddSeconds(5)
      while (-not (Test-Path -LiteralPath ($leasePath + '.ready'))) {
        if ($guard.HasExited -or [DateTime]::UtcNow -gt $guardDeadline) { throw 'Projection recovery guard did not start' }
        Start-Sleep -Milliseconds 20
      }
      $leaseLock = [OwlMirrorWin32]::LockProjection($hwndPtr)
      try {
      if (-not [OwlMirrorWin32]::SetProp($hwndPtr, 'OwlMirrorProjectionLease', [IntPtr]$leaseToken)) {
        throw 'Projection recovery lease was rejected'
      }
      [OwlMirrorWin32]::ClearClip($hwndPtr)
      [OwlMirrorWin32]::SetOwner($hwndPtr, $parentPtr)
      # The VM child can be larger than a programmatically resized Qt host.
      # Preserve its real surface; the old profile is only a no-VM fallback.
      $scale = [Math]::Max(96, [OwlMirrorWin32]::GetDpiForWindow($hwndPtr)) / 96.0
      $vmSurface = New-Object OwlMirrorWin32+RECT
      $hasVmSurface = [OwlMirrorWin32]::TryAndroidSurface($hwndPtr, [ref]$vmSurface)
      if ($hasVmSurface) {
        $required = [OwlMirrorWin32]::RequiredSurfaceWindowRect($hwndPtr, $vmSurface)
        $W = $required.Right - $required.Left; $H = $required.Bottom - $required.Top
      } else {
        $W = [int][Math]::Round(906 * $scale); $H = [int][Math]::Round(547 * $scale)
      }
      $placeErr = [OwlMirrorWin32]::PlaceOwned($hwndPtr, $parentPtr, -20000, -20000, $W, $H, $true)
      if ($placeErr -ne 0) { throw "Projection placement failed: $placeErr" }
      [OwlMirrorWin32]::ShowWindow($hwndPtr, 4) | Out-Null
      $surfaceSettled = -not $hasVmSurface
      $previousSurface = ''
      for ($attempt = 0; $hasVmSurface -and $attempt -lt 3; $attempt++) {
        if ([OwlMirrorWin32]::TryAndroidSurface($hwndPtr, [ref]$vmSurface)) {
          $required = [OwlMirrorWin32]::RequiredSurfaceWindowRect($hwndPtr, $vmSurface)
          $requiredW = $required.Right - $required.Left; $requiredH = $required.Bottom - $required.Top
          $surfaceKey = ($vmSurface.Left - $required.Left).ToString() + ',' + ($vmSurface.Top - $required.Top) + ',' + ($vmSurface.Right - $vmSurface.Left) + ',' + ($vmSurface.Bottom - $vmSurface.Top)
          if ($requiredW -le $W -and $requiredH -le $H -and $surfaceKey -eq $previousSurface) {
            $surfaceSettled = $true
            break
          }
          $previousSurface = $surfaceKey
          if ($requiredW -gt $W -or $requiredH -gt $H) {
            $W = [Math]::Max($W, $requiredW); $H = [Math]::Max($H, $requiredH)
            $placeErr = [OwlMirrorWin32]::PlaceOwned($hwndPtr, $parentPtr, -20000, -20000, $W, $H, $true)
            if ($placeErr -ne 0) { throw "Projection placement failed: $placeErr" }
          }
        }
        if ($attempt -lt 2) { Start-Sleep -Milliseconds 16 }
      }
      if (-not $surfaceSettled) { throw 'Android surface layout did not settle after resizing its host' }
      $projectionBounds = [OwlMirrorWin32]::ReadProjectionBounds($hwndPtr, $scale)
      $frame = $projectionBounds.Capture
      $crop = $projectionBounds.Crop
      $geometry = @{
        geometryId = $GeometryId; sourceWidth = $frame.Right - $frame.Left; sourceHeight = $frame.Bottom - $frame.Top
        crop = @{ x = $crop.Left; y = $crop.Top; width = $crop.Right - $crop.Left; height = $crop.Bottom - $crop.Top }
      }
      $clientOffset = @{ x = $projectionBounds.ClientOffset.X; y = $projectionBounds.ClientOffset.Y }
      } finally { $leaseLock.ReleaseMutex(); $leaseLock.Dispose() }
    } elseif ($ownerShown) {
      $placeErr = [OwlMirrorWin32]::PlaceStage($hwndPtr, $parentPtr, $X, $Y, $W, $H)
      if ($placeErr -ne 0) {
        Write-JsonLine ('{"event":"error","message":"SetWindowPos failed (' + $placeErr + '). 红果窗口拒绝被移动。"}')
        exit 1
      }
      [OwlMirrorWin32]::ShowWindow($hwndPtr, 5) | Out-Null   # SW_SHOW
    } else {
      [OwlMirrorWin32]::ShowWindow($hwndPtr, 0) | Out-Null   # SW_HIDE，Owl 不在屏幕上时不要摆到桌面
    }
    Write-JsonLine (@{ event = 'embedded'; originalStyle = $originalStyle; originalParent = $originalParent; originalRect = $originalRect; originalProcessId = $targetPid; geometry = $geometry; clientOffset = $clientOffset } | ConvertTo-Json -Depth 5 -Compress)

    # 看守只做三件事：侧栏矩形变了就跟着摆；窗口被最小化就拉回再摆；
    # 离开目标矩形就下一拍拉回。宽高为 0 表示舞台不可见，只隐藏，不拉回来。
    # 已经对准舞台时这一拍什么都不做。owl 自己最小化时不拉。
    $lastRect = @{ X = $X; Y = $Y; W = $W; H = $H }
    $autoRestored = 0
    $lastStatusTick = [System.Diagnostics.Stopwatch]::StartNew()
    $inputWaiter = New-Object OwlMirrorInputWaiter
        $layoutSeen = ''
        while ($true) {
          # Poll continuous gestures promptly; Start-Sleep rounds short waits up.
          $inputWaiter.WaitMilliseconds($(if ($Projection) { 8 } else { 16 }))
          try {
            if (-not [OwlMirrorWin32]::IsWindow($hwndPtr)) { exit 0 }
            if ($Projection) {
              $currentPid = [uint32]0
              [OwlMirrorWin32]::GetWindowThreadProcessId($hwndPtr, [ref]$currentPid) | Out-Null
              if ($currentPid -ne $targetPid -or [OwlMirrorWin32]::GetTitle($hwndPtr) -notlike '*红果*') { exit 0 }
            }
            if (-not [OwlMirrorWin32]::IsWindow($parentPtr)) {
              if ($Projection) {
                $leaseLock = [OwlMirrorWin32]::LockProjection($hwndPtr)
                try {
                  if ([OwlMirrorWin32]::GetProp($hwndPtr, 'OwlMirrorProjectionLease').ToInt64() -eq $leaseToken) {
                    Restore-MirrorWindow $hwndPtr $originalStyle $originalParent $originalRect
                    [OwlMirrorWin32]::RemoveProp($hwndPtr, 'OwlMirrorProjectionLease') | Out-Null
                  }
                  [IO.File]::WriteAllText($leasePath, 'restored')
                } finally { $leaseLock.ReleaseMutex(); $leaseLock.Dispose() }
              }
              exit 0
            }
            if ($Projection) {
              $ownerActive = [OwlMirrorWin32]::IsWindowVisible($parentPtr) -and -not [OwlMirrorWin32]::IsIconic($parentPtr)
              $controlBuffer += $controlReader.ReadToEnd()
              $readCount = 0
              while ($controlBuffer.Contains("`n") -and $readCount -lt 128) {
                $newline = $controlBuffer.IndexOf("`n")
                $controlLine = $controlBuffer.Substring(0, $newline)
                $controlBuffer = $controlBuffer.Substring($newline + 1)
                $readCount++
                try { $input = $controlLine | ConvertFrom-Json } catch { continue }
                if ($input.token -ne $GeometryId) { continue }
                if ($input.action -eq 'stop') {
                  $leaseLock = [OwlMirrorWin32]::LockProjection($hwndPtr)
                  try {
                    if ([OwlMirrorWin32]::GetProp($hwndPtr, 'OwlMirrorProjectionLease').ToInt64() -eq $leaseToken) {
                      Invoke-MirrorPointer $hwndPtr 'cancel' 0 0
                      [OwlMirrorWin32]::ShowWindow($hwndPtr, 0) | Out-Null
                      [OwlMirrorWin32]::RemoveProp($hwndPtr, 'OwlMirrorProjectionLease') | Out-Null
                    }
                    [IO.File]::WriteAllText($leasePath, 'stopped')
                  } finally { $leaseLock.ReleaseMutex(); $leaseLock.Dispose() }
                  $controlReader.Dispose()
                  Write-JsonLine '{"event":"stopped"}'
                  exit 0
                }
                if ($input.action -eq 'cancel' -or $ownerActive) {
                  Invoke-MirrorPointer $hwndPtr $input.action ([int]$input.x) ([int]$input.y) ([int]$input.deltaY)
                }
              }
              if ($ownerActive) {
                if (-not [OwlMirrorWin32]::IsPlacedAt($hwndPtr, $parentPtr, -20000, -20000, $W, $H)) {
                  [OwlMirrorWin32]::PlaceOwned($hwndPtr, $parentPtr, -20000, -20000, $W, $H, $true) | Out-Null
                }
                if (-not [OwlMirrorWin32]::IsWindowVisible($hwndPtr)) { [OwlMirrorWin32]::ShowWindow($hwndPtr, 4) | Out-Null }
              } else {
                Invoke-MirrorPointer $hwndPtr 'cancel' 0 0
                [OwlMirrorWin32]::ShowWindow($hwndPtr, 0) | Out-Null
              }
              continue
            }
            if ([OwlMirrorWin32]::IsIconic($parentPtr)) { continue }
            $layoutFile = Join-Path ([IO.Path]::GetTempPath()) ("owl-mirror-layout-" + $Hwnd + ".txt")
            if (Test-Path -LiteralPath $layoutFile) {
              try {
                $text = [IO.File]::ReadAllText($layoutFile).Trim()
                if ($text -ne $layoutSeen) {
                  $layoutSeen = $text
                  $parts = $text.Split(',')
                  if ($parts.Length -ge 4) {
                    $lx = [int]$parts[0]; $ly = [int]$parts[1]; $lw = [int]$parts[2]; $lh = [int]$parts[3]
                    # 宽或高小于 80 表示舞台不可见：藏起窗口，不要沿用上一次的矩形。
                    if ($lw -lt 80 -or $lh -lt 80) {
                      $lastRect.X = 0; $lastRect.Y = 0; $lastRect.W = 0; $lastRect.H = 0
                    } else {
                      $lastRect.X = $lx; $lastRect.Y = $ly; $lastRect.W = $lw; $lastRect.H = $lh
                    }
                  }
                }
              } catch {}
            } elseif ($layoutSeen -ne 'missing') {
              # 侧栏收起时界面会删掉这个文件。文件没了就不能继续用上一次的位置。
              $layoutSeen = 'missing'
              $lastRect.X = 0; $lastRect.Y = 0; $lastRect.W = 0; $lastRect.H = 0
            }
        if ($lastRect.W -lt 80 -or $lastRect.H -lt 80 -or -not [OwlMirrorWin32]::StageInsideOwner($parentPtr, $lastRect.X, $lastRect.Y, $lastRect.W, $lastRect.H)) {
          if ([OwlMirrorWin32]::IsWindowVisible($hwndPtr)) {
            [OwlMirrorWin32]::ShowWindow($hwndPtr, 0) | Out-Null # SW_HIDE
          }
          continue
        }
        $iconic = [OwlMirrorWin32]::IsIconic($hwndPtr) -or -not [OwlMirrorWin32]::IsWindowVisible($hwndPtr)
        $ownerLost = -not [OwlMirrorWin32]::OwnedBy($hwndPtr, $parentPtr)
        if ($iconic) {
          [OwlMirrorWin32]::ShowWindow($hwndPtr, 9) | Out-Null
          if ([OwlMirrorWin32]::IsIconic($hwndPtr)) {
            [OwlMirrorWin32]::RestoreByScRestore($hwndPtr) | Out-Null
          }
          $autoRestored++
        }
        if ($ownerLost) {
          [OwlMirrorWin32]::SetOwner($hwndPtr, $parentPtr)
        }
        [OwlMirrorWin32]::ActivateIfPressed($hwndPtr, $parentPtr)
        [OwlMirrorWin32]::PlaceStage($hwndPtr, $parentPtr, $lastRect.X, $lastRect.Y, $lastRect.W, $lastRect.H) | Out-Null
        if ($lastStatusTick.ElapsedMilliseconds -gt 5000) {
          $lastStatusTick.Restart()
          Write-JsonLine ('{"event":"status","iconic":false,"autoRestored":' + $autoRestored + ',"frameSeq":0}')
        }
      } catch {
        # 这一拍失败就等下一拍。退出的话侧栏再也不会把窗口拉回来。
      }
    }
  }

  'move' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $hwndPtr = [IntPtr]$Hwnd
    [OwlMirrorWin32]::ApplyBounds($hwndPtr, $X, $Y, $W, $H)
    [OwlMirrorWin32]::ShowWindow($hwndPtr, 5) | Out-Null   # SW_SHOW
    Write-JsonLine '{"event":"moved"}'
    Write-JsonLine '{"event":"ready"}'
  }

  'unembed' {
    if ($Hwnd -le 0) { Write-JsonLine '{"event":"error","message":"missing -Hwnd"}'; exit 1 }
    $hwndPtr = [IntPtr]$Hwnd
    if ($ExpectedPid -gt 0) {
      $currentPid = [uint32]0
      [OwlMirrorWin32]::GetWindowThreadProcessId($hwndPtr, [ref]$currentPid) | Out-Null
      if ($currentPid -ne $ExpectedPid -or [OwlMirrorWin32]::GetTitle($hwndPtr) -notlike '*红果*') {
        Write-JsonLine '{"event":"unembedded","gone":true}'
        Write-JsonLine '{"event":"ready"}'
        break
      }
    }
    if ($HasBaseRect) {
      Restore-MirrorWindow $hwndPtr $Style $ParentHwnd @{ x = $X; y = $Y; width = $W; height = $H }
      Write-JsonLine '{"event":"unembedded"}'
      Write-JsonLine '{"event":"ready"}'
      break
    }
    # 还原顺序：先解除 owner、恢复系统菜单，再还原样式，最后通知框架重算并显示
    [OwlMirrorWin32]::SetOwner($hwndPtr, [IntPtr]$ParentHwnd)
    [OwlMirrorWin32]::ClearClip($hwndPtr)
    [OwlMirrorWin32]::RestoreSystemMenu($hwndPtr)
    if ($Style -ge 0) {
      [OwlMirrorWin32]::SetStyle($hwndPtr, $Style)
    } else {
      # 丢过元数据（桥重启）的兜底：恢复标准可调窗口样式
      [OwlMirrorWin32]::SetStyle($hwndPtr, 0x00CF0000L)
    }
    [OwlMirrorWin32]::SetWindowPos($hwndPtr, [IntPtr]::Zero, 0, 0, 0, 0, 0x4 -bor 0x1 -bor 0x2 -bor 0x20)  # NOZORDER|NOMOVE|NOSIZE|FRAMECHANGED
    [OwlMirrorWin32]::ShowWindow($hwndPtr, 9) | Out-Null   # SW_RESTORE
    Write-JsonLine '{"event":"unembedded"}'
    Write-JsonLine '{"event":"ready"}'
  }
}
