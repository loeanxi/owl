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

/** 打开系统文件选择对话框；filters 形如 [{ name, extensions: ["mp4","webm"] }]。 */
export async function pickFile(title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
	if (!hasTauri()) return null;
	const { open } = await import("@tauri-apps/plugin-dialog");
	const selected = await open({ multiple: false, title, filters });
	return typeof selected === "string" ? selected : null;
}

/** 设置整个 webview 的缩放（1 = 100%）；浏览器模式无意义，返回 false。 */
export async function setWebviewZoom(zoom: number): Promise<boolean> {
	if (!hasTauri()) return false;
	try {
		const { getCurrentWebview } = await import("@tauri-apps/api/webview");
		await getCurrentWebview().setZoom(zoom);
		return true;
	} catch {
		return false;
	}
}

export async function isWindowFullscreen(): Promise<boolean> {
	if (!hasTauri()) return false;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		return await getCurrentWindow().isFullscreen();
	} catch {
		return false;
	}
}

export async function setWindowFullscreen(fullscreen: boolean): Promise<boolean> {
	if (!hasTauri()) return false;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		await getCurrentWindow().setFullscreen(fullscreen);
		return true;
	} catch {
		return false;
	}
}

/** 关闭主窗口；Rust 侧把关闭拦截为隐藏到托盘，后台会话继续跑。 */
export async function closeMainWindow(): Promise<boolean> {
	if (!hasTauri()) return false;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		await getCurrentWindow().close();
		return true;
	} catch {
		return false;
	}
}

/** 退出整个应用（Rust RunEvent::Exit 里会顺带杀掉桥子进程）。 */
export async function quitDesktopApp(): Promise<boolean> {
	if (!hasTauri()) return false;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("quit_app");
		return true;
	} catch {
		return false;
	}
}
