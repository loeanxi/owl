"use strict";
const electron = require("electron");
class EventManager {
  constructor() {
    this.listeners = {};
    this.flag = null;
  }
  addEventListener(event, key, callback) {
    this.flag = callback;
    if (!this.listeners[event]) {
      this.listeners[event] = /* @__PURE__ */ new Map();
    }
    this.listeners[event].set(key, callback);
  }
  removeEventListener(event, key) {
    if (!this.listeners[event]) return;
    if (this.listeners[event].has(key)) {
      this.listeners[event].delete(key);
    }
  }
  has(event) {
    return this.listeners[event];
  }
  dispatchEvent(event, data) {
    if (!this.listeners[event]) return;
    Array.from(this.listeners[event]).forEach(([key, callback]) => callback(data));
  }
}
const eventManager = new EventManager();
function exposeInMainWorld() {
  electron.contextBridge.exposeInMainWorld(
    "electronAPI",
    /** @satisfies {ElectronAPI} */
    {
      getVersion: () => electron.ipcRenderer.invoke("getVersion"),
      logInfo: (msg) => electron.ipcRenderer.invoke("logInfo", msg),
      logWarn: (msg) => electron.ipcRenderer.invoke("logWarn", msg),
      logError: (msg) => electron.ipcRenderer.invoke("logError", msg),
      getConfig: (name) => electron.ipcRenderer.invoke("getConfig", name),
      setConfig: (name, data) => electron.ipcRenderer.invoke("setConfig", name, data),
      setMainLang: (lang) => electron.ipcRenderer.invoke("setMainLang", lang),
      getLang: () => electron.ipcRenderer.invoke("getLang"),
      getScreenInfo: () => electron.ipcRenderer.invoke("getScreenInfo"),
      getWindowsTheme: () => electron.ipcRenderer.invoke("getWindowsTheme"),
      getThemeValue: () => electron.ipcRenderer.invoke("getThemeValue"),
      setAutoStart: (value) => electron.ipcRenderer.invoke("setAutoStart", value),
      getAutoStartStatus: () => electron.ipcRenderer.invoke("getAutoStartStatus"),
      closeWindow: () => electron.ipcRenderer.invoke("closeWindow"),
      hideWindow: () => electron.ipcRenderer.invoke("hideWindow"),
      minimizeWindow: () => electron.ipcRenderer.invoke("minimizeWindow"),
      maximizeWindow: () => electron.ipcRenderer.invoke("maximizeWindow"),
      unmaximize: () => electron.ipcRenderer.invoke("unmaximize"),
      toggleMax: () => electron.ipcRenderer.invoke("toggleMax"),
      isMaximized: () => electron.ipcRenderer.invoke("isMaximized"),
      isWindowVisible: (id) => electron.ipcRenderer.invoke("isWindowVisible", id),
      getWindowStateSnapshot: (id) => electron.ipcRenderer.invoke("getWindowStateSnapshot", id),
      getWindowSize: () => electron.ipcRenderer.invoke("getWindowSize"),
      setWindowSize: (w, h) => electron.ipcRenderer.invoke("setWindowSize", w, h),
      setWindowMInSize: (w, h) => electron.ipcRenderer.invoke("setWindowMInSize", w, h),
      setZoomFactor: (factor) => electron.ipcRenderer.invoke("setZoomFactor", factor),
      setBounds: (x, y, w, h) => electron.ipcRenderer.invoke("setBounds", x, y, w, h),
      getDragBoundsAndRestoreIfMaximized: (desiredX, desiredY) => electron.ipcRenderer.invoke("getDragBoundsAndRestoreIfMaximized", desiredX, desiredY),
      setPosition: (x, y) => electron.ipcRenderer.invoke("setPosition", x, y),
      getEnv: () => electron.ipcRenderer.invoke("getEnv"),
      reportRendererReady: () => electron.ipcRenderer.invoke("renderer:report-ready"),
      syncDeviceConfigToMainProcess: (deviceConfigMap) => electron.ipcRenderer.invoke("renderer:sync-device-config", deviceConfigMap),
      getRendererUrl: () => electron.ipcRenderer.invoke("renderer:get-url"),
      getRefreshPageContext: () => electron.ipcRenderer.invoke("renderer:get-fallback-context"),
      refreshGlobalConfig: (options) => electron.ipcRenderer.invoke("renderer:refresh-global", options),
      probeRendererReachable: (target, options) => electron.ipcRenderer.invoke("renderer:probe-reachable", target, options),
      retryLoadRenderer: (options) => electron.ipcRenderer.invoke("renderer:retry-load", options),
      checkVcRedistX64: (options) => electron.ipcRenderer.invoke("vc-redist:check-x64", options),
      getAllStore: () => electron.ipcRenderer.invoke("getAllStore"),
      watchAllStore: () => electron.ipcRenderer.invoke("watchAllStore"),
      unwatchAllStore: (listenerId) => electron.ipcRenderer.invoke("unwatchAllStore", listenerId),
      // Store 操作方法
      setStore: (key, value, persistent = false) => electron.ipcRenderer.invoke("setStore", key, value, persistent),
      getStore: (key, defaultValue = null) => electron.ipcRenderer.invoke("getStore", key, defaultValue),
      hasStore: (key) => electron.ipcRenderer.invoke("hasStore", key),
      deleteStore: (key) => electron.ipcRenderer.invoke("deleteStore", key),
      clearStore: () => electron.ipcRenderer.invoke("clearStore"),
      // 用户配置（登录态跨 origin 备份）
      getUserConfig: () => electron.ipcRenderer.invoke("getUserConfig"),
      setUserConfig: (config) => electron.ipcRenderer.invoke("setUserConfig", config),
      getLegacyRendererLocalStorage: () => electron.ipcRenderer.invoke("getLegacyRendererLocalStorage"),
      getLegacyHttpsLocalStorage: () => electron.ipcRenderer.invoke("getLegacyHttpsLocalStorage"),
      getLegacyHttpsIndexedDB: () => electron.ipcRenderer.invoke("getLegacyHttpsIndexedDB"),
      migrateLegacyUrlIndexIframeStorage: () => electron.ipcRenderer.invoke("migrateLegacyUrlIndexIframeStorage"),
      getLegacyK20GtCustomImageHistory: () => electron.ipcRenderer.invoke("getLegacyK20GtCustomImageHistory"),
      // ==================== 窗口管理器 API ====================
      windowManager: (params) => electron.ipcRenderer.invoke("windowManager", params),
      // ==================== 自定义托盘 API ====================
      customTray: (params) => electron.ipcRenderer.invoke("customTray", params),
      // 创建托盘窗口
      createTrayWindow: (params, useOldTray = false) => electron.ipcRenderer.invoke("createTrayWindow", params, useOldTray),
      installDriver: (p) => electron.ipcRenderer.invoke("installDriver", p),
      quit: () => electron.ipcRenderer.invoke("quit"),
      uninstallDriver: () => electron.ipcRenderer.invoke("uninstallDriver"),
      // ==================== AudioSDKManager API ====================
      AudioSDKGetState: () => electron.ipcRenderer.invoke("audio-sdk:get-state"),
      AudioSDKInstallDriver: (options) => electron.ipcRenderer.invoke("audio-sdk:install-driver", options),
      AudioSDKReleaseDevice: (deviceId) => electron.ipcRenderer.invoke("audio-sdk:release-device", deviceId),
      AudioSDKEnsureReady: (registration) => electron.ipcRenderer.invoke("audio-sdk:ensure-ready", registration),
      AudioSDKCall: (method, args = []) => electron.ipcRenderer.invoke("audio-sdk:call", { method, args }),
      // ==================== AudioRuntimeTHX API ====================
      AudioTHXGetState: () => electron.ipcRenderer.invoke("audio-thx:get-state"),
      AudioTHXGetInstallState: (options) => electron.ipcRenderer.invoke("audio-thx:get-install-state", options),
      AudioTHXGet7TestVideoInfo: (options) => electron.ipcRenderer.invoke("audio-thx:get-7-test-video-info", options),
      AudioTHXListAudioPlayerProducts: (options) => electron.ipcRenderer.invoke("audio-thx:list-audio-player-products", options),
      AudioTHXListAudioPlayerEndpoints: (options) => electron.ipcRenderer.invoke("audio-thx:list-audio-player-endpoints", options),
      AudioTHXResolveAudioPlayerEndpointGuid: (options) => electron.ipcRenderer.invoke("audio-thx:resolve-audio-player-endpoint-guid", options),
      AudioTHXAudioPlayerControl: (request) => electron.ipcRenderer.invoke("audio-thx:audio-player-control", request),
      AudioTHXDownloadInstaller: (options) => electron.ipcRenderer.invoke("audio-thx:download-installer", options),
      AudioTHXGetDownloadInstallerState: (options) => electron.ipcRenderer.invoke("audio-thx:get-download-installer-state", options),
      AudioTHXInstallInstaller: (options) => electron.ipcRenderer.invoke("audio-thx:install-installer", options),
      AudioTHXUninstallBundle: (options) => electron.ipcRenderer.invoke("audio-thx:uninstall-bundle", options),
      AudioTHXGetRecoveryState: () => electron.ipcRenderer.invoke("audio-thx:get-recovery-state"),
      AudioTHXCheckAfunix: (options) => electron.ipcRenderer.invoke("audio-thx:check-afunix", options),
      AudioTHXRunServiceRepair: () => electron.ipcRenderer.invoke("audio-thx:run-service-repair"),
      AudioTHXEnsureReady: (options) => electron.ipcRenderer.invoke("audio-thx:ensure-ready", options),
      AudioTHXCall: (request) => electron.ipcRenderer.invoke("audio-thx:call", request),
      AudioTHXReleaseDevice: (request) => electron.ipcRenderer.invoke("audio-thx:release-device", request),
      AudioTHXReleaseClientShellByHwid: (request) => electron.ipcRenderer.invoke("audio-thx:release-client-shell-by-hwid", request),
      AudioTHXClearAudioPlayerEndpointByHwid: (request) => electron.ipcRenderer.invoke("audio-thx:clear-audio-player-endpoint-by-hwid", request),
      AudioTHXSubscribePropertyChanges: (request) => electron.ipcRenderer.invoke("audio-thx:subscribe-property-changes", request),
      AudioTHXUnsubscribePropertyChanges: (request) => electron.ipcRenderer.invoke("audio-thx:unsubscribe-property-changes", request),
      initDll: (name) => electron.ipcRenderer.invoke("initDll", name),
      setToDefault: () => electron.ipcRenderer.invoke("setToDefault"),
      getVolumeScalarControl: (channel, type) => electron.ipcRenderer.invoke("getVolumeScalarControl", channel, type),
      setVolumeScalarControl: (channel, val, type) => electron.ipcRenderer.invoke("setVolumeScalarControl", channel, val, type),
      getMuteControl: (type) => electron.ipcRenderer.invoke("getMuteControl", type),
      setMuteControl: (muted, type) => electron.ipcRenderer.invoke("setMuteControl", muted, type),
      getAINREnable: () => electron.ipcRenderer.invoke("getAINREnable"),
      setAINREnable: (enable) => electron.ipcRenderer.invoke("setAINREnable", enable),
      getNR_Enable: () => electron.ipcRenderer.invoke("getNR_Enable"),
      setNR_Enable: (enable) => electron.ipcRenderer.invoke("setNR_Enable", enable),
      getEnable_MAGICVOICE: () => electron.ipcRenderer.invoke("getEnable_MAGICVOICE"),
      setEnable_MAGICVOICE: (enable) => electron.ipcRenderer.invoke("setEnable_MAGICVOICE", enable),
      getMagicVoice_Selection: () => electron.ipcRenderer.invoke("getMagicVoice_Selection"),
      setMagicVoice_Selection: (type) => electron.ipcRenderer.invoke("setMagicVoice_Selection", type),
      openSoundSetting: () => electron.ipcRenderer.invoke("openSoundSetting"),
      openScreenSetting: () => electron.ipcRenderer.invoke("openScreenSetting"),
      openWindowsMouseSetting: () => electron.ipcRenderer.invoke("openWindowsMouseSetting"),
      openBrowser: (url) => electron.ipcRenderer.invoke("openBrowser", url),
      saveBgImg: (from) => electron.ipcRenderer.invoke("saveBgImg", from),
      getBgImg: () => electron.ipcRenderer.invoke("getBgImg"),
      deleteFile: (p) => electron.ipcRenderer.invoke("deleteFile", p),
      saveGifImg: (p) => electron.ipcRenderer.invoke("saveGifImg", p),
      getGifImgList: () => electron.ipcRenderer.invoke("getGifImgList"),
      openDevTools: () => electron.ipcRenderer.invoke("openDevTools"),
      // 音频明亮化
      getEnable_AUDIOBRILLIANT_LFX: () => electron.ipcRenderer.invoke("getEnable_AUDIOBRILLIANT_LFX"),
      setEnable_AUDIOBRILLIANT_LFX: (enable) => electron.ipcRenderer.invoke("setEnable_AUDIOBRILLIANT_LFX", enable),
      getAUDIOBRILLIANT_LEVEL: () => electron.ipcRenderer.invoke("getAUDIOBRILLIANT_LEVEL"),
      setAUDIOBRILLIANT_LEVEL: (level) => electron.ipcRenderer.invoke("setAUDIOBRILLIANT_LEVEL", level),
      // 环绕增强
      getEnable_Channel_COPY_LFX: () => electron.ipcRenderer.invoke("getEnable_Channel_COPY_LFX"),
      setEnable_Channel_COPY_LFX: (enable) => electron.ipcRenderer.invoke("setEnable_Channel_COPY_LFX", enable),
      // 动态低频
      getEnable_VIRTUALBASS_LFX: () => electron.ipcRenderer.invoke("getEnable_VIRTUALBASS_LFX"),
      setEnable_VIRTUALBASS_LFX: (enable) => electron.ipcRenderer.invoke("setEnable_VIRTUALBASS_LFX", enable),
      getVIRTUALBASS_Level: () => electron.ipcRenderer.invoke("getVIRTUALBASS_Level"),
      setVIRTUALBASS_Level: (level) => electron.ipcRenderer.invoke("setVIRTUALBASS_Level", level),
      getVIRTUALBASS_CutOffFrequency: () => electron.ipcRenderer.invoke("getVIRTUALBASS_CutOffFrequency"),
      setVIRTUALBASS_CutOffFrequency: (level) => electron.ipcRenderer.invoke("setVIRTUALBASS_CutOffFrequency", level),
      // 智能音量
      getEnable_ADAPTIVEVOLUME_GFX: () => electron.ipcRenderer.invoke("getEnable_ADAPTIVEVOLUME_GFX"),
      setEnable_ADAPTIVEVOLUME_GFX: (enable) => electron.ipcRenderer.invoke("setEnable_ADAPTIVEVOLUME_GFX", enable),
      getADAPTIVEVOLUME_LEVEL: () => electron.ipcRenderer.invoke("getADAPTIVEVOLUME_LEVEL"),
      setADAPTIVEVOLUME_LEVEL: (level) => electron.ipcRenderer.invoke("setADAPTIVEVOLUME_LEVEL", level),
      getADAPTIVEVOLUME_MODE: () => electron.ipcRenderer.invoke("getADAPTIVEVOLUME_MODE"),
      setADAPTIVEVOLUME_MODE: (mode) => electron.ipcRenderer.invoke("setADAPTIVEVOLUME_MODE", mode),
      // 人声清晰
      getEnable_VOICECLARITY_LFX: () => electron.ipcRenderer.invoke("getEnable_VOICECLARITY_LFX"),
      setEnable_VOICECLARITY_LFX: (enable) => electron.ipcRenderer.invoke("setEnable_VOICECLARITY_LFX", enable),
      getVOICECLARITY_LEVEL: () => electron.ipcRenderer.invoke("getVOICECLARITY_LEVEL"),
      setVOICECLARITY_LEVEL: (level) => electron.ipcRenderer.invoke("setVOICECLARITY_LEVEL", level),
      getVOICECLARITY_NOISESUPP_LEVEL: () => electron.ipcRenderer.invoke("getVOICECLARITY_NOISESUPP_LEVEL"),
      setVOICECLARITY_NOISESUPP_LEVEL: (level) => electron.ipcRenderer.invoke("setVOICECLARITY_NOISESUPP_LEVEL", level),
      getXearSurroundEnable: () => electron.ipcRenderer.invoke("getXearSurroundEnable"),
      getXearSurroundRoom: () => electron.ipcRenderer.invoke("getXearSurroundRoom"),
      getXearSurroundMode: () => electron.ipcRenderer.invoke("getXearSurroundMode"),
      setXearSurroundEnable: (value) => electron.ipcRenderer.invoke("setXearSurroundEnable", value),
      setXearSurroundRoom: (value) => electron.ipcRenderer.invoke("setXearSurroundRoom", value),
      setXearSurroundMode: (value) => electron.ipcRenderer.invoke("setXearSurroundMode", value),
      playTestSound: (value) => electron.ipcRenderer.invoke("playTestSound", value),
      stopTestSound: () => electron.ipcRenderer.invoke("stopTestSound"),
      GetEnable_EQ_GFX: () => electron.ipcRenderer.invoke("GetEnable_EQ_GFX"),
      setEnable_EQ_GFX: (enable) => electron.ipcRenderer.invoke("setEnable_EQ_GFX", enable),
      getEQ_Slider: (index) => electron.ipcRenderer.invoke("getEQ_Slider", index),
      setEQ_Slider: (index, value) => electron.ipcRenderer.invoke("setEQ_Slider", index, value),
      importData: () => electron.ipcRenderer.invoke("importData"),
      exportData: (data, defaultPath) => electron.ipcRenderer.invoke("exportData", data, defaultPath),
      download: (version, urlUpdate) => electron.ipcRenderer.invoke("download", version, urlUpdate),
      updater: {
        getState: () => electron.ipcRenderer.invoke("updater:getState"),
        startSilentDownload: (params) => electron.ipcRenderer.invoke("updater:startSilentDownload", params),
        startManualUpdate: (params) => electron.ipcRenderer.invoke("updater:startManualUpdate", params),
        applyDownloadedUpdateNow: () => electron.ipcRenderer.invoke("updater:applyDownloadedUpdateNow"),
        onStateChanged: (callback) => {
          const listener = (_event, state) => callback(state);
          electron.ipcRenderer.on("updater:stateChanged", listener);
          return () => electron.ipcRenderer.removeListener("updater:stateChanged", listener);
        }
      },
      getArgv: () => electron.ipcRenderer.invoke("getArgv"),
      getFirmwareVer: () => electron.ipcRenderer.invoke("getFirmwareVer"),
      getDeviceFriendlyName: (type) => electron.ipcRenderer.invoke("getDeviceFriendlyName", type),
      isInstalledInSystemDrive: () => electron.ipcRenderer.invoke("isInstalledInSystemDrive"),
      getIsAdminRunning: () => electron.ipcRenderer.invoke("getIsAdminRunning"),
      getMainFlags: () => electron.ipcRenderer.invoke("getMainFlags"),
      setMainFlags: (obj) => electron.ipcRenderer.invoke("setMainFlags", obj),
      restartComputer: () => electron.ipcRenderer.invoke("restartComputer"),
      getUsbDeviceDescriptor: (p) => electron.ipcRenderer.invoke("getUsbDeviceDescriptor", p),
      getFWVersionFromUsbDescriptor: (p) => electron.ipcRenderer.invoke("getFWVersionFromUsbDescriptor", p),
      getUsbStringDescriptor: (p) => electron.ipcRenderer.invoke("getUsbStringDescriptor", p),
      recorderCall: (methodName, param) => electron.ipcRenderer.invoke("recorderCall", methodName, param),
      getFirmwareBinData: (p) => electron.ipcRenderer.invoke("getFirmwareBinData", p),
      getDefaultLang: () => electron.ipcRenderer.invoke("getDefaultLang"),
      startWatchAudioVolume: () => electron.ipcRenderer.invoke("startWatchAudioVolume"),
      stopWatchAudioVolume: () => electron.ipcRenderer.invoke("stopWatchAudioVolume"),
      getAudioVolume: (p) => electron.ipcRenderer.invoke("getAudioVolume", p),
      setAudioVolume: (p) => electron.ipcRenderer.invoke("setAudioVolume", p),
      getAudioMute: (p) => electron.ipcRenderer.invoke("getAudioMute", p),
      setAudioMute: (p) => electron.ipcRenderer.invoke("setAudioMute", p),
      // 固件OTA
      otaDevice: (p) => electron.ipcRenderer.invoke("otaDevice", p),
      // 发送管道消息：展示PC端提示窗
      showWinToast: (p) => electron.ipcRenderer.invoke("showWinToast", p),
      // 获取、设置sharedConfig
      getSharedConfig: () => electron.ipcRenderer.invoke("getSharedConfig"),
      setSharedConfig: (p) => electron.ipcRenderer.invoke("setSharedConfig", p),
      // 获取、设置麦克风侦听状态
      getMicListenStatus: () => electron.ipcRenderer.invoke("getMicListenStatus"),
      setMicListenStatus: (p) => electron.ipcRenderer.invoke("setMicListenStatus", p),
      // 获取应用内存使用情况
      getAppMetrics: () => electron.ipcRenderer.invoke("getAppMetrics"),
      //扫描获取本地应用信息
      scanAppList: () => electron.ipcRenderer.invoke("scanAppList"),
      scanGameList: () => electron.ipcRenderer.invoke("scanGameList"),
      getExeDetailInfo: (p) => electron.ipcRenderer.invoke("getExeDetailInfo", p),
      startListenActiveAppChange: (p) => electron.ipcRenderer.invoke("startListenActiveAppChange", p),
      stopListenActiveAppChange: () => electron.ipcRenderer.invoke("stopListenActiveAppChange"),
      startLyricsMonitor: () => electron.ipcRenderer.invoke("startLyricsMonitor"),
      stopLyricsMonitor: () => electron.ipcRenderer.invoke("stopLyricsMonitor"),
      isLyricsMonitorRunning: () => electron.ipcRenderer.invoke("isLyricsMonitorRunning"),
      readQQMusicQrc: (params) => electron.ipcRenderer.invoke("readQQMusicQrc", params),
      resolveQQMusicLyricPaths: (iniPath) => electron.ipcRenderer.invoke("resolveQQMusicLyricPaths", iniPath),
      readKuGouKrc: (params) => electron.ipcRenderer.invoke("readKuGouKrc", params),
      resolveKuGouLyricPath: (iniPath) => electron.ipcRenderer.invoke("resolveKuGouLyricPath", iniPath),
      getKuGouPlaybackState: (params) => electron.ipcRenderer.invoke("getKuGouPlaybackState", params),
      getNcmInstallPath: () => electron.ipcRenderer.invoke("getNcmInstallPath"),
      // isBetterNcmInstalled: () => ipcRenderer.invoke('isBetterNcmInstalled'),
      installBetterNcm: () => electron.ipcRenderer.invoke("installBetterNcm"),
      uninstallBetterNcm: () => electron.ipcRenderer.invoke("uninstallBetterNcm"),
      removeInfLinkPlugin: () => electron.ipcRenderer.invoke("removeInfLinkPlugin"),
      // 选取文件弹窗
      showOpenFileDialog: (p) => electron.ipcRenderer.invoke("showOpenFileDialog", p),
      // 同步主进程当前环境
      setCurEnv: (p) => electron.ipcRenderer.invoke("setCurEnv", p),
      getCurEnv: () => electron.ipcRenderer.invoke("getCurEnv"),
      getRendererBuildInfo: () => electron.ipcRenderer.invoke("getRendererBuildInfo"),
      // 获取当前环境配置
      getTargetEnvConfig: (p) => electron.ipcRenderer.invoke("getTargetEnvConfig", p),
      // 获取所有环境配置
      getEnvConfigs: () => electron.ipcRenderer.invoke("getEnvConfigs"),
      //web端注册监听方法
      onBatteryInfo: (callback) => electron.ipcRenderer.on("battery_info", (_, data) => callback(data)),
      getUsbVersion: (p) => electron.ipcRenderer.invoke("getUsbVersion", p),
      readLocalFile: (path) => electron.ipcRenderer.invoke("readLocalFile", path),
      openUserFilesDir: () => electron.ipcRenderer.invoke("openUserFilesDir"),
      // files/local 目录读写（路径相对 local 根目录）
      localFiles: {
        getRoot: () => electron.ipcRenderer.invoke("localFiles:getRoot"),
        read: (relativePath, options) => electron.ipcRenderer.invoke("localFiles:read", relativePath, options),
        write: (relativePath, content, options) => electron.ipcRenderer.invoke("localFiles:write", relativePath, content, options),
        delete: (relativePath) => electron.ipcRenderer.invoke("localFiles:delete", relativePath),
        exists: (relativePath) => electron.ipcRenderer.invoke("localFiles:exists", relativePath),
        mkdir: (relativePath) => electron.ipcRenderer.invoke("localFiles:mkdir", relativePath),
        list: (relativePath) => electron.ipcRenderer.invoke("localFiles:list", relativePath)
      },
      //web端注册监听方法
      onMaximize: (callback) => electron.ipcRenderer.on("maximize", (_event) => callback()),
      onUnmaximize: (callback) => electron.ipcRenderer.on("unmaximize", (_event) => callback()),
      // dllReady: (callback) => ipcRenderer.on('dllReady', (_,data) => callback(data)),
      downloadProgress: (callback) => electron.ipcRenderer.on("downloadProgress", (_, p) => callback(p)),
      //注册可取消的监听
      addEventListener: (event, key, callback) => {
        switch (event) {
          case "callback_VOLUMEANDMUTE":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("callbackVOLUMEANDMUTE", (_) => {
                eventManager.dispatchEvent(event);
              });
            }
            break;
          case "updateError":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("updateError", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onDllReady":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onDllReady", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onRecorderData":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onRecorderData", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onRecorderError":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onRecorderError", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onAudioVolumeChange":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onAudioVolumeChange", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onActiveAppChange":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onActiveAppChange", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onLyricsMediaUpdate":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onLyricsMediaUpdate", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "betterNcmInstallProgress":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("betterNcmInstallProgress", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "storeChange":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("storeChange", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onOtaMessage":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onOtaMessage", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onIframeLoadFailed":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("onIframeLoadFailed", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "windowStateChange":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("windowStateChange", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onTHXPropertyChanges":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("audio-thx:property-changes", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onTHXPropertyChangesEnded":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("audio-thx:property-changes-ended", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
          case "onTHXPropertyChangesError":
            if (!eventManager.has(event)) {
              electron.ipcRenderer.on("audio-thx:property-changes-error", (_, data) => {
                eventManager.dispatchEvent(event, data);
              });
            }
            break;
        }
        eventManager.addEventListener(event, key, callback);
      },
      removeEventListener: (event, key) => {
        eventManager.removeEventListener(event, key);
      }
    }
  );
}
try {
  exposeInMainWorld();
} catch (error) {
  console.error(error);
}
