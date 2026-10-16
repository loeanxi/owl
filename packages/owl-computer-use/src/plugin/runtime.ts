import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import type {
	ComputerDriverPort,
	NativeActInput,
	NativeActResult,
	NativeObservation,
	WindowRow,
} from "../driver/protocol.ts";

export interface ComputerRuntimeSettings {
	maxImageWidth?: number;
	observationTtlMs?: number;
	now?: () => number;
}

export interface ComputerOwner {
	sessionId: string;
	imageInput: boolean;
}

export interface ComputerObservation extends NativeObservation {
	windowId?: string;
	windows: (WindowRow & { windowId: string })[];
	code?: string;
	retryable?: boolean;
	nextAction?: string;
}

export interface ComputerRuntimeActResult extends Omit<NativeActResult, "observation"> {
	observation?: ComputerObservation;
}

interface ObservationLease {
	native: NativeObservation;
	sessionId: string;
	generation: number;
	expiresAt: number;
	imageDelivered: boolean;
}

export class ComputerUseRuntime {
	private readonly driver: ComputerDriverPort;
	private readonly maxWidth: number;
	private readonly ttl: number;
	private readonly now: () => number;
	private sessionId: string | undefined;
	private boundSessionId: string | undefined;
	private stoppedRun = false;
	private currentTargetHwnd: number | undefined;
	private foregroundAction: { generation: number; hwnd: number; interrupted: boolean } | undefined;
	private activeAction: { generation: number; hwnd?: number; interrupted: boolean; stopped: boolean } | undefined;
	private pendingObservation: { generation: number; hwnd: number; invalidated: boolean } | undefined;
	private generation = 0;
	private readonly observations = new Map<string, ObservationLease>();
	private readonly aliases = new Map<string, number>();
	private nextAlias = 1;

	constructor(driver: ComputerDriverPort, settings: ComputerRuntimeSettings = {}) {
		this.driver = driver;
		this.maxWidth = Math.min(4096, Math.max(320, settings.maxImageWidth ?? 1568));
		this.ttl = Math.max(1000, settings.observationTtlMs ?? 120_000);
		this.now = settings.now ?? Date.now;
	}

	/** Only the host lifecycle supplies run/session identity; never accept it from tool arguments. */
	beginRun(sessionId: string): void {
		this.invalidateOwner();
		this.sessionId = sessionId;
		this.boundSessionId = sessionId;
		this.stoppedRun = false;
	}

	invalidateOwner(reason?: "user_stopped"): void {
		if (reason === "user_stopped" && this.activeAction?.generation === this.generation)
			this.activeAction.stopped = true;
		this.generation++;
		this.sessionId = undefined;
		this.stoppedRun = true;
		this.currentTargetHwnd = undefined;
		this.foregroundAction = undefined;
		this.activeAction = undefined;
		this.pendingObservation = undefined;
		this.observations.clear();
		this.aliases.clear();
		this.nextAlias = 1;
	}

	async release(_signal?: AbortSignal): Promise<void> {
		this.invalidateOwner();
		// Cleanup must still work after the action's signal was cancelled.
		await this.driver.release();
	}

	async releaseFor(owner: ComputerOwner, signal?: AbortSignal): Promise<void> {
		if (!owner.sessionId || this.boundSessionId !== owner.sessionId) {
			throw new Error("清理资源的宿主会话已切换或不匹配。标准格式：{}；只能释放当前宿主会话持有的桌面资源。");
		}
		await this.release(signal);
	}

	/** Host mirror input targets one window; unrelated windows do not end background UIA work. */
	interruptForWindow(windowId: string): boolean {
		if (this.stoppedRun || this.sessionId === undefined) return false;
		const hwnd = this.aliases.get(windowId) ?? (/^\d+$/.test(windowId) ? Number(windowId) : undefined);
		if (this.foregroundAction === undefined) {
			if (this.pendingObservation?.generation === this.generation && hwnd === this.pendingObservation.hwnd) {
				this.pendingObservation.invalidated = true;
				return false;
			}
			if (hwnd === undefined || hwnd !== this.currentTargetHwnd) return false;
		}
		// Ordinary input invalidates a read/lease, not the whole host run.
		this.observations.clear();
		if (this.pendingObservation?.generation === this.generation) this.pendingObservation.invalidated = true;
		if (this.activeAction?.generation !== this.generation) return false;
		this.activeAction.interrupted = true;
		// Only a real action in flight needs the caller to close the native input worker.
		return true;
	}

	async observe(
		owner: ComputerOwner,
		options: { windowId?: string; windowQuery?: string; includeImage?: boolean } = {},
		signal?: AbortSignal,
	): Promise<ComputerObservation> {
		this.assertOwner(owner);
		if (signal?.aborted) {
			this.invalidateOwner();
			throw new Error("桌面观察已取消。标准格式：{}；请在新的宿主任务中重新观察。");
		}
		const generation = this.generation;
		let windows: WindowRow[];
		try {
			windows = await this.driver.windows(signal);
		} catch (error) {
			if (signal?.aborted && generation === this.generation) this.invalidateOwner();
			throw error;
		}
		if (signal?.aborted && generation === this.generation) this.invalidateOwner();
		this.assertCurrent(owner, generation);
		const rows = windows.map((window) => ({ ...window, windowId: this.aliasFor(window.hwnd) }));
		let hwnd: number | undefined;
		let matches: WindowRow[] | undefined;
		if (options.windowId !== undefined) {
			hwnd = this.aliases.get(options.windowId);
			if (hwnd === undefined && /^\d+$/.test(options.windowId)) hwnd = Number(options.windowId);
			if (hwnd === undefined || !Number.isSafeInteger(hwnd) || hwnd <= 0 || !windows.some((w) => w.hwnd === hwnd)) {
				throw new Error(
					'窗口不存在或不属于本轮枚举。标准格式：{"windowId":"<computer_observe 返回的 windowId>"}；先调用 computer_observe({}) 重新枚举。',
				);
			}
		} else if (options.windowQuery !== undefined) {
			const query = options.windowQuery.trim().toLocaleLowerCase();
			matches = windows.filter((row) => `${row.title}\n${row.process}`.toLocaleLowerCase().includes(query));
			hwnd = matches.length === 1 ? matches[0].hwnd : undefined;
		} else {
			hwnd = windows.find((window) => window.foreground)?.hwnd;
		}
		// A desktop with no foreground application is discovery only, never a full-screen fallback.
		if (hwnd === undefined) {
			let native: NativeObservation;
			try {
				native = await this.driver.observe({ hwnd: 0, includeImage: false, maxWidth: this.maxWidth }, signal);
			} catch (error) {
				if (signal?.aborted && generation === this.generation) this.invalidateOwner();
				throw error;
			}
			if (signal?.aborted && generation === this.generation) this.invalidateOwner();
			this.assertCurrent(owner, generation);
			const ambiguous = matches !== undefined && matches.length > 1;
			return {
				...this.adopt(native, owner, rows, false),
				code: ambiguous
					? "target_ambiguous"
					: options.windowQuery === undefined
						? "no_foreground"
						: "target_not_found",
				retryable: true,
				nextAction: ambiguous
					? '多个窗口匹配，请根据 windows 标题选择 windowId，再调用 computer_observe({"windowId":"<id>"})。'
					: '从 windows 选择 windowId 重新观察；目标应用未打开且任务需要它时，调用 computer_act({"observationId":"<本次令牌>","action":"open_app","app":"<exe名、完整exe路径或AUMID>"})，然后核对新窗口。',
				diagnostics: [
					ambiguous
						? `找到 ${matches?.length} 个匹配窗口；未擅自选择或操作。`
						: options.windowQuery === undefined
							? "未找到前台应用，已发放仅用于打开应用的发现令牌。"
							: `未找到匹配 ${options.windowQuery} 的窗口；可以打开任务需要的应用。`,
				],
			};
		}
		const includeImage = owner.imageInput && options.includeImage !== false;
		const pending = { generation, hwnd, invalidated: false };
		this.pendingObservation = pending;
		this.observations.clear();
		let native: NativeObservation;
		try {
			native = await this.driver.observe({ hwnd, includeImage, maxWidth: this.maxWidth }, signal);
		} catch (error) {
			if (signal?.aborted && generation === this.generation) this.invalidateOwner();
			if (
				!pending.invalidated ||
				signal?.aborted ||
				generation !== this.generation ||
				this.sessionId !== owner.sessionId
			)
				throw error;
			native = {
				observationId: "",
				target: windows.find((row) => row.hwnd === hwnd) ?? null,
				elements: [],
				capabilities: { uia: false, windowCapture: false, input: false },
				diagnostics: [`observation_changed: ${error instanceof Error ? error.message : String(error)}`],
			};
		} finally {
			if (this.pendingObservation === pending) this.pendingObservation = undefined;
		}
		if (generation === this.generation && signal?.aborted) this.invalidateOwner();
		this.assertCurrent(owner, generation);
		if (pending.invalidated) {
			native = {
				...native,
				observationId: "",
				screenshot: undefined,
				diagnostics: [
					...(native.diagnostics ?? []),
					"observation_changed: mirror input changed the target during this read",
				],
			};
		}
		return this.adopt(native, owner, rows, includeImage);
	}

	async act(owner: ComputerOwner, input: NativeActInput, signal?: AbortSignal): Promise<ComputerRuntimeActResult> {
		if (this.stoppedRun) {
			return {
				status: "blocked",
				code: "run_stopped",
				message: "当前宿主任务的桌面操作已停止，需新的宿主任务才能恢复。",
			};
		}
		if (!owner.sessionId || this.sessionId !== owner.sessionId) {
			return {
				status: "blocked",
				code: "owner_mismatch",
				message: "观察令牌不属于当前会话，请重新 computer_observe。",
			};
		}
		const lease = this.observations.get(input.observationId);
		if (!lease || lease.sessionId !== owner.sessionId || lease.generation !== this.generation) {
			return { status: "blocked", code: "stale_observation", message: "观察令牌已失效，请重新 computer_observe。" };
		}
		if (signal?.aborted) {
			this.invalidateOwner();
			return { status: "blocked", code: "cancelled", message: "桌面操作已取消，等待新的宿主任务。" };
		}
		this.observations.delete(input.observationId);
		if (lease.expiresAt <= this.now()) {
			return { status: "blocked", code: "expired_observation", message: "观察已过期，请重新 computer_observe。" };
		}
		const native = lease.native;
		const inputMode = input.inputMode ?? "auto";
		const semantic = ["invoke", "set_value", "select", "toggle"].includes(input.action);
		const opening = input.action === "open_app";
		if (!native.target && !opening) {
			return {
				status: "blocked",
				code: "target_required",
				requestedMode: inputMode,
				retryable: true,
				message: "本次为发现令牌，只能打开应用，不能对未知窗口输入。",
				nextAction:
					'从 windows 选择 windowId 重新观察，或 computer_act({"observationId":"<新的发现令牌>","action":"open_app","app":"<应用exe名或路径>"})。',
			};
		}
		if (opening && (input.app === undefined || !validApplicationTarget(input.app))) {
			return {
				status: "blocked",
				code: "invalid_app",
				requestedMode: inputMode,
				retryable: false,
				message:
					'应用入口无效。标准格式：{"observationId":"<当前令牌>","action":"open_app","app":"notepad.exe"}；只接受exe名、完整exe路径或AUMID，不接受命令行和参数。',
			};
		}
		const element =
			input.elementId === undefined ? undefined : native.elements.find((row) => row.id === input.elementId);
		if (input.elementId !== undefined && (!element || !element.enabled)) {
			return { status: "blocked", code: "element_unavailable", message: "控件不存在或已禁用，请重新观察。" };
		}
		const backgroundCandidate =
			opening ||
			(native.capabilities.uia &&
				native.capabilities.backgroundUia &&
				(semantic ||
					(input.action === "scroll" &&
						element?.patterns.some((value) => /^scroll(pattern(?:identifiers)?)?$/i.test(value))) ||
					(input.action === "type" &&
						input.replace === true &&
						element?.patterns.some(
							(value) => value.toLowerCase().replace(/pattern(?:identifiers)?$/, "") === "value",
						)) ||
					(input.action === "click" &&
						element !== undefined &&
						input.button !== "right" &&
						input.button !== "middle" &&
						!input.double &&
						element.patterns.some((value) =>
							/^(invoke|selectionitem|toggle)(pattern(?:identifiers)?)?$/i.test(value),
						))));
		if (inputMode === "background" && !semantic && !opening && !backgroundCandidate) {
			return {
				status: "blocked",
				code: "foreground_required",
				requiresExclusive: true,
				message:
					'该动作不能在指定的 background 模式执行。请重新观察并使用 inputMode:"auto"，工具会按可用能力选择方式。',
			};
		}
		if (!opening && !native.capabilities.input && (inputMode === "foreground" || !backgroundCandidate)) {
			return {
				status: "blocked",
				code: "input_unavailable",
				requestedMode: inputMode,
				retryable: true,
				message: "当前窗口没有可用的输入方式。",
				nextAction: "重新观察能力与控件，选择支持的 UIA pattern；若应用权限更高，使用匹配权限的 Owl 宿主后重试。",
			};
		}
		const coordinate = (input.action === "click" || input.action === "scroll") && input.elementId === undefined;
		if (coordinate) {
			if (!owner.imageInput || !lease.imageDelivered || !native.screenshot) {
				return {
					status: "blocked",
					code: "image_required",
					message: "坐标输入需要本轮已交付给视觉模型的窗口截图；请使用可用 elementId 或切换视觉模型后重新观察。",
				};
			}
			if (
				input.x === undefined ||
				input.y === undefined ||
				!Number.isFinite(input.x) ||
				!Number.isFinite(input.y) ||
				input.x < 0 ||
				input.y < 0 ||
				input.x >= native.screenshot.imageWidth ||
				input.y >= native.screenshot.imageHeight
			) {
				return {
					status: "blocked",
					code: "coordinate_out_of_bounds",
					message: "坐标超出当前截图，请使用截图像素坐标。",
				};
			}
		}
		const requiredPattern: Partial<Record<NativeActInput["action"], string>> = {
			invoke: "invoke",
			set_value: "value",
			select: "selectionitem",
			toggle: "toggle",
		};
		const pattern = requiredPattern[input.action];
		if (
			pattern !== undefined &&
			(!native.capabilities.uia ||
				!element ||
				!element.patterns.some((value) => value.toLowerCase().replace(/pattern(?:identifiers)?$/, "") === pattern))
		) {
			return {
				status: "blocked",
				code: "pattern_unavailable",
				message: "此控件不支持该 UIA 动作，请选择它公开支持的 pattern。",
			};
		}
		if (inputMode === "background" && !opening && native.capabilities.backgroundUia !== true) {
			return {
				status: "blocked",
				code: "background_uia_unavailable",
				requiresExclusive: true,
				message:
					'此窗口未提供背景 UIA 操作能力。重新观察并用 inputMode:"auto" 由工具评估前台方式，或选择其它支持的控件。',
			};
		}
		const generation = this.generation;
		const action = { generation, hwnd: native.target?.hwnd, interrupted: false, stopped: false };
		this.activeAction = action;
		const foreground =
			inputMode === "foreground" || (inputMode === "auto" && !backgroundCandidate)
				? { generation, hwnd: native.target?.hwnd ?? 0, interrupted: false }
				: undefined;
		this.foregroundAction = foreground;
		let result: NativeActResult;
		try {
			result = await this.driver.act({ ...input, inputMode, observationId: native.observationId }, signal);
		} catch (error) {
			result = {
				status: "unknown",
				code: action.stopped ? "user_stopped" : signal?.aborted ? "cancelled" : "driver_error",
				message: action.stopped
					? "用户已明确停止电脑控制；本次动作结果可能未知，等待新的用户指令，不要继续观察或重复输入。"
					: `${error instanceof Error ? error.message : String(error)}；输入结果未知，请观察后决定，勿重复提交动作。`,
				...(action.stopped
					? {
							retryable: false,
							nextAction: "用户已明确停止电脑控制。不要继续观察或自动重试输入，等待新的用户指令。",
						}
					: {}),
			};
		} finally {
			if (this.foregroundAction === foreground) this.foregroundAction = undefined;
			if (this.activeAction === action) this.activeAction = undefined;
		}
		// Driver observations use native tokens. Never expose them without host ownership binding.
		const actionResult: ComputerRuntimeActResult = {
			status: result.status,
			...(result.code === undefined ? {} : { code: result.code }),
			...(result.message === undefined ? {} : { message: result.message }),
			...(result.typedCharacters === undefined ? {} : { typedCharacters: result.typedCharacters }),
			...(result.requiresExclusive === undefined ? {} : { requiresExclusive: result.requiresExclusive }),
			requestedMode: result.requestedMode ?? inputMode,
			...(result.executedMode === undefined ? {} : { executedMode: result.executedMode }),
			...(result.executedAction === undefined ? {} : { executedAction: result.executedAction }),
			...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
			...(result.idleWaitMs === undefined ? {} : { idleWaitMs: result.idleWaitMs }),
			...(result.idleGrantedAtMs === undefined ? {} : { idleGrantedAtMs: result.idleGrantedAtMs }),
			...(result.idleQuietForMs === undefined ? {} : { idleQuietForMs: result.idleQuietForMs }),
			...(result.retryable === undefined ? {} : { retryable: result.retryable }),
			...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
			...(result.nextAction === undefined ? {} : { nextAction: result.nextAction }),
			...(result.target === undefined ? {} : { target: result.target }),
		};
		if (generation !== this.generation || this.sessionId !== owner.sessionId) return actionResult;
		if (
			signal?.aborted ||
			["user_interrupted", "physical_escape", "user_stopped", "cancelled"].includes(result.code ?? "")
		) {
			this.invalidateOwner();
			return actionResult;
		}
		if (action.interrupted) {
			return {
				...actionResult,
				code: actionResult.code ?? "input_interrupted",
				retryable: actionResult.status === "blocked",
				nextAction:
					"本次操作受到用户输入影响。调用 computer_observe 读取实际状态再决定下一步，勿直接重发未知或部分输入。",
			};
		}
		if (result.status === "unknown" || result.status === "partial") {
			actionResult.retryable = false;
			actionResult.nextAction =
				"调用 computer_observe 检查当前实际状态，结合已输入字符与控件内容决定剩余动作；勿重复提交本次动作。";
		} else if (result.status === "blocked") {
			actionResult.retryable ??= true;
			actionResult.nextAction ??=
				'重新 computer_observe 取得最新令牌，再选择支持的控件动作或 inputMode:"auto"；不要使用旧令牌。';
		}
		const target = result.target ?? native.target;
		if (target === null) {
			actionResult.nextAction ??=
				'调用 computer_observe({"windowQuery":"<目标标题或进程关键词>"}) 核对启动后的窗口。';
			return actionResult;
		}
		// Never replay input after a timeout, cancellation, or unknown outcome.
		try {
			const observation = await this.driver.observe(
				{ hwnd: target.hwnd, includeImage: owner.imageInput, maxWidth: this.maxWidth },
				signal,
			);
			if (generation === this.generation && signal?.aborted) this.invalidateOwner();
			this.assertCurrent(owner, generation);
			return { ...actionResult, observation: this.adopt(observation, owner, [], owner.imageInput) };
		} catch (error) {
			if (signal?.aborted && generation === this.generation) this.invalidateOwner();
			return {
				...actionResult,
				message: `${result.message ?? "动作已返回"}；后续观察失败：${error instanceof Error ? error.message : String(error)}。请重新 computer_observe，勿据此认定业务完成。`,
			};
		}
	}

	private assertOwner(owner: ComputerOwner): void {
		if (this.stoppedRun)
			throw new Error(
				"当前宿主任务的桌面操作已停止。标准格式：{}；请在新的宿主任务中调用 computer_observe，不能在当前任务自动恢复。",
			);
		if (!owner.sessionId)
			throw new Error("无法取得宿主会话身份。标准格式：{}；请通过 Owl 当前会话调用 computer_observe。");
		if (this.sessionId === undefined) {
			this.sessionId = owner.sessionId;
			this.boundSessionId = owner.sessionId;
		}
		if (this.sessionId !== owner.sessionId)
			throw new Error("宿主会话已切换。标准格式：{}；请在当前会话重新调用 computer_observe。");
	}

	private assertCurrent(owner: ComputerOwner, generation: number): void {
		if (this.sessionId !== owner.sessionId || generation !== this.generation) {
			throw new Error("观察期间宿主任务已结束或切换，请重新 computer_observe({})。");
		}
	}

	private aliasFor(hwnd: number): string {
		for (const [alias, value] of this.aliases) if (value === hwnd) return alias;
		const alias = `w${this.nextAlias++}`;
		this.aliases.set(alias, hwnd);
		return alias;
	}

	private adopt(
		native: NativeObservation,
		owner: ComputerOwner,
		windows: ComputerObservation["windows"],
		imageDelivered: boolean,
	): ComputerObservation {
		this.observations.clear();
		this.currentTargetHwnd = native.target?.hwnd;
		const conflict =
			native.diagnostics?.some((text) => /^(user_intervened|observation_changed):/.test(text)) === true;
		const observationId = native.observationId && !conflict ? randomUUID() : "";
		if (observationId) {
			this.observations.set(observationId, {
				native,
				sessionId: owner.sessionId,
				generation: this.generation,
				expiresAt: this.now() + this.ttl,
				imageDelivered: imageDelivered && native.screenshot !== undefined,
			});
		}
		return {
			...native,
			elements: native.elements.map((element) => {
				if (!element.password) return element;
				const { value: _value, text: _text, isReadOnly: _isReadOnly, truncated: _truncated, ...safe } = element;
				return safe;
			}),
			observationId,
			...(native.target ? { windowId: this.aliasFor(native.target.hwnd) } : {}),
			windows,
			...(conflict
				? {
						diagnostics: [
							...(native.diagnostics ?? []),
							"read_conflict: 观察期间状态发生变化，未发放动作令牌；任务未停止，请重新 computer_observe。",
						],
						code: "read_conflict",
						retryable: true,
						nextAction:
							'重新调用 computer_observe({"windowId":"<本次 windowId>"}) 读取稳定状态；任务仍可继续，不需要新宿主任务。',
					}
				: {}),
			...(!imageDelivered ? { screenshot: undefined } : {}),
		};
	}
}

/** An application entry is distinct from a shell command or a document/URL launch. */
export function validApplicationTarget(app: string): boolean {
	if (!app || app !== app.trim() || app.length > 1000 || /[\x00-\x1f"<>|?*;&`]/.test(app)) return false;
	if (/^(notepad|记事本|calculator|计算器|calc)$/i.test(app)) return true;
	if (/^[A-Za-z0-9][A-Za-z0-9._-]*![A-Za-z0-9._-]+$/.test(app)) return true;
	if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/i.test(app)) return true;
	return win32.isAbsolute(app) && /^[A-Za-z]:\\/.test(app) && /\.exe$/i.test(app) && !/[!%]/.test(app);
}
