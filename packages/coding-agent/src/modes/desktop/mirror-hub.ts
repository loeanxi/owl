/**
 * 窗口镜像 hub（owl Mirror）：桥进程托管窗口捕获 worker（PowerShell + WGC），
 * 把 JPEG 帧流推给订阅的桌面连接。纯观看面 —— 不做输入转发，不给 agent 暴露工具。
 *
 * 设计对照 browser-hub 的帧流策略：帧只发给订阅这条窗口的连接（serve 侧按连接
 * 记账），窗口清单变化才广播。worker 是每窗口一个的 PowerShell 子进程（见
 * mirror/windows-capture.ps1），末个订阅者退订后延迟关闭，避免 tab 切换抖动。
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { release } from "node:os";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { hideRect } from "./mirror/embed-layout.ts";
import type { MirrorWindowInfo } from "./protocol.ts";

const WORKER_URL = new URL("./mirror/windows-capture.ps1", import.meta.url);

/**
 * WGC（Windows Graphics Capture）需要 Windows 10 1803（build 17134）及以上；
 * 非 Windows 一律不支持。os.release() 走 RtlGetVersion，返回真实构建号
 * （如 "10.0.22631"）。解析不出来按不支持处理，前端会落到 designed 空态。
 */
const MIRROR_SUPPORTED = process.platform === "win32" && Number(release().split(".")[2] ?? 0) >= 17134;

/** 末个订阅者退订后 worker 的延迟关闭时间。 */
const DETACH_GRACE_MS = 5_000;
/** 每窗口帧缓存大小（无新帧时 UI 保持最后一帧，这里只做诊断统计）。 */

export interface MirrorHubOptions {
	onFrame: (windowId: string, data: string, width: number, height: number) => void;
	onWindowsChanged: (windows: MirrorWindowInfo[]) => void;
	onDiagnostic?: (message: string) => void;
}

/** worker 子进程形态：stdio = ["ignore", "pipe", "pipe"]，stdin 关闭，stdout/stderr 为可读流。 */
type MirrorProc = ChildProcessByStdio<null, Readable, Readable>;

interface MirrorWorker {
	proc: MirrorProc;
	buffer: string;
	refs: number;
	detachTimer?: ReturnType<typeof setTimeout>;
}

export function isHongguoWindow(win: { process: string; title: string }): boolean {
	// 应用宝容器里红果的宿主进程是 Androws（实测），标题即「红果免费短剧」。
	return win.process.toLowerCase() === "androws" && win.title.includes("红果");
}

export class MirrorHub {
	private readonly options: MirrorHubOptions;
	private readonly workers = new Map<string, MirrorWorker>();
	/** 已嵌入窗口的还原元数据（原始样式/原父），unembed 时带回。 */
	private readonly embedMeta = new Map<string, { originalStyle: number; originalParent: number }>();
	private windows: MirrorWindowInfo[] = [];
	private supported = MIRROR_SUPPORTED;
	private disposed = false;

	constructor(options: MirrorHubOptions) {
		this.options = options;
	}

	listCachedWindows(): MirrorWindowInfo[] {
		return this.windows;
	}

	isSupported(): boolean {
		return this.supported;
	}

	/** 枚举候选窗口（含最小化的；红果优先排序）。 */
	listWindows(): Promise<MirrorWindowInfo[]> {
		return this.runWorkerLines(["list"]).then((lines) => {
			const windows: MirrorWindowInfo[] = [];
			for (const line of lines) {
				try {
					const obj = JSON.parse(line) as {
						event?: string;
						hwnd?: number;
						title?: string;
						process?: string;
						w?: number;
						h?: number;
						minimized?: boolean;
					};
					if (obj.event !== "window" || typeof obj.hwnd !== "number") continue;
					const info: MirrorWindowInfo = {
						windowId: String(obj.hwnd),
						title: obj.title ?? "",
						process: obj.process ?? "",
						hongguo: isHongguoWindow({ process: obj.process ?? "", title: obj.title ?? "" }),
						minimized: Boolean(obj.minimized),
						width: obj.w ?? 0,
						height: obj.h ?? 0,
					};
					windows.push(info);
				} catch {
					// 忽略无法解析的行（诊断行等）
				}
			}
			windows.sort((a, b) => Number(b.hongguo) - Number(a.hongguo) || a.title.localeCompare(b.title));
			this.windows = windows;
			this.options.onWindowsChanged(windows);
			return windows;
		});
	}

	attach(windowId: string): void {
		if (this.disposed) return;
		let worker = this.workers.get(windowId);
		if (worker?.detachTimer) {
			clearTimeout(worker.detachTimer);
			worker.detachTimer = undefined;
		}
		if (worker) {
			worker.refs++;
			return;
		}
		worker = this.spawnCapture(windowId);
		this.workers.set(windowId, worker);
	}

	detach(windowId: string): void {
		const worker = this.workers.get(windowId);
		if (!worker) return;
		worker.refs = Math.max(0, worker.refs - 1);
		if (worker.refs === 0 && !worker.detachTimer) {
			worker.detachTimer = setTimeout(() => {
				this.workers.delete(windowId);
				this.killWorker(worker);
			}, DETACH_GRACE_MS);
		}
	}

	/** 把最小化/被收纳的目标窗口拉回来（对 BitDock 类停靠工具走 SC_RESTORE）。 */
	async restore(windowId: string): Promise<void> {
		const hwnd = Number(windowId);
		if (!Number.isFinite(hwnd) || hwnd <= 0) throw new Error("invalid windowId");
		await this.runWorkerLines(["restore", "-Hwnd", String(hwnd)]);
	}

	/** 发现 owl 桌面主窗口 HWND（嵌入的父窗口）；桥由 Tauri 壳拉起时进程名固定为 owl-desktop。 */
	async findOwlParentHwnd(): Promise<number> {
		const windows = this.windows.length ? this.windows : await this.listWindows();
		const owl = windows.find((win) => win.process.toLowerCase() === "owl-desktop" && !win.minimized);
		if (!owl) throw new Error("owl desktop window not found");
		return Number(owl.windowId);
	}

	/** 启动应用宝电脑版（空态引导）。 */
	async launchApp(): Promise<void> {
		const lines = await this.runWorkerLines(["launch"]);
		for (const line of lines) {
			if (line.includes('"event":"error"')) {
				const message = (() => {
					try {
						return (JSON.parse(line) as { message?: string }).message ?? "launch failed";
					} catch {
						return "launch failed";
					}
				})();
				throw new Error(message);
			}
		}
	}

	/**
	 * 嵌入：目标窗口 SetParent 到 parentHwnd 并去头，按 rect 摆放。
	 * worker 返回的原始样式/原父缓存下来，unembed 时带回还原。
	 */
	async embedWindow(
		windowId: string,
		parentHwnd: number,
		rect: { x: number; y: number; width: number; height: number },
	): Promise<void> {
		const hwnd = Number(windowId);
		if (!Number.isFinite(hwnd) || hwnd <= 0) throw new Error("invalid windowId");
		if (!Number.isFinite(parentHwnd) || parentHwnd <= 0) throw new Error("invalid parentHwnd");
		const lines = await this.runWorkerLines([
			"embed",
			"-Hwnd",
			String(hwnd),
			"-ParentHwnd",
			String(parentHwnd),
			"-X",
			String(Math.round(rect.x)),
			"-Y",
			String(Math.round(rect.y)),
			"-W",
			String(Math.round(rect.width)),
			"-H",
			String(Math.round(rect.height)),
		]);
		for (const line of lines) {
			if (!line.includes('"event":"embedded"')) continue;
			try {
				const obj = JSON.parse(line) as { originalStyle?: number; originalParent?: number };
				this.embedMeta.set(windowId, {
					originalStyle: obj.originalStyle ?? 0x00cf0000,
					originalParent: obj.originalParent ?? 0,
				});
			} catch {}
		}
	}

	/** 布局同步：移动/缩放嵌入窗口；visible=false 时移到屏外隐藏矩形。 */
	async layoutWindow(
		windowId: string,
		rect: { x: number; y: number; width: number; height: number },
		visible: boolean,
	): Promise<void> {
		const hwnd = Number(windowId);
		if (!Number.isFinite(hwnd) || hwnd <= 0) throw new Error("invalid windowId");
		const applied = visible ? rect : hideRect();
		await this.runWorkerLines([
			"move",
			"-Hwnd",
			String(hwnd),
			"-X",
			String(Math.round(applied.x)),
			"-Y",
			String(Math.round(applied.y)),
			"-W",
			String(Math.round(applied.width)),
			"-H",
			String(Math.round(applied.height)),
		]);
	}

	/** 解除嵌入：脱离父窗口、还原标题栏样式，变回独立顶层窗口。 */
	async unembedWindow(windowId: string): Promise<void> {
		const hwnd = Number(windowId);
		if (!Number.isFinite(hwnd) || hwnd <= 0) throw new Error("invalid windowId");
		const meta = this.embedMeta.get(windowId);
		this.embedMeta.delete(windowId);
		await this.runWorkerLines([
			"unembed",
			"-Hwnd",
			String(hwnd),
			"-Style",
			String(meta?.originalStyle ?? -1),
			"-ParentHwnd",
			String(meta?.originalParent ?? 0),
		]);
	}

	dispose(): void {
		this.disposed = true;
		// 解除全部嵌入（还原窗口），再收 worker
		for (const windowId of [...this.embedMeta.keys()]) {
			this.unembedWindow(windowId).catch(() => {});
		}
		this.embedMeta.clear();
		for (const [windowId, worker] of this.workers) {
			if (worker.detachTimer) clearTimeout(worker.detachTimer);
			this.killWorker(worker);
			this.workers.delete(windowId);
		}
	}

	// ------------------------------------------------------------------

	private spawnCapture(windowId: string): MirrorWorker {
		const hwnd = Number(windowId);
		if (!Number.isFinite(hwnd) || hwnd <= 0) throw new Error("invalid windowId");
		const worker: MirrorWorker = {
			proc: this.spawnWorker(["capture", "-Hwnd", String(hwnd), "-Fps", "20"]),
			buffer: "",
			refs: 1,
		};
		const onLine = (line: string): void => {
			if (!line) return;
			let obj: {
				event?: string;
				seq?: number;
				w?: number;
				h?: number;
				data?: string;
				iconic?: boolean;
				autoRestored?: number;
				message?: string;
			};
			try {
				obj = JSON.parse(line);
			} catch {
				return;
			}
			if (obj.event === "frame" && obj.data) {
				this.options.onFrame(windowId, obj.data, obj.w ?? 0, obj.h ?? 0);
				return;
			}
			if (obj.event === "status") {
				this.updateWindowState(windowId, Boolean(obj.iconic), obj.autoRestored ?? 0);
				return;
			}
			if (obj.event === "error") {
				this.options.onDiagnostic?.(`mirror[${windowId}]: ${obj.message ?? "unknown error"}`);
			}
		};
		worker.proc.stdout.on("data", (chunk: Buffer) => {
			worker.buffer += chunk.toString("utf8");
			let index = worker.buffer.indexOf("\n");
			while (index >= 0) {
				const line = worker.buffer.slice(0, index).replace(/\r$/, "");
				worker.buffer = worker.buffer.slice(index + 1);
				onLine(line);
				index = worker.buffer.indexOf("\n");
			}
		});
		worker.proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trim();
			if (text) this.options.onDiagnostic?.(`mirror[${windowId}] stderr: ${text.slice(0, 300)}`);
		});
		let reaped = false;
		const reap = (): void => {
			// worker 意外退出（窗口消失 / 捕获报错 / spawn 失败）：清账并广播清单刷新。
			// 已 disposed 不再拉新清单——否则 dispose 里逐个 kill 会催生一批新 worker。
			if (reaped || this.disposed) return;
			reaped = true;
			if (this.workers.get(windowId) === worker) this.workers.delete(windowId);
			void this.listWindows().catch(() => {});
		};
		worker.proc.on("exit", reap);
		// spawn 失败（EMFILE / 被安全软件拦截等）只发 error 不发 exit：没有监听就是
		// 未捕获异常，整个桥跟着崩——与 runWorkerLines 的 error 处理同款。
		worker.proc.on("error", (error: Error) => {
			this.options.onDiagnostic?.(`mirror[${windowId}] ${error.message}`);
			reap();
		});
		return worker;
	}

	private updateWindowState(windowId: string, iconic: boolean, autoRestored: number): void {
		let changed = false;
		this.windows = this.windows.map((win) => {
			if (win.windowId !== windowId) return win;
			const minimized = iconic && autoRestored === 0;
			if (win.minimized !== minimized) changed = true;
			return { ...win, minimized };
		});
		if (changed) this.options.onWindowsChanged(this.windows);
	}

	private killWorker(worker: MirrorWorker): void {
		try {
			worker.proc.stdout.removeAllListeners();
			worker.proc.stderr.removeAllListeners();
			if (!worker.proc.killed) worker.proc.kill();
		} catch {
			// 进程已死即达成目的
		}
	}

	private spawnWorker(args: string[]): MirrorProc {
		const script = fileURLToPath(WORKER_URL);
		return spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	}

	private runWorkerLines(args: string[]): Promise<string[]> {
		return new Promise((resolve, reject) => {
			let proc: MirrorProc;
			try {
				proc = this.spawnWorker(args);
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			const out: string[] = [];
			let buffer = "";
			let stderr = "";
			const finish = (error?: Error): void => {
				proc.stdout.removeAllListeners();
				proc.stderr.removeAllListeners();
				proc.removeAllListeners();
				try {
					if (!proc.killed) proc.kill();
				} catch {}
				if (error) reject(error);
				else resolve(out);
			};
			const timer = setTimeout(() => finish(new Error("mirror worker timeout")), 20_000);
			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					const line = buffer.slice(0, index).replace(/\r$/, "");
					buffer = buffer.slice(index + 1);
					if (!line) continue;
					if (line.includes('"event":"ready"')) {
						clearTimeout(timer);
						finish();
						return;
					}
					out.push(line);
					index = buffer.indexOf("\n");
				}
			});
			proc.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			proc.on("error", (error) => {
				clearTimeout(timer);
				finish(error instanceof Error ? error : new Error(String(error)));
			});
			proc.on("exit", (code) => {
				if (code !== 0 && code !== null) {
					clearTimeout(timer);
					finish(new Error(`mirror worker exited ${code}: ${stderr.slice(0, 300)}`));
				}
			});
		});
	}
}
