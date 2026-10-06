/**
 * computer-use 驱动会话：管理长驻 PowerShell 侧车（computer-driver.ps1）。
 *
 * 协议：stdin/stdout JSON 行（UTF-8）。请求 {id, cmd, ...} → 响应
 * {id, ok, data|error}；worker 启动后先广播 {"event":"ready"}（内核编译 +
 * 加载完成），ready 之前发出的请求排队等待。worker 崩溃自动重建，空闲
 * 60s 自停 —— 全部照 owl-media-bridge 的 powershell-runner 模式，差异点：
 * 带请求 id（防串线）、ready 门、会话级「最近截图」坐标映射（截图像素
 * 空间 → 虚拟屏幕坐标），映射存 Node 侧，worker 重启不丢。
 * @module owl-computer-use/driver/session
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ScreenshotMeta {
	/** 截图（可能已缩放）的像素尺寸。 */
	imageWidth: number;
	imageHeight: number;
	/** 截图对应的屏幕区域（虚拟屏幕坐标）。 */
	screenWidth: number;
	screenHeight: number;
	originX: number;
	originY: number;
}

export type ClickButton = "left" | "right" | "middle";

export interface WindowRow {
	hwnd: number;
	title: string;
	class: string;
	process: string;
	pid: number;
	x: number;
	y: number;
	w: number;
	h: number;
	minimized: boolean;
	foreground: boolean;
}

/** click 命中的窗口 / type·key 时的前台窗口（驱动的自纠错反馈）。 */
export interface WindowRef {
	hwnd: number;
	title: string;
	process: string;
	pid: number;
	minimized?: boolean;
	foreground?: boolean;
}

export interface DriverSpawnOptions {
	/** 每个命令的超时毫秒（默认 20s）。 */
	requestTimeoutMs?: number;
	/** 等待 worker ready 的毫秒（默认 120s，覆盖冷启动 csc 编译）。 */
	readyTimeoutMs?: number;
	/** 空闲多少毫秒后自停 worker（默认 60s；0 = 不自停）。 */
	idleTimeoutMs?: number;
}

/** 仅测试注入用：返回一个 stdout/stderr/stdin 齐全的伪 worker。 */
export type DriverWorkerFactory = () => ChildProcessWithoutNullStreams;

interface PendingRequest {
	readonly id: number;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface QueuedCommand {
	run: () => void;
}

const READY_TIMEOUT_DEFAULT = 120_000;
const REQUEST_TIMEOUT_DEFAULT = 20_000;
const IDLE_TIMEOUT_DEFAULT = 60_000;

export class ComputerDriverSession {
	private readonly scriptPath = fileURLToPath(new URL("./computer-driver.ps1", import.meta.url));
	private readonly workerFactory: DriverWorkerFactory;
	private readonly readyTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly idleTimeoutMs: number;

	private worker: ChildProcessWithoutNullStreams | undefined;
	private readyPromise: Promise<void> | undefined;
	private nextRequestId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly queue: QueuedCommand[] = [];
	private draining = false;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private idleTimer: NodeJS.Timeout | undefined;

	/** 最近一次截图的坐标映射；click/scroll 用来换算截图像素 → 屏幕坐标。 */
	private lastScreenshot: ScreenshotMeta | undefined;

	constructor(workerFactory?: DriverWorkerFactory, options: DriverSpawnOptions = {}) {
		this.workerFactory =
			workerFactory ??
			(() =>
				spawn(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
					{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
				));
		this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_DEFAULT;
		this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_DEFAULT;
		this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_DEFAULT;
	}

	// ------------------------------------------------------------------
	// 对工具层暴露的语义命令
	// ------------------------------------------------------------------

	async screenshot(
		monitor: number,
		maxWidth: number,
		quality: number,
		signal?: AbortSignal,
	): Promise<ScreenshotMeta & { jpeg: string }> {
		const data = (await this.command(
			{ cmd: "screenshot", monitor, maxWidth, quality },
			signal,
		)) as unknown as ScreenshotMeta & { jpeg: string };
		this.lastScreenshot = {
			imageWidth: data.imageWidth,
			imageHeight: data.imageHeight,
			screenWidth: data.screenWidth,
			screenHeight: data.screenHeight,
			originX: data.originX,
			originY: data.originY,
		};
		return data;
	}

	async click(
		x: number,
		y: number,
		button: ClickButton,
		double: boolean,
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ clicked: boolean; blocked?: boolean; x: number; y: number; window?: WindowRef | null }> {
		const screen = this.toScreenSpace(x, y);
		return (await this.command({ cmd: "click", x: screen.x, y: screen.y, button, double, expectHwnd }, signal)) as {
			clicked: boolean;
			blocked?: boolean;
			x: number;
			y: number;
			window?: WindowRef | null;
		};
	}

	async type(
		text: string,
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ typed: boolean; blocked?: boolean; foreground?: WindowRef | null }> {
		return (await this.command({ cmd: "type", text, expectHwnd }, signal)) as {
			typed: boolean;
			blocked?: boolean;
			foreground?: WindowRef | null;
		};
	}

	/** down = 按住不放的修饰键 VK 序列，tap = 依次敲击的 VK 序列。 */
	async key(
		down: number[],
		tap: number[],
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ sent: boolean; blocked?: boolean; foreground?: WindowRef | null }> {
		return (await this.command({ cmd: "key", down, tap, expectHwnd }, signal)) as {
			sent: boolean;
			blocked?: boolean;
			foreground?: WindowRef | null;
		};
	}

	async scroll(
		x: number,
		y: number,
		delta: number,
		horizontal: boolean,
		signal?: AbortSignal,
		expectHwnd?: number,
	): Promise<{ scrolled: boolean; blocked?: boolean }> {
		const screen = this.toScreenSpace(x, y);
		return (await this.command(
			{ cmd: "scroll", x: screen.x, y: screen.y, delta, horizontal, expectHwnd },
			signal,
		)) as {
			scrolled: boolean;
			blocked?: boolean;
		};
	}

	async windows(signal?: AbortSignal): Promise<WindowRow[]> {
		const data = (await this.command({ cmd: "windows" }, signal)) as { windows: WindowRow[] };
		return data.windows;
	}

	async focus(hwnd: number, signal?: AbortSignal): Promise<boolean> {
		const data = (await this.command({ cmd: "focus", hwnd }, signal)) as { focused: boolean };
		return data.focused === true;
	}

	async restore(hwnd: number, signal?: AbortSignal): Promise<boolean> {
		const data = (await this.command({ cmd: "restore", hwnd }, signal)) as { restored: boolean };
		return data.restored === true;
	}

	async cursor(signal?: AbortSignal): Promise<{ x: number; y: number }> {
		return (await this.command({ cmd: "cursor" }, signal)) as { x: number; y: number };
	}

	/**
	 * 把最近一张截图的像素坐标换算成虚拟屏幕坐标。工具参数默认在截图像素
	 * 空间里；没有截图底子时直接报错，逼模型先 screenshot。
	 */
	toScreenSpace(x: number, y: number): { x: number; y: number } {
		const meta = this.lastScreenshot;
		if (meta === undefined)
			throw new Error("No screenshot yet; call computer_screenshot first to establish coordinates.");
		const scaleX = meta.screenWidth / meta.imageWidth;
		const scaleY = meta.screenHeight / meta.imageHeight;
		const screenX = Math.round(meta.originX + x * scaleX);
		const screenY = Math.round(meta.originY + y * scaleY);
		return { x: screenX, y: screenY };
	}

	get screenshotMeta(): ScreenshotMeta | undefined {
		return this.lastScreenshot;
	}

	/** 显式停掉 worker（测试清理 / 扩展卸载用）。 */
	close(): void {
		this.stopWorker(new Error("computer-use driver closed."));
	}

	// ------------------------------------------------------------------
	// 协议层
	// ------------------------------------------------------------------

	private command(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			this.queue.push({
				run: () => {
					void this.dispatch(payload, signal).then(resolve, reject);
				},
			});
			void this.drain();
		});
	}

	/** 串行执行：鼠标/键盘操作必须按调用顺序落机。 */
	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const next = this.queue.shift();
				if (next === undefined) continue;
				next.run();
			}
		} finally {
			this.draining = false;
		}
	}

	private async dispatch(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		// 经由函数调用读取 aborted：TS 会把 readonly 属性的收窄跨语句传播，
		// 二次比较会被误报 TS2367。
		const isAborted = () => signal?.aborted === true;
		if (isAborted()) throw abortError(signal);
		const worker = this.ensureWorker();
		try {
			await this.readyPromise;
		} catch (error) {
			// ready 失败（如 csc 缺失）：弃尸重建，下一个请求重新拉起。
			this.stopWorker(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
		if (isAborted()) throw abortError(signal);

		const id = this.nextRequestId++;
		this.clearIdleShutdown();
		const workerAlive = worker;
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (settled) return;
				this.pending.delete(id);
				finish(reject, abortError(signal));
			};
			const finish = (settle: (value: never) => void, value: unknown) => {
				if (settled) return;
				settled = true;
				if (signal !== undefined) signal.removeEventListener("abort", onAbort);
				if (timer !== undefined) clearTimeout(timer);
				settle(value as never);
			};
			timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(`computer-use driver request timed out: ${String(payload.cmd)}`);
				// 超时后 worker 状态不可信（可能已执行一半），弃尸。
				this.stopWorker(error);
				finish(reject, error);
			}, this.requestTimeoutMs);
			timer.unref();
			if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				id,
				resolve: (value) => finish(resolve, value),
				reject: (error) => finish(reject, error),
				timer,
			});
			workerAlive.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, "utf8", (error) => {
				if (error !== null && error !== undefined) this.stopWorker(error);
			});
		});
	}

	private ensureWorker(): ChildProcessWithoutNullStreams {
		if (this.worker !== undefined && this.worker.exitCode === null && !this.worker.killed) return this.worker;
		const worker = this.workerFactory();
		this.worker = worker;
		this.stdoutBuffer = "";
		this.stderrBuffer = "";
		this.nextRequestId = 1;
		worker.stdout.setEncoding("utf8");
		worker.stderr.setEncoding("utf8");
		worker.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
		worker.stderr.on("data", (chunk: string) => {
			this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8192);
		});
		this.readyPromise = this.awaitReady(worker);
		worker.once("error", (error) => {
			if (this.worker === worker) this.stopWorker(error, false);
		});
		worker.once("exit", (code, signal) => {
			if (this.worker !== worker) return;
			const detail = this.stderrBuffer.trim();
			const suffix = detail === "" ? "" : ` ${detail.slice(-400)}`;
			this.stopWorker(new Error(`computer-use driver exited (${signal ?? code ?? "unknown"}).${suffix}`), false);
		});
		return worker;
	}

	private awaitReady(worker: ChildProcessWithoutNullStreams): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("computer-use driver did not signal ready in time."));
			}, this.readyTimeoutMs);
			timer.unref();
			let readyBuffer = "";
			const cleanup = () => {
				clearTimeout(timer);
				worker.stdout.off("data", onData);
				worker.off("exit", onExit);
			};
			const onExit = () => {
				cleanup();
				reject(new Error("computer-use driver exited before ready."));
			};
			const onData = (chunk: string) => {
				readyBuffer += chunk;
				let newline = readyBuffer.indexOf("\n");
				while (newline >= 0) {
					const line = readyBuffer.slice(0, newline).replace(/\r$/, "").trim();
					readyBuffer = readyBuffer.slice(newline + 1);
					if (line === "") continue;
					let event: Record<string, unknown>;
					try {
						event = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
					}
					if (event.event === "ready") {
						cleanup();
						resolve();
						return;
					}
					if (event.event === "error") {
						cleanup();
						reject(new Error(`computer-use driver failed to start: ${String(event.message ?? "unknown")}`));
						return;
					}
					newline = readyBuffer.indexOf("\n");
				}
			};
			worker.stdout.on("data", onData);
			worker.once("exit", onExit);
		});
	}

	private consumeStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.trim() !== "") this.consumeResponse(line);
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	private consumeResponse(line: string): void {
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return; // 非协议行（如意外告警），忽略。
		}
		if (payload.event !== undefined) return; // ready/error 之外的事件留给 ready 监听器
		const id = typeof payload.id === "number" ? payload.id : Number.NaN;
		const pending = this.pending.get(id);
		if (pending === undefined) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (payload.ok === true) pending.resolve(payload.data as Record<string, unknown>);
		else pending.reject(new Error(String(payload.error ?? "computer-use driver command failed")));
		this.scheduleIdleShutdown();
	}

	private stopWorker(error: Error, kill = true): void {
		this.clearIdleShutdown();
		const worker = this.worker;
		this.worker = undefined;
		this.readyPromise = undefined;
		this.stdoutBuffer = "";
		this.stderrBuffer = "";
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		if (kill && worker !== undefined && worker.exitCode === null && !worker.killed) worker.kill();
	}

	private scheduleIdleShutdown(): void {
		this.clearIdleShutdown();
		if (this.pending.size > 0 || this.idleTimeoutMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			this.stopWorker(new Error("computer-use driver became idle."));
		}, this.idleTimeoutMs);
		this.idleTimer.unref();
	}

	private clearIdleShutdown(): void {
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}
}

function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("computer-use request aborted.");
}
