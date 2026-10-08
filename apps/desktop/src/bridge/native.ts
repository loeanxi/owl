import { invoke } from "@tauri-apps/api/core";

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

/** 启动独立构建窗口；Rust 会随后安全退出当前进程，helper 完整重建并启动新版本。 */
export async function startDebugRebuild(): Promise<boolean> {
	if (!hasTauri()) return false;
	await invoke("debug_rebuild_and_restart");
	return true;
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
		await invoke("quit_app");
		return true;
	} catch {
		return false;
	}
}

export type OsFileDrop =
	| { type: "enter" | "over"; position: { x: number; y: number } }
	| { type: "drop"; position: { x: number; y: number }; paths: string[] }
	| { type: "leave" };

/**
 * 系统文件拖放。Windows 上 Tauri 会吃掉网页的 drop，资源管理器拖进来只能从这里拿到路径。
 * 浏览器模式没有这个事件，返回空的取消函数。
 */
export async function listenForOsFileDrop(handler: (event: OsFileDrop) => void): Promise<() => void> {
	if (!hasTauri()) return () => undefined;
	try {
		const { getCurrentWebview } = await import("@tauri-apps/api/webview");
		return await getCurrentWebview().onDragDropEvent((event) => {
			const payload = event.payload;
			if (payload.type === "leave") {
				handler({ type: "leave" });
				return;
			}
			if (payload.type === "drop") {
				handler({ type: "drop", position: payload.position, paths: payload.paths });
				return;
			}
			handler({ type: payload.type, position: payload.position });
		});
	} catch {
		return () => undefined;
	}
}

/** 读取拖进来的本地图片。非图片、超大或浏览器模式返回 null，调用方改走路径附件。 */
export async function readLocalImage(path: string): Promise<{ data: string; mimeType: string } | null> {
	if (!hasTauri()) return null;
	try {
		const image = await invoke<{ data: string; mimeType: string }>("read_local_image", { path });
		if (!image?.data || !image.mimeType) return null;
		return image;
	} catch {
		return null;
	}
}

/** 在资源管理器里定位一个已存在的文件；返回具体失败原因供 UI 展示（浏览器模式也返回原因）。 */
export async function revealInFileManager(path: string): Promise<{ ok: boolean; error?: string }> {
	if (!hasTauri()) return { ok: false, error: "not running inside the desktop shell" };
	try {
		await invoke("reveal_in_file_manager", { path });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 桥进程的日志文件路径（桌面壳把桥的 stdout/stderr 重定向到 %TEMP%\owl-bridge.log，
 * 与 Rust 侧 bridge_log_path() 同一口径）；浏览器模式没有日志文件，返回 null。
 */
export async function bridgeLogPath(): Promise<string | null> {
	if (!hasTauri()) return null;
	try {
		const { tempDir, join } = await import("@tauri-apps/api/path");
		return await join(await tempDir(), "owl-bridge.log");
	} catch {
		return null;
	}
}
