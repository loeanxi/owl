/**
 * Tauri 原生能力封装（桌面壳独有，浏览器模式优雅降级）。
 *
 * 桌面窗口加载的是桥的 http://127.0.0.1 页面，Tauri 会给 capability 里
 * `remote.urls` 匹配的页面注入 `__TAURI_INTERNALS__`；纯浏览器（node
 * serve.js 直开）没有它。判断存在才动态 import 插件，浏览器模式不加载
 * tauri 插件包、调用方拿 null 自行降级。
 */

/** 当前页面是否跑在 Tauri 桌面壳里（决定原生按钮显隐）。 */
export function hasTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 打开系统文件夹选择对话框（资源管理器），取消返回 null。 */
export async function pickFolder(title: string): Promise<string | null> {
	if (!hasTauri()) return null;
	const { open } = await import("@tauri-apps/plugin-dialog");
	const selected = await open({ directory: true, multiple: false, title });
	return typeof selected === "string" ? selected : null;
}
