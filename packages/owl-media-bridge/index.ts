/**
 * owl-media-bridge 扩展入口（node half）。
 *
 * 从 dsh-media-bridge 的 cordis 插件移植为 owl 扩展（ExtensionAPI）。做四件事：
 *  1. 组装 MediaBridge + BridgeRuntime（领域层与 Windows 适配器从 DSH 版原样
 *     移植，配置改为 <agentDir>/media-bridge/config.json 持久化）；
 *  2. 注册 4 个模型工具（media_bridge_status / control / memory /
 *     explain_status，语义与 DSH 版一致）；
 *  3. 经 @owl/owl-coding-agent 的 media-bridge-channel 单例把同源 HTTP 处理器
 *     注入桌面桥（/media-bridge/api/*，浏览器 UI 专用；未加载本插件时桥的
 *     分发链直接跳过——纯增量）；
 *  4. 听歌记忆与跳过台账持久化到 <agentDir>/media-bridge/（只存文本元数据，
 *     从不写回播放器）。
 *
 * 安全不变量与 DSH 版一致：播放器显式指定不回退；命令能力门控；Agent 控制
 * 默认关；音量只动播放器自身音频会话；封面/歌词不出状态载荷、不落盘。
 *
 * 生命周期：工厂里不起任何子进程/定时器——PowerShell worker 惰性启动、空闲
 * 自停（首次 status/control 读取时按需拉起），与 owl 扩展加载约定一致。
 * @module owl-media-bridge
 */

import { type ExtensionAPI, setMediaBridgeHttpHandler } from '@owl/owl-coding-agent'
import { NeteaseMusicWindowsAdapter } from './src/adapters/netease-music-windows.ts'
import { QqMusicWindowsAdapter } from './src/adapters/qq-music-windows.ts'
import { QqLiveVideoResolver } from './src/adapters/qq-live-video.ts'
import { WindowsProcessAudioMeter } from './src/adapters/process-audio-meter.ts'
import { ProgressiveTrackMetadata } from './src/adapters/progressive-track-metadata.ts'
import { BridgeRuntime } from './src/bridge-runtime.ts'
import { MediaBridge } from './src/domain/media-bridge.ts'
import { handleBridgeApiRequest } from './src/http.ts'
import { ListeningMemory } from './src/listening-memory.ts'
import { SkipLedger } from './src/listening-report.ts'
import { mediaBridgeDataDir, loadMediaBridgeSettings, saveMediaBridgeSettings } from './src/config.ts'
import { createControlTool, createExplainTool, createMemoryTool, createStatusTool } from './src/plugin/tools.ts'
import type { LiveVideoDescription } from './src/runtime/views.ts'
import { join } from 'node:path'

export default function (pi: ExtensionAPI): void {
  // 显式播放器选择 + 全部策略开关，持久化在 owl 数据目录。
  const settings = loadMediaBridgeSettings()

  // 本地听歌记忆（“刚才放了什么” + 收藏夹）与跳过台账：只存文本元数据，
  // 绝不落图片/歌词，从不写回播放器。
  const dataDir = mediaBridgeDataDir()
  const memory = new ListeningMemory(join(dataDir, 'listening-memory.json'))
  const skipLedger = new SkipLedger(join(dataDir, 'skip-ledger.json'))

  const bridge = new MediaBridge(
    [new QqMusicWindowsAdapter(), new NeteaseMusicWindowsAdapter()],
    settings.playerId ?? 'qq-music',
    { onStatusRead: (status) => memory.note(status) },
  )

  // 真实波形的接缝是 Windows 专属：只捕获显式选定播放器自己的进程
  // （WASAPI process loopback）。不可用时 UI 明确说明并退回播放状态动画，
  // 没有任何系统级回退。默认关。
  const audioSignals =
    settings.realWaveEnabled === true && process.platform === 'win32' ? new WindowsProcessAudioMeter() : undefined

  // 直播/舞台视频解析只走 QQ 音乐公开、无 cookie 的端点；解析结果（含短时效
  // URL）只投影到浏览器 UI 视图——绝不进 BridgeStatus、模型工具或磁盘。
  const liveVideoResolver = new QqLiveVideoResolver()
  const liveVideoProvider = new ProgressiveTrackMetadata<LiveVideoDescription>(
    (track, signal) => liveVideoResolver.resolve(track, signal),
    {
      hasValue: (video) => video.url !== '' && video.expiresAt > Date.now() + 30_000,
      // 只在远端有效期安全窗口内发号 URL。
      refreshAfterMs: (video) => Math.max(10_000, Math.min(30 * 60_000, video.expiresAt - Date.now() - 60_000)),
      retryAfterMs: 60_000,
    },
  )

  const runtime = new BridgeRuntime(bridge, settings, undefined, undefined, memory, skipLedger, audioSignals, liveVideoProvider)

  // 4 个模型工具（Agent 控制默认关，由运行时门控）。
  pi.registerTool(createStatusTool(runtime))
  pi.registerTool(createControlTool(runtime))
  pi.registerTool(createMemoryTool(runtime))
  pi.registerTool(createExplainTool(runtime))

  // 同源 HTTP API：经核心单例交给桌面桥的分发链；onConfigChange 把 onboarding/
  // 设置页写来的补丁落盘，重启后仍然生效。
  setMediaBridgeHttpHandler((request, response, options) =>
    handleBridgeApiRequest(request, response, runtime, {
      authorizeOrigin: options.authorizeOrigin,
      onConfigChange: (patch) => {
        saveMediaBridgeSettings(patch)
      },
    }),
  )

  // bridge-runtime 在扩展重载后由 GC 处置；PowerShell worker 空闲自停，
  // 记忆保存是防抖定时器，最终一致——与 DSH 桌面宿主的常驻语义相同。
}
