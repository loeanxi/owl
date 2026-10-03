using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;

namespace DshMediaBridge.Windows
{
    public sealed class ProcessVolume
    {
        public bool Found { get; set; }
        public float VolumePercent { get; set; }
    }

    /// <summary>
    /// Minimal Core Audio interop for one application's render-session volume.
    /// It never reads or writes the default endpoint (system) master volume.
    /// </summary>
    public static class AudioSessionVolume
    {
        public static ProcessVolume GetForProcessName(string processName)
        {
            return GetForProcessNames(new[] { processName });
        }

        public static ProcessVolume GetForProcessNames(string[] processNames)
        {
            return GetForProcessIds(processNames.SelectMany(Process.GetProcessesByName).Select(process => (uint)process.Id), null);
        }

        public static ProcessVolume SetForProcessName(string processName, float volumePercent)
        {
            return SetForProcessNames(new[] { processName }, volumePercent);
        }

        public static ProcessVolume SetForProcessNames(string[] processNames, float volumePercent)
        {
            if (float.IsNaN(volumePercent) || float.IsInfinity(volumePercent)) throw new ArgumentOutOfRangeException("volumePercent");
            return GetForProcessIds(processNames.SelectMany(Process.GetProcessesByName).Select(process => (uint)process.Id), Math.Max(0f, Math.Min(100f, volumePercent)) / 100f);
        }

        private static ProcessVolume GetForProcessIds(IEnumerable<uint> processIds, float? setVolume)
        {
            var ids = new HashSet<uint>(processIds);
            if (ids.Count == 0) return new ProcessVolume { Found = false };

            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IAudioSessionManager2 manager = null;
            IAudioSessionEnumerator sessions = null;
            var volumes = new List<float>();

            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                ThrowIfFailed(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));
                var iid = typeof(IAudioSessionManager2).GUID;
                object managerObject;
                ThrowIfFailed(device.Activate(ref iid, CLSCTX.ALL, IntPtr.Zero, out managerObject));
                manager = (IAudioSessionManager2)managerObject;
                ThrowIfFailed(manager.GetSessionEnumerator(out sessions));

                int count;
                ThrowIfFailed(sessions.GetCount(out count));
                for (var index = 0; index < count; index++)
                {
                    IAudioSessionControl control = null;
                    try
                    {
                        ThrowIfFailed(sessions.GetSession(index, out control));
                        var control2 = control as IAudioSessionControl2;
                        if (control2 == null) continue;
                        uint processId;
                        ThrowIfFailed(control2.GetProcessId(out processId));
                        if (!ids.Contains(processId)) continue;

                        var volume = control as ISimpleAudioVolume;
                        if (volume == null) continue;
                        if (setVolume.HasValue)
                        {
                            var context = Guid.Empty;
                            ThrowIfFailed(volume.SetMasterVolume(setVolume.Value, ref context));
                        }
                        float current;
                        ThrowIfFailed(volume.GetMasterVolume(out current));
                        volumes.Add(current);
                    }
                    finally
                    {
                        Release(control);
                    }
                }
            }
            finally
            {
                Release(sessions);
                Release(manager);
                Release(device);
                Release(enumerator);
            }

            return new ProcessVolume
            {
                Found = volumes.Count > 0,
                VolumePercent = volumes.Count == 0 ? 0f : volumes.Average() * 100f,
            };
        }

        private static void ThrowIfFailed(int hresult)
        {
            if (hresult < 0) Marshal.ThrowExceptionForHR(hresult);
        }

        private static void Release(object value)
        {
            if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
        }
    }

    internal enum EDataFlow { eRender, eCapture, eAll, EDataFlow_enum_count }
    internal enum ERole { eConsole, eMultimedia, eCommunications, ERole_enum_count }
    [Flags] internal enum CLSCTX : uint { INPROC_SERVER = 0x1, INPROC_HANDLER = 0x2, LOCAL_SERVER = 0x4, REMOTE_SERVER = 0x10, ALL = INPROC_SERVER | INPROC_HANDLER | LOCAL_SERVER | REMOTE_SERVER }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out object devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, CLSCTX clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
        int OpenPropertyStore(int storageAccessMode, out object properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    internal interface IAudioSessionManager2
    {
        int GetAudioSessionControl(ref Guid audioSessionGuid, uint streamFlags, out IAudioSessionControl sessionControl);
        int GetSimpleAudioVolume(ref Guid audioSessionGuid, uint streamFlags, out ISimpleAudioVolume audioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(IntPtr sessionNotification);
        int UnregisterSessionNotification(IntPtr sessionNotification);
        int RegisterDuckNotification(string sessionId, IntPtr duckNotification);
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    internal interface IAudioSessionEnumerator
    {
        int GetCount(out int sessionCount);
        int GetSession(int sessionCount, out IAudioSessionControl session);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    internal interface IAudioSessionControl
    {
        int GetState(out int state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
        int GetGroupingParam(out Guid groupingId);
        int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    internal interface IAudioSessionControl2 : IAudioSessionControl
    {
        new int GetState(out int state);
        new int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        new int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
        new int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        new int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
        new int GetGroupingParam(out Guid groupingId);
        new int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
        new int RegisterAudioSessionNotification(IntPtr client);
        new int UnregisterAudioSessionNotification(IntPtr client);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionIdentifier);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionInstanceIdentifier);
        int GetProcessId(out uint processId);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    internal interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool isMuted, ref Guid eventContext);
        int GetMute(out bool isMuted);
    }
}
