// owl 窗口镜像捕获内核：Windows.Graphics.Capture 会话 + JPEG 编帧。
//
// 编译：由 windows-capture.ps1 用进程外 csc（net48 in-box，C#5）带系统 winmd
// 引用编成 DLL 后加载。保持 C#5 语法（无字符串内插 / 无 unsafe / 无 null 条件）。
//
// 注意：net48 的 System32\WinMetadata\Windows.Graphics.winmd 没有
// GraphicsCaptureItem.IsSupported，取 item 用 Win11 的
// TryCreateFromWindowId(Windows.UI.WindowId) —— 不要用 IGraphicsCaptureItemInterop
// （net48 的 IInspectable vtable 处理不可靠，实测打不对槽位）。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

namespace OwlMirror
{
    // IBuffer 字节读取：net48 的 WindowsRuntimeBufferExtensions.ToArray 绑定旧聚合
    // Windows.winmd（本机没有），改走 IMemoryBufferByteAccess（IUnknown 型 COM，
    // net48 编组可靠）。IMemoryBufferReference 的 RCW 对它 QI 一定能成功。
    [ComImport, Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD0BD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMemoryBufferByteAccess
    {
        void GetBuffer(out IntPtr value, out uint capacity);
    }

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
            var deadline = Environment.TickCount + 3000;
            while (op.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("SoftwareBitmap copy timed out");
                Thread.Sleep(2);
            }
            if (op.Status != AsyncStatus.Completed) throw new Exception("SoftwareBitmap copy failed: " + op.Status);
            return op.GetResults();
        }

        private static byte[] EncodeJpeg(SoftwareBitmap software, int quality, int maxWidth, ref int width, ref int height)
        {
            // Bgra8 像素直接搬进 32bppArgb 位图（内存序一致：B,G,R,A；JPEG 无 alpha）
            int sw = software.PixelWidth, sh = software.PixelHeight;
            byte[] pixels;
            var buffer = software.LockBuffer(BitmapBufferAccessMode.Read);
            try
            {
                var reference = buffer.CreateReference();
                try
                {
                    var byteAccess = (IMemoryBufferByteAccess)reference;
                    IntPtr dataPtr;
                    uint capacity;
                    byteAccess.GetBuffer(out dataPtr, out capacity);
                    pixels = new byte[capacity];
                    Marshal.Copy(dataPtr, pixels, 0, (int)capacity);
                }
                finally { ((IDisposable)reference).Dispose(); }
            }
            finally { buffer.Dispose(); }

            double scale = maxWidth > 0 && sw > maxWidth ? (double)maxWidth / sw : 1.0;
            int dw = Math.Max(1, (int)Math.Round(sw * scale));
            int dh = Math.Max(1, (int)Math.Round(sh * scale));
            width = dw; height = dh;

            using (var full = new Bitmap(sw, sh, sw * 4, PixelFormat.Format32bppArgb,
                Marshal.UnsafeAddrOfPinnedArrayElement(pixels, 0)))
            {
                Bitmap source = full;
                try
                {
                    if (scale < 1.0)
                    {
                        var scaled = new Bitmap(dw, dh);
                        using (var g = Graphics.FromImage(scaled))
                        {
                            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                            g.DrawImage(full, 0, 0, dw, dh);
                        }
                        source = scaled;
                    }
                    using (var stream = new MemoryStream())
                    {
                        var encoderParams = new EncoderParameters(1);
                        encoderParams.Param[0] = new EncoderParameter(Encoder.Quality,
                            (long)Math.Max(1, Math.Min(100, quality)));
                        stream.Position = 0;
                        source.Save(stream, GetJpegEncoder(), encoderParams);
                        return stream.ToArray();
                    }
                }
                finally { if (!ReferenceEquals(source, full)) source.Dispose(); }
            }
        }

        private static ImageCodecInfo GetJpegEncoder()
        {
            foreach (var codec in ImageCodecInfo.GetImageEncoders())
            {
                if (codec.MimeType == "image/jpeg") return codec;
            }
            throw new Exception("jpeg codec not found");
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
