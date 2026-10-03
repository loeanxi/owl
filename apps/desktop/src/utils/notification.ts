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

/** 原生 Toast 弹系统通知；环境不支持或失败时返回 false，由调用方退回 Web Notification。 */
async function showNativeToast(options: NotifyOptions): Promise<boolean> {
	if (!inTauri) return false;
	try {
		const quick = options.quickAction && getNotificationPrefs().quickActions ? options.quickAction : undefined;
		await invoke("show_approval_toast", {
			title: options.title,
			body: options.body,
			requestId: quick?.requestId ?? "",
			approveLabel: quick?.approveLabel ?? null,
			denyLabel: quick?.denyLabel ?? null,
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
 * 3. 桌面壳统一走 Rust 原生 Toast（WebView2 的 Notification 权限默认被拒；
 *    审批请求额外带「同意 / 拒绝」按钮），失败退回系统原生通知气泡
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
		playChime(prefs.soundKind, prefs.volume, options.critical === true);
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

	// 3. 桌面壳：原生 Toast（审批带快捷按钮）；浏览器模式或失败：Web Notification
	if (await showNativeToast(options)) return;

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
