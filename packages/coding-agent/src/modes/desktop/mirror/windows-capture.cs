// owl 窗口镜像 interop 助手：只负责 GraphicsCaptureItem 的工厂激活（原生 vtable
// 一侧），不引用任何 WinRT 投影类型 —— 因此 Add-Type 无需 winmd 引用即可编译。
//
// 为什么不用 RoGetActivationFactory：在 .NET 进程里对纯元数据（非 COM 注册）的
// 激活类调用会返回 REGDB_E_CLASSNOTREG；框架自己的
// WindowsRuntimeMarshal.GetActivationFactory 走 RoGetMetaDataFile 解析路径，
// 类型用 Type.GetType("..., ContentType=WindowsRuntime") 惰性解析即可拿到。
using System;
using System.Runtime.InteropServices;

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

    public static class CaptureInterop
    {
        private const string ItemTypeName =
            "Windows.Graphics.Capture.GraphicsCaptureItem, Windows.Graphics.Capture, ContentType=WindowsRuntime";

        /// <summary>
        /// 为窗口创建 IGraphicsCaptureItem，返回 AddRef 过的 IUnknown 指针。
        /// 调用方负责 Marshal.Release（或转交 WinRT 编组后释放所有权）。
        /// </summary>
        public static IntPtr CreateItemForWindow(IntPtr hwnd)
        {
            var itemType = Type.GetType(ItemTypeName, throwOnError: true);
            var factory = WindowsRuntimeMarshal.GetActivationFactory(itemType);
            var interop = (IGraphicsCaptureItemInterop)factory;
            Guid itemIid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            IntPtr itemPtr;
            int hr = interop.CreateForWindow(hwnd, ref itemIid, out itemPtr);
            if (hr != 0) throw new Exception("CreateForWindow hr=0x" + hr.ToString("X"));
            return itemPtr;
        }

        /// <summary>
        /// 创建 WGC 用的 IDirect3DDevice，返回 IInspectable COM 对象（__ComObject）。
        /// 调用方（PowerShell 侧）把它不透明透传给 CreateFreeThreaded 即可。
        /// </summary>
        public static object CreateDirect3DDevice()
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
    }
}
