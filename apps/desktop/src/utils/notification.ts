import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { getNotificationPrefs } from "./notification-prefs.ts";
import { playChime } from "./sound.ts";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 提醒类别：设置页可按类关闭；不传视为总是提醒。 */
export type NotificationCategory = "permission" | "question" | "done";

export interface NotifyOptions {
	title: string;
	body: string;
	category?: NotificationCategory;
	critical?: boolean;
	/** 审批快捷裁决：传了就走带「同意 / 拒绝」按钮的原生 Toast（仅 Tauri 桌面壳） */
	quickAction?: { requestId: string; approveLabel: string; denyLabel: string };
}

/** 原生 Toast 弹审批按钮；环境不支持或失败时返回 false，由调用方退回普通通知。 */
async function showQuickActionToast(options: NotifyOptions & { quickAction: NonNullable<NotifyOptions["quickAction"]> }): Promise<boolean> {
	if (!inTauri) return false;
	try {
		await invoke("show_approval_toast", {
			title: options.title,
			body: options.body,
			requestId: options.quickAction.requestId,
			approveLabel: options.quickAction.approveLabel,
			denyLabel: options.quickAction.denyLabel,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * 触发系统通知与任务栏提醒：
 * 0. 类别开关关闭则不打扰；窗口前台聚焦时静默（对话框就在眼前）
 * 1. 播放合成提示音（音量来自通知偏好）
 * 2. 闪烁任务栏（Critical: 强提醒持续闪烁 / Informational: 轻提醒闪烁一次）
 * 3. 审批请求优先弹带「同意 / 拒绝」按钮的原生 Toast，点了直接裁决
 * 4. 其余弹系统原生通知（Web Notification API 在 Windows Webview2 下映射为系统通知气泡）
 */
export async function notifyAgentStatus(options: NotifyOptions): Promise<void> {
	const prefs = getNotificationPrefs();
	if (options.category && !prefs[options.category]) return;

	// 如果窗口已在前台聚焦，无需弹出通知打扰
	if (typeof document !== "undefined" && document.hasFocus()) {
		return;
	}

	// 1. 提示音
	if (prefs.sound) {
		playChime(options.critical ? "critical" : "info", prefs.volume);
	}

	// 2. 闪烁 Windows 任务栏
	if (prefs.flashTaskbar && inTauri) {
		try {
			const current = getCurrentWindow();
			await current.requestUserAttention(
				options.critical ? UserAttentionType.Critical : UserAttentionType.Informational,
			);
		} catch {
			// 静默降级
		}
	}

	// 3. 审批请求：优先原生 Toast（带快捷按钮）
	if (options.quickAction && prefs.quickActions) {
		const shown = await showQuickActionToast(options as NotifyOptions & { quickAction: NonNullable<NotifyOptions["quickAction"]> });
		if (shown) return;
	}

	// 4. 原生系统通知
	if (typeof window !== "undefined" && "Notification" in window) {
		const trigger = (): void => {
			try {
				const n = new Notification(options.title, {
					body: options.body,
					icon: "/owl-fav.svg",
				});
				n.onclick = () => {
					window.focus();
					if (inTauri) {
						try {
							const current = getCurrentWindow();
							void current.show();
							void current.unminimize();
							void current.setFocus();
						} catch {
							// ignore
						}
					}
				};
			} catch {
				// 静默降级
			}
		};

		if (Notification.permission === "granted") {
			trigger();
		} else if (Notification.permission !== "denied") {
			Notification.requestPermission()
				.then((perm) => {
					if (perm === "granted") trigger();
				})
				.catch(() => {});
		}
	}
}
