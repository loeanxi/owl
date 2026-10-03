/**
 * owl 侧的媒体桥配置持久化：<agentDir>/media-bridge/config.json。
 *
 * DSH 版把配置放在 profile YAML；owl 没有等价物，改为 owl 数据目录里的一个
 * JSON 文件——桌面端 onboarding/设置页通过 config/update 路由写入，
 * 这里负责读写与合并。损坏或缺失一律回退空对象（播放器缺省 qq-music），
 * 绝不让坏配置打断桥启动。
 * @module owl-media-bridge/config
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@owl/owl-coding-agent'
import type { BridgeSettingsPatch } from './http.ts'

export type MediaBridgeSettings = BridgeSettingsPatch

/** 配置与听歌记忆都住在 <agentDir>/media-bridge/ 下。 */
export function mediaBridgeDataDir(): string {
  return join(getAgentDir(), 'media-bridge')
}

export function mediaBridgeConfigPath(): string {
  return join(mediaBridgeDataDir(), 'config.json')
}

/** 读取已保存的设置；缺失/损坏返回空对象（全部走运行时默认值）。 */
export function loadMediaBridgeSettings(): MediaBridgeSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mediaBridgeConfigPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    const settings: MediaBridgeSettings = {}
    if (typeof record.playerId === 'string' && record.playerId.trim() !== '') settings.playerId = record.playerId
    const booleanKeys = [
      'allowAgentControl',
      'deepBackground',
      'realWaveEnabled',
      'softTransitions',
      'skipFadeOut',
      'preferLiveVideo',
    ] as const
    for (const key of booleanKeys) {
      if (typeof record[key] === 'boolean') settings[key] = record[key]
    }
    return settings
  } catch {
    return {}
  }
}

/** 合并写入一个配置补丁；写盘失败向上抛（config/update 会回 400）。 */
export function saveMediaBridgeSettings(patch: MediaBridgeSettings): void {
  const merged = { ...loadMediaBridgeSettings(), ...patch }
  const file = mediaBridgeConfigPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}
