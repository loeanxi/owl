import { t } from "../i18n/index.ts";

/** 窗口不可见时的完成/失败信号（挂进标题前缀；窗口恢复可见即清除）。 */
export type TitleSignal = "done" | "error" | "waiting" | undefined;

/**
 * 窗口标题（任务栏可见）随会话活动态更新：后台信号 > 等你确认 > 正在工作（多会话带计数）> 静态名。
 * 纯函数便于单测；App 的 effect 只负责把它写进 document.title。
 */
export function windowTitle(pendingUser: boolean, workingSessions: number, signal?: TitleSignal): string {
	const prefix = signal === "done" ? t("app.titleDone") : signal === "error" ? t("app.titleFailed") : undefined;
	const suffix = pendingUser || signal === "waiting"
		? t("app.titleWaiting")
		: workingSessions > 1
			? t("app.titleWorkingMany", { n: workingSessions })
			: workingSessions === 1
				? t("app.titleWorking")
				: undefined;
	if (prefix && suffix) return `${prefix} · ${suffix} · owl`;
	if (prefix) return `${prefix} · owl`;
	return suffix ? `${suffix} · owl` : "owl";
}
