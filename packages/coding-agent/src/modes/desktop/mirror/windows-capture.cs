// owl 窗口镜像捕获内核：Windows.Graphics.Capture 会话 + WinRT JPEG 编帧。
//
// 编译：由 windows-capture.ps1 用进程外 csc（net48 in-box，C#5）带系统 winmd
// 引用编成 DLL 后字节加载。保持 C#5 语法（无字符串内插 / 无 unsafe / 无 null
// 条件）。
//
// 本机（build 26200）System32\WinMetadata 里的 winmd 是精简版，若干常规成员
// 不存在（GraphicsCaptureItem.IsSupported / SoftwareBitmap.GetPixelDataAsync /
// GraphicsCaptureSession.Close），框架的 WindowsRuntimeBufferExtensions 又绑定
// 旧聚合 Windows.winmd —— 因此取 item 用 Win11 的 TryCreateFromWindowId，像素
// 出口用 BitmapEncoder（WinRT 自带 JPEG 编码 + BitmapTransform 缩放），全程只
// 依赖投影成员，不做任何 COM 接口强转。
using System;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace OwlMirror
{
    public sealed class CaptureSession : IDisposable
    {
        private Direct3D11CaptureFramePool _framePool;
        private GraphicsCaptureSession _session;
        private int _frameSeq;

        private CaptureSession()
        {
        }

        public int FrameSeq
        {
            get { return Thread.VolatileRead(ref _frameSeq); }
        }

        /// <summary>启动对一个窗口的捕获。hwnd 必须是已恢复的顶层窗口（最小化抓不了）。</summary>
        public static CaptureSession Start(IntPtr hwnd)
        {
            var windowId = new Windows.UI.WindowId();
            windowId.Value = (ulong)hwnd.ToInt64();
            var item = GraphicsCaptureItem.TryCreateFromWindowId(windowId);
            if (item == null) throw new Exception("TryCreateFromWindowId returned null");

            var device = (IDirect3DDevice)CreateDirect3DDevice();

            var session = new CaptureSession();
            var size = new SizeInt32();
            size.Width = item.Size.Width;
            size.Height = item.Size.Height;
            if (size.Width <= 0 || size.Height <= 0) throw new Exception("capture item has empty size");

            session._framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
            session._session = session._framePool.CreateCaptureSession(item);
            try { session._session.IsCursorCaptureEnabled = false; }
            catch { }
            try { session._session.IsBorderRequired = false; }
            catch { /* 需要更高版本/权限，失败不致命 */ }
            session._session.StartCapture();
            return session;
        }

        private static object CreateDirect3DDevice()
        {
            IntPtr d3d, featureLevel, context;
            // 1 = D3D_DRIVER_TYPE_HARDWARE，5 = WARP 兜底；0x20 = BGRA_SUPPORT
            int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7,
                out d3d, out featureLevel, out context);
            if (hr != 0)
            {
                hr = D3D11CreateDevice(IntPtr.Zero, 5, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7,
                    out d3d, out featureLevel, out context);
                if (hr != 0) throw new Exception("D3D11CreateDevice hr=0x" + hr.ToString("X"));
            }
            Guid dxgiIid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            IntPtr dxgi;
            hr = Marshal.QueryInterface(d3d, ref dxgiIid, out dxgi);
            if (hr != 0) throw new Exception("QI IDXGIDevice hr=0x" + hr.ToString("X"));
            try
            {
                object device;
                CreateDirect3D11DeviceFromDXGIDevice(dxgi, out device);
                return device;
            }
            finally { Marshal.Release(dxgi); }
        }

        [DllImport("d3d11.dll")]
        private static extern int D3D11CreateDevice(
            IntPtr adapter, uint driverType, IntPtr software, uint flags,
            IntPtr featureLevels, uint numLevels, uint sdkVersion,
            out IntPtr device, out IntPtr featureLevel, out IntPtr context);

        [DllImport("d3d11.dll", PreserveSig = false)]
        private static extern void CreateDirect3D11DeviceFromDXGIDevice(
            IntPtr dxgiDevice, [MarshalAs(UnmanagedType.Interface)] out object graphicsDevice);

        /// <summary>
        /// 抓一帧并编码为 JPEG。最多等 timeoutMs；无新帧返回 null（不重发上一帧，
        /// 由调用方决定画面保持策略）。width/height 回传编码帧尺寸。
        /// </summary>
        public byte[] GrabFrameJpeg(int timeoutMs, int quality, int maxWidth, out int width, out int height)
        {
            width = 0; height = 0;
            var deadline = Environment.TickCount + timeoutMs;
            Direct3D11CaptureFrame frame = null;
            while (Environment.TickCount < deadline)
            {
                frame = _framePool.TryGetNextFrame();
                if (frame != null) break;
                Thread.Sleep(4);
            }
            if (frame == null) return null;
            try
            {
                Interlocked.Increment(ref _frameSeq);
                int fw = frame.ContentSize.Width;
                int fh = frame.ContentSize.Height;
                if (fw <= 0 || fh <= 0) return null;
                var software = CopyToSoftwareBitmap(frame.Surface);
                try
                {
                    return EncodeJpeg(software, quality, maxWidth, ref width, ref height);
                }
                finally { software.Dispose(); }
            }
            finally { frame.Dispose(); }
        }

        private static SoftwareBitmap CopyToSoftwareBitmap(IDirect3DSurface surface)
        {
            var op = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface);
            return AwaitSoft(op);
        }

        private static byte[] EncodeJpeg(SoftwareBitmap software, int quality, int maxWidth, ref int width, ref int height)
        {
            int sw = software.PixelWidth, sh = software.PixelHeight;
            double scale = maxWidth > 0 && sw > maxWidth ? (double)maxWidth / sw : 1.0;
            int dw = Math.Max(1, (int)Math.Round(sw * scale));
            int dh = Math.Max(1, (int)Math.Round(sh * scale));
            width = dw; height = dh;

            var stream = new InMemoryRandomAccessStream();
            try
            {
                var createOp = BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream);
                var encoder = AwaitEncoder(createOp);
                encoder.SetSoftwareBitmap(software);
                // 本投影的 BitmapTransform 只读（缩放走不了），按原尺寸编码；
                // 红果窗口是 560x959 竖屏小窗，native 尺寸可接受
                width = sw; height = sh;
                AwaitAction(encoder.FlushAsync());

                ulong size = stream.Size;
                if (size == 0) throw new Exception("encoder produced empty stream");
                var reader = new DataReader(stream.GetInputStreamAt(0));
                try
                {
                    var loadOp = reader.LoadAsync((uint)size);
                    uint read = AwaitLoad(loadOp);
                    if (read != (uint)size) throw new Exception("stream read incomplete");
                    var bytes = new byte[(int)size];
                    reader.ReadBytes(bytes);
                    return bytes;
                }
                finally { ((IDisposable)reader).Dispose(); }
            }
            finally { stream.Dispose(); }
        }

        private static SoftwareBitmap AwaitSoft(IAsyncOperation<SoftwareBitmap> op)
        {
            var deadline = Environment.TickCount + 5000;
            while (op.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (SoftwareBitmap)");
                Thread.Sleep(2);
            }
            if (op.Status != AsyncStatus.Completed) throw new Exception("SoftwareBitmap copy failed: " + op.Status);
            return op.GetResults();
        }

        private static BitmapEncoder AwaitEncoder(IAsyncOperation<BitmapEncoder> op)
        {
            var deadline = Environment.TickCount + 5000;
            while (op.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (BitmapEncoder)");
                Thread.Sleep(2);
            }
            if (op.Status != AsyncStatus.Completed) throw new Exception("BitmapEncoder create failed: " + op.Status);
            return op.GetResults();
        }

        private static void AwaitAction(IAsyncAction action)
        {
            var deadline = Environment.TickCount + 5000;
            while (action.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (Flush)");
                Thread.Sleep(2);
            }
            if (action.Status != AsyncStatus.Completed) throw new Exception("Flush failed: " + action.Status);
        }

        private static uint AwaitLoad(IAsyncOperation<uint> op)
        {
            var deadline = Environment.TickCount + 5000;
            while (op.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (Load)");
                Thread.Sleep(2);
            }
            if (op.Status != AsyncStatus.Completed) throw new Exception("Load failed: " + op.Status);
            return op.GetResults();
        }

        public void Dispose()
        {
            try { if (_session != null) ((IDisposable)_session).Dispose(); } catch { }
            try { if (_framePool != null) _framePool.Dispose(); } catch { }
            _session = null;
            _framePool = null;
        }
    }
}
