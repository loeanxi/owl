import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface NotifyOptions {
	title: string;
	body: string;
	critical?: boolean;
}

/**
 * 触发系统通知与任务栏提醒：
 * 1. 若当前窗口正在前台且聚焦，则静默（避免重复打扰）
 * 2. 在 Tauri 环境下闪烁任务栏（Critical: 强提醒持续闪烁 / Informational: 轻提醒闪烁一次）
 * 3. 弹出系统原生通知（Web Notification API 在 Windows Webview2 下映射为系统原生通知气泡）
 */
export async function notifyAgentStatus(options: NotifyOptions): Promise<void> {
	// 如果窗口已在前台聚焦，无需弹出系统通知打扰
	if (typeof document !== "undefined" && document.hasFocus()) {
		return;
	}

	// 1. 闪烁 Windows 任务栏
	if (inTauri) {
		try {
			const current = getCurrentWindow();
			await current.requestUserAttention(
				options.critical ? UserAttentionType.Critical : UserAttentionType.Informational,
			);
		} catch {
			// 静默降级
		}
	}

	// 2. 原生系统通知
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
