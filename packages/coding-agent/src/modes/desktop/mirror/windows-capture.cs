// owl 窗口镜像（mirror）捕获内核：Windows.Graphics.Capture 会话 + JPEG 编帧。
//
// 编译走 PowerShell 的 Add-Type（进程内 csc，.NET Framework 4.8），通过
// -ReferencedAssemblies 引系统 winmd（C:\Windows\System32\WinMetadata）拿到
// Windows.Graphics.Capture / Windows.Graphics.Imaging 的投影类型；异步 WinRT
// 操作用 Completed 回调转 TaskCompletionSource 等待。C#5 语法（无内插字符串 /
// 无 unsafe / 无 null 条件），保持与进程内 csc 兼容。
//
// 线程纪律：WindowsRuntimeMarshal.GetActivationFactory 由框架处理公寓；帧
// 循环在调用线程上 TryGetNextFrame 轮询（CreateFreeThreaded 无需 Dispatcher）。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

namespace OwlMirror
{
    // InterfaceIsIUnknown + 显式 IInspectable 三方法垫片：钉死 vtable，让
    // CreateForWindow 落在正确槽位（net48 对 IInspectable 接口的槽位处理有
    // 版本差异，垫片是最稳的写法）。
    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int GetIids(out ulong iidCount, out IntPtr iids);
        [PreserveSig] int GetRuntimeClassName(out IntPtr className);
        [PreserveSig] int GetTrustLevel(out int trustLevel);

        [PreserveSig]
        int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
        [PreserveSig]
        int CreateForMonitor(IntPtr hmon, ref Guid iid, out IntPtr item);
    }

    public sealed class CaptureSession : IDisposable
    {
        private Direct3D11CaptureFramePool _framePool;
        private GraphicsCaptureSession _session;
        private int _frameSeq;

        public int FrameSeq { get { return _frameSeq; } }

        private CaptureSession()
        {
        }

        public static bool IsSupported()
        {
            try
            {
                return GraphicsCaptureItem.IsSupported();
            }
            catch
            {
                return false;
            }
        }

        public static IntPtr CreateItemForWindow(IntPtr hwnd)
        {
            var factory = WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
            var interop = (IGraphicsCaptureItemInterop)factory;
            Guid itemIid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            IntPtr itemPtr;
            int hr = interop.CreateForWindow(hwnd, ref itemIid, out itemPtr);
            if (hr != 0) throw new Exception("CreateForWindow hr=0x" + hr.ToString("X"));
            try
            {
                return Marshal.GetObjectForIUnknown(itemPtr);
            }
            finally { Marshal.Release(itemPtr); }
        }

        /// <summary>启动对一个窗口的捕获。hwnd 必须是已恢复的顶层窗口（最小化抓不了）。</summary>
        public static CaptureSession Start(IntPtr hwnd)
        {
            var itemObj = CreateItemForWindow(hwnd);
            var item = (GraphicsCaptureItem)itemObj;

            var device = (IDirect3DDevice)CreateDirect3DDevice();

            var session = new CaptureSession();
            var size = new SizeInt32();
            size.Width = item.Size.Width;
            size.Height = item.Size.Height;
            session._framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
            session._session = session._framePool.CreateCaptureSession(item);
            try { session._session.IsCursorCaptureEnabled = false; }
            catch { /* 老系统无此属性 */ }
            try { session._session.IsBorderRequired = false; }
            catch { /* 需要更高版本 + 权限，失败不致命 */ }
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
                width = frame.ContentSize.Width;
                height = frame.ContentSize.Height;
                var asyncOp = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
                var software = AwaitOp(asyncOp);
                try
                {
                    return EncodeJpeg(software, quality, maxWidth, ref width, ref height);
                }
                finally { software.Dispose(); }
            }
            finally { frame.Dispose(); }
        }

        private static SoftwareBitmap AwaitOp(IAsyncOperation<SoftwareBitmap> op)
        {
            var tcs = new TaskCompletionSource<SoftwareBitmap>();
            op.Completed = (info, status) =>
            {
                try
                {
                    if (status == AsyncStatus.Completed) tcs.SetResult(info.GetResults());
                    else tcs.SetException(new Exception("SoftwareBitmap copy failed: " + status));
                }
                catch (Exception ex) { tcs.SetException(ex); }
            };
            return tcs.Task;
        }

        private static byte[] EncodeJpeg(SoftwareBitmap software, int quality, int maxWidth, ref int width, ref int height)
        {
            // Bgra8 像素 → 托管数组（32bppArgb 内存序一致：B,G,R,A；JPEG 无 alpha，
            // 无需处理透明度）
            var buffer = software.LockBuffer(BitmapBufferAccessMode.Read);
            byte[] pixels;
            try
            {
                pixels = System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.ToArray(buffer);
            }
            finally { buffer.Dispose(); }

            int sw = software.PixelWidth, sh = software.PixelHeight;
            double scale = maxWidth > 0 && sw > maxWidth ? (double)maxWidth / sw : 1.0;
            int dw = Math.Max(1, (int)Math.Round(sw * scale));
            int dh = Math.Max(1, (int)Math.Round(sh * scale));
            width = dw; height = dh;

            using (var bitmap = new Bitmap(dw, dh, PixelFormat.Format32bppArgb))
            {
                var rect = new Rectangle(0, 0, dw, dh);
                var data = bitmap.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    // 32bpp 的 stride 恒等于宽×4（4 字节对齐），逐行最近邻拷贝
                    for (int y = 0; y < dh; y++)
                    {
                        int srcRow = (int)((long)y * sh / dh) * sw * 4;
                        IntPtr dstRow = new IntPtr(data.Scan0.ToInt64() + y * data.Stride);
                        if (scale == 1.0)
                        {
                            Marshal.Copy(pixels, srcRow, dstRow, sw * 4);
                        }
                        else
                        {
                            var row = new byte[dw * 4];
                            for (int x = 0; x < dw; x++)
                            {
                                int sx = (int)((long)x * sw / dw) * 4 + srcRow;
                                row[x * 4] = pixels[sx];
                                row[x * 4 + 1] = pixels[sx + 1];
                                row[x * 4 + 2] = pixels[sx + 2];
                                row[x * 4 + 3] = 255;
                            }
                            Marshal.Copy(row, 0, dstRow, row.Length);
                        }
                    }
                }
                finally { bitmap.UnlockBits(data); }

                using (var stream = new MemoryStream())
                {
                    var encoderParams = new EncoderParameters(1);
                    encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(1, Math.Min(100, quality)));
                    bitmap.Save(stream, GetJpegEncoder(), encoderParams);
                    return stream.ToArray();
                }
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
            try { if (_session != null) _session.Close(); } catch { }
            try { if (_framePool != null) _framePool.Dispose(); } catch { }
            _session = null;
            _framePool = null;
        }
    }
}
