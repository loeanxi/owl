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
// 出口用 BitmapEncoder（WinRT 自带 JPEG 编码，保留物理像素供 UI 映射），全程只
// 依赖投影成员，不做任何 COM 接口强转。
using System;
using System.Collections.Generic;
using System.Diagnostics;
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
    /// <summary>A per-session kernel timer; no busy wait or global timer-resolution change.</summary>
    public sealed class HighResolutionWaiter : IDisposable
    {
        private IntPtr _timer;

        public HighResolutionWaiter()
        {
            _timer = CreateWaitableTimerEx(IntPtr.Zero, null, 2, 0x00100002);
            if (_timer == IntPtr.Zero) _timer = CreateWaitableTimerEx(IntPtr.Zero, null, 0, 0x00100002);
        }

        public void WaitMilliseconds(double milliseconds)
        {
            if (milliseconds <= 0) return;
            long due = -(long)Math.Max(1, Math.Ceiling(milliseconds * 10000));
            if (_timer == IntPtr.Zero || !SetWaitableTimer(_timer, ref due, 0, IntPtr.Zero, IntPtr.Zero, false))
            {
                Thread.Sleep((int)Math.Ceiling(milliseconds));
                return;
            }
            WaitForSingleObject(_timer, 0xffffffff);
        }

        public void Dispose()
        {
            if (_timer != IntPtr.Zero) CloseHandle(_timer);
            _timer = IntPtr.Zero;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateWaitableTimerEx(IntPtr attributes, string name, uint flags, uint access);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetWaitableTimer(IntPtr timer, ref long due, int period, IntPtr callback, IntPtr arg, bool resume);
        [DllImport("kernel32.dll")]
        private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }

    public sealed class CaptureSession : IDisposable
    {
        private Direct3D11CaptureFramePool _framePool;
        private GraphicsCaptureSession _session;
        private IDirect3DDevice _device;
        private SizeInt32 _frameSize;
        private int _frameSeq;
        private long _captureStarted;
        private long _nextCaptureDue;
        private int _pacedFps;
        private readonly HighResolutionWaiter _waiter = new HighResolutionWaiter();

        public double LastCopyMilliseconds { get; private set; }
        public double LastEncodeMilliseconds { get; private set; }

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

            session._device = device;
            session._frameSize = size;
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
            _captureStarted = Stopwatch.GetTimestamp();
            long deadline = _captureStarted + (long)(timeoutMs * (Stopwatch.Frequency / 1000.0));
            while (Stopwatch.GetTimestamp() < deadline)
            {
                var frame = _framePool.TryGetNextFrame();
                if (frame == null)
                {
                    _waiter.WaitMilliseconds(1);
                    continue;
                }
                // A throttled consumer must not encode the oldest queued image.
                // Return superseded surfaces immediately and keep the newest one.
                for (int pending = 0; pending < 8; pending++)
                {
                    var newer = _framePool.TryGetNextFrame();
                    if (newer == null) break;
                    frame.Dispose();
                    frame = newer;
                }
                SizeInt32 contentSize = frame.ContentSize;
                bool resized = contentSize.Width > 0 && contentSize.Height > 0
                    && (contentSize.Width != _frameSize.Width || contentSize.Height != _frameSize.Height);
                try
                {
                    if (contentSize.Width <= 0 || contentSize.Height <= 0) continue;
                    if (!resized)
                    {
                        long copyStarted = Stopwatch.GetTimestamp();
                        var software = CopyToSoftwareBitmap(frame.Surface);
                        LastCopyMilliseconds = (Stopwatch.GetTimestamp() - copyStarted) * 1000.0 / Stopwatch.Frequency;
                        // The CPU bitmap owns its pixels. Return the GPU surface
                        // before JPEG encoding so capture can fill the next slot.
                        frame.Dispose();
                        frame = null;
                        try
                        {
                            long encodeStarted = Stopwatch.GetTimestamp();
                            var jpeg = EncodeJpeg(software, quality, maxWidth, ref width, ref height);
                            LastEncodeMilliseconds = (Stopwatch.GetTimestamp() - encodeStarted) * 1000.0 / Stopwatch.Frequency;
                            Interlocked.Increment(ref _frameSeq);
                            return jpeg;
                        }
                        finally { software.Dispose(); }
                    }
                }
                finally { if (frame != null) frame.Dispose(); }
                // The old surface is clipped on growth and has undefined pixels on shrink.
                // Return it before replacing the pool; only encode a frame from the new size.
                _framePool.Recreate(_device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, contentSize);
                _frameSize = contentSize;
            }
            return null;
        }

        public void WaitForNextFrame(int fps)
        {
            int rate = Math.Max(1, Math.Min(60, fps));
            long period = Stopwatch.Frequency / rate;
            long due = _nextCaptureDue;
            if (due == 0 || _pacedFps != rate) due = _captureStarted + period;
            long now = Stopwatch.GetTimestamp();
            // Retain the cadence across small scheduling overruns, but never
            // replay a backlog after a paused/idle source or a slow encode.
            if (now - due > period) due = now;
            _waiter.WaitMilliseconds((due - now) * 1000.0 / Stopwatch.Frequency);
            _nextCaptureDue = due + period;
            _pacedFps = rate;
        }

        private SoftwareBitmap CopyToSoftwareBitmap(IDirect3DSurface surface)
        {
            var op = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface);
            return AwaitSoft(op);
        }

        private byte[] EncodeJpeg(SoftwareBitmap software, int quality, int maxWidth, ref int width, ref int height)
        {
            int sw = software.PixelWidth, sh = software.PixelHeight;
            // Projection crops and input coordinates refer to physical source
            // pixels. Resizing belongs to the UI, not to this encoded frame.
            width = sw; height = sh;

            var stream = new InMemoryRandomAccessStream();
            try
            {
                var options = new[] {
                    new KeyValuePair<string, BitmapTypedValue>("ImageQuality",
                        new BitmapTypedValue(Math.Max(1, Math.Min(100, quality)) / 100.0f, PropertyType.Single))
                };
                var createOp = BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream, options);
                var encoder = AwaitEncoder(createOp);
                encoder.SetSoftwareBitmap(software);
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

        private SoftwareBitmap AwaitSoft(IAsyncOperation<SoftwareBitmap> op)
        {
            var deadline = Environment.TickCount + 5000;
            while (op.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (SoftwareBitmap)");
                _waiter.WaitMilliseconds(0.5);
            }
            if (op.Status != AsyncStatus.Completed) throw new Exception("SoftwareBitmap copy failed: " + op.Status);
            return op.GetResults();
        }

        private BitmapEncoder AwaitEncoder(IAsyncOperation<BitmapEncoder> op)
        {
            var deadline = Environment.TickCount + 5000;
            while (op.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (BitmapEncoder)");
                _waiter.WaitMilliseconds(0.5);
            }
            if (op.Status != AsyncStatus.Completed) throw new Exception("BitmapEncoder create failed: " + op.Status);
            return op.GetResults();
        }

        private void AwaitAction(IAsyncAction action)
        {
            var deadline = Environment.TickCount + 5000;
            while (action.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (Flush)");
                _waiter.WaitMilliseconds(0.5);
            }
            if (action.Status != AsyncStatus.Completed) throw new Exception("Flush failed: " + action.Status);
        }

        private uint AwaitLoad(IAsyncOperation<uint> op)
        {
            var deadline = Environment.TickCount + 5000;
            while (op.Status == AsyncStatus.Started)
            {
                if (Environment.TickCount > deadline) throw new Exception("async op timed out (Load)");
                _waiter.WaitMilliseconds(0.5);
            }
            if (op.Status != AsyncStatus.Completed) throw new Exception("Load failed: " + op.Status);
            return op.GetResults();
        }

        public void Dispose()
        {
            try { if (_session != null) ((IDisposable)_session).Dispose(); } catch { }
            try { if (_framePool != null) _framePool.Dispose(); } catch { }
            try { if (_device != null) ((IDisposable)_device).Dispose(); } catch { }
            _session = null;
            _framePool = null;
            _device = null;
            _waiter.Dispose();
        }
    }
}
