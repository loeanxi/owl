/**
 * 通知偏好（settings.json 的 owlNotifications 键，桥端深合并保存）。
 * 前端模块级缓存：App 启动与设置页保存时写入，notifyAgentStatus 读它做门控，
 * 这样纯浏览器模式（无 Tauri）也走同一份开关。
 */

import { isNotificationSound, type NotificationSound } from "./sound.ts";

export interface NotificationPrefs {
	/** 工具执行等审批请求的提醒（桌面端附带「同意 / 拒绝」快捷按钮） */
	permission: boolean;
	/** agent 提问的提醒 */
	question: boolean;
	/** 一轮回复完成的提醒 */
	done: boolean;
	/** 提示音 */
	sound: boolean;
	/** 提示音样式（auto = 按类别自动选音） */
	soundKind: NotificationSound;
	/** 提示音音量（0-100） */
	volume: number;
	/** 后台时任务栏闪烁 */
	flashTaskbar: boolean;
	/** 审批通知上显示快捷裁决按钮 */
	quickActions: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
	permission: true,
	question: true,
	done: true,
	sound: true,
	soundKind: "auto",
	volume: 60,
	flashTaskbar: true,
	quickActions: true,
};

export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
	const source = (raw ?? {}) as Partial<Record<keyof NotificationPrefs, unknown>>;
	const bool = (key: keyof NotificationPrefs, fallback: boolean): boolean =>
		typeof source[key] === "boolean" ? (source[key] as boolean) : fallback;
	const volume =
		typeof source.volume === "number" && Number.isFinite(source.volume)
			? Math.min(100, Math.max(0, Math.round(source.volume)))
			: DEFAULT_NOTIFICATION_PREFS.volume;
	return {
		permission: bool("permission", true),
		question: bool("question", true),
		done: bool("done", true),
		sound: bool("sound", true),
		soundKind: isNotificationSound(source.soundKind) ? source.soundKind : DEFAULT_NOTIFICATION_PREFS.soundKind,
		volume,
		flashTaskbar: bool("flashTaskbar", true),
		quickActions: bool("quickActions", true),
	};
}

let current: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };

export function getNotificationPrefs(): NotificationPrefs {
	return current;
}

export function setNotificationPrefs(next: NotificationPrefs): void {
	current = next;
}
