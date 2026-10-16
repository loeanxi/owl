import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
	ToolInfo,
} from "@owl/owl-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopControlInterruption } from "../../coding-agent/src/core/desktop-control-channel.ts";
import type { ExtensionToolContext as ToolSearchContext } from "../../coding-agent/src/core/extensions/types.ts";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import { createToolSearchToolDefinition } from "../../coding-agent/src/extensions/tool-search/tool.ts";
import computerUsePlugin from "../index.ts";
import type {
	ComputerDriverPort,
	NativeActInput,
	NativeActResult,
	NativeObservation,
	WindowRow,
} from "../src/driver/protocol.ts";
import type { DriverControlStop, DriverSpawnOptions } from "../src/driver/session.ts";

const mockHost = vi.hoisted(() => ({
	driver: undefined as (ComputerDriverPort & { close(): void }) | undefined,
	interrupt: undefined as ((event: DesktopControlInterruption) => void) | undefined,
	onControlStop: undefined as ((event: DriverControlStop) => void) | undefined,
}));

vi.mock("@owl/owl-coding-agent", () => ({
	subscribeDesktopControlInterruption: (listener: (event: DesktopControlInterruption) => void) => {
		mockHost.interrupt = listener;
		return () => {
			mockHost.interrupt = undefined;
		};
	},
}));
vi.mock("../src/driver/session.ts", () => ({
	ComputerDriverSession: class {
		private readonly driver: ComputerDriverPort & { close(): void };
		constructor(_factory?: unknown, options: DriverSpawnOptions = {}) {
			if (!mockHost.driver) throw new Error("Missing lifecycle fixture driver");
			this.driver = mockHost.driver;
			mockHost.onControlStop = options.onControlStop;
		}
		setControlOwner(ownerId: string | undefined) {
			if (this.driver instanceof FakeDriver) this.driver.controlOwnerId = ownerId;
		}
		windows(signal?: AbortSignal) {
			return this.driver.windows(signal);
		}
		observe(input: { hwnd?: number; includeImage?: boolean; maxWidth?: number }, signal?: AbortSignal) {
			return this.driver.observe(input, signal);
		}
		act(input: NativeActInput, signal?: AbortSignal) {
			return this.driver.act(input, signal);
		}
		release(signal?: AbortSignal) {
			return this.driver.release(signal);
		}
		close() {
			this.driver.close();
		}
	},
}));

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const window: WindowRow = {
	hwnd: 42,
	title: "isolated lifecycle fixture",
	class: "Edit",
	process: "test-app",
	pid: 100,
	x: 0,
	y: 0,
	w: 800,
	h: 600,
	minimized: false,
	foreground: true,
};

class FakeDriver implements ComputerDriverPort {
	closeCount = 0;
	releaseCount = 0;
	releaseWait: Promise<void> | undefined;
	observeWait: Promise<void> | undefined;
	diagnostics: string[] = [];
	controlOwnerId: string | undefined;
	onClose: (() => void) | undefined;
	async windows(): Promise<WindowRow[]> {
		return [{ ...window }];
	}
	async observe(): Promise<NativeObservation> {
		await this.observeWait;
		return {
			observationId: "native-token",
			target: { ...window },
			elements: [],
			capabilities: { uia: true, windowCapture: false, input: true },
			diagnostics: this.diagnostics,
		};
	}
	async act(_input: NativeActInput): Promise<NativeActResult> {
		return { status: "issued" };
	}
	async release(): Promise<void> {
		this.releaseCount++;
		await this.releaseWait;
	}
	close(): void {
		this.closeCount++;
		this.onClose?.();
	}
}

type LifecycleHandler = (event: { type: string; reason?: string; aborted?: boolean }, ctx: ExtensionContext) => unknown;

function context(sessionId = "chat-a", abort: () => void = () => {}): ExtensionToolContext {
	return {
		sessionManager: { getSessionId: () => sessionId, buildSessionProjection: () => ({ messages: [] }) },
		model: { input: ["text", "image"] },
		abort,
	} as unknown as ExtensionToolContext;
}

function createHost() {
	const driver = new FakeDriver();
	mockHost.driver = driver;
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, LifecycleHandler>();
	const events: string[] = [];
	let active: string[] = [];
	const abort = vi.fn();
	const api = {
		getSettings: () => ({ owlComputerUse: { enabled: true } }),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (event: string, handler: LifecycleHandler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	};
	computerUsePlugin(api as unknown as ExtensionAPI);
	const onControlStop = mockHost.onControlStop;
	return {
		driver,
		tools,
		events,
		abort,
		stopControl(event: Partial<DriverControlStop> = {}) {
			onControlStop?.({
				controlId: "native-control",
				requestId: 1,
				workerGeneration: 1,
				ownerId: driver.controlOwnerId,
				...event,
			});
		},
		async emit(type: string, sessionId = "chat-a", reason?: string) {
			events.push(type);
			await handlers.get(type)?.({ type, reason }, context(sessionId, abort));
		},
		async call(name: string, params: Record<string, unknown> = {}, sessionId = "chat-a") {
			const tool = tools.get(name);
			if (!tool) throw new Error("Tool was not registered: " + name);
			return tool.execute("test-call", params, undefined, undefined, context(sessionId));
		},
		searchTools: {
			getAllTools: (): ToolInfo[] =>
				[...tools.values()].map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					exposure: tool.exposure ?? "direct",
					sourceInfo: { path: "<test:computer-use>", source: "test", scope: "temporary", origin: "top-level" },
				})),
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = [...names];
			},
		},
	};
}

describe("computer-use real plugin lifecycle", () => {
	beforeEach(() => {
		mockHost.driver = undefined;
		mockHost.interrupt = undefined;
		mockHost.onControlStop = undefined;
	});

	it("startup then agent_start and actual tool_search activation does not reset the run", async () => {
		const host = createHost();
		await host.emit("session_start", "chat-a", "startup");
		await host.emit("agent_start");
		const search = createToolSearchToolDefinition({ tools: host.searchTools });
		const result = await search.execute(
			"search",
			{ query: "computer_observe" },
			undefined,
			undefined,
			context() as unknown as ToolSearchContext,
		);
		expect(result.details.loaded).toContain("computer_observe");
		expect(host.events).toEqual(["session_start", "agent_start"]);
		expect((await host.call("computer_observe")).structuredContent).toMatchObject({ status: "observed" });
	});

	it("loads all three named computer tools from the actual failed discovery query", async () => {
		const host = createHost();
		host.searchTools.setActiveTools(["computer_observe"]);
		const search = createToolSearchToolDefinition({ tools: host.searchTools });
		const result = await search.execute(
			"search",
			{ query: "computer_observe computer_act computer_release 桌面计算机操作", limit: 8 },
			undefined,
			undefined,
			context() as unknown as ToolSearchContext,
		);
		expect(result.details.loaded).toEqual(["computer_act", "computer_release"]);
		expect(host.searchTools.getActiveTools()).toEqual(["computer_observe", "computer_act", "computer_release"]);
	});

	it("does not substitute observation for the act step in the actual failed discovery batch", async () => {
		const host = createHost();
		host.searchTools.setActiveTools(["computer_observe"]);
		const search = createToolSearchToolDefinition({ tools: host.searchTools });
		const result = await search.execute(
			"search",
			{
				steps: [
					{
						capability: "computer",
						action: "observe",
						target: "窗口与控件观察",
						query: "computer_observe 观察窗口 UIA 控件与截图",
					},
					{
						capability: "computer",
						action: "act",
						target: "输入文本 点击 按键",
						query: "computer_act 键盘输入 点击 快捷键",
					},
					{
						capability: "computer",
						action: "release",
						target: "释放桌面控制资源",
						query: "computer_release 释放本会话资源",
					},
				],
				limit: 8,
			},
			undefined,
			undefined,
			context() as unknown as ToolSearchContext,
		);
		expect(result.details.loaded).toEqual(["computer_act", "computer_release"]);
		expect(result.details.steps[1].tools.map((tool) => tool.name)).toEqual(["computer_act"]);
	});

	it.each(["computer_observe", "computer_act", "computer_release"])(
		"injects the adaptive desktop task policy when only %s is loaded",
		(name) => {
			const host = createHost();
			const tool = host.tools.get(name);
			const prompt = buildSystemPrompt({
				cwd: ".",
				selectedTools: [name],
				toolGuidelines: { [name]: tool?.promptGuidelines ?? [] },
			});
			expect(prompt).toContain("inputMode:auto");
			expect(prompt).toContain("windowQuery");
			expect(prompt).toContain("open_app");
			expect(prompt).toContain("read_conflict");
			expect(prompt).toContain("nextAction");
			expect(prompt).toContain("用户明确要求");
			expect(prompt).toContain("unknown/partial");
			expect(prompt).not.toContain("不得自动切换模式");
			expect(prompt).not.toContain("中断真实动作后等待新的宿主任务");
		},
	);

	it("deduplicates task guidance when observation and action are both loaded", () => {
		const host = createHost();
		const toolGuidelines = Object.fromEntries(
			[...host.tools].map(([name, tool]) => [name, tool.promptGuidelines ?? []]),
		);
		const prompt = buildSystemPrompt({ cwd: ".", selectedTools: [...host.tools.keys()], toolGuidelines });
		expect(prompt.match(/执行当前桌面任务时/g)).toHaveLength(1);
	});

	it("resource cleanup remains available after physical interruption stops observation", async () => {
		const host = createHost();
		await host.emit("agent_start");
		await host.call("computer_observe");
		mockHost.interrupt?.({ reason: "user-projection-input", windowId: "42" });
		await expect(host.call("computer_release")).resolves.toMatchObject({ structuredContent: { status: "released" } });
	});

	it("projection input in an unrelated window does not stop read-only observation", async () => {
		const host = createHost();
		await host.emit("agent_start");
		await host.call("computer_observe");
		const closes = host.driver.closeCount;
		mockHost.interrupt?.({ reason: "user-projection-input", windowId: "999" });
		expect(host.driver.closeCount).toBe(closes);
		await expect(host.call("computer_observe")).resolves.toMatchObject({ structuredContent: { status: "observed" } });
	});

	it("an observe-only native input conflict does not permanently stop retries in this run", async () => {
		const host = createHost();
		await host.emit("agent_start");
		host.driver.diagnostics = ["user_intervened: external input changed during observe"];
		// This is the native diagnostic that reached assertCurrent and produced the user's
		// lifecycle-looking error even with no session_start/reload or interruption event.
		await host.call("computer_observe").catch(() => undefined);
		host.driver.diagnostics = [];
		await expect(host.call("computer_observe")).resolves.toMatchObject({ structuredContent: { status: "observed" } });
		expect(host.events).toEqual(["agent_start"]);
	});

	it("an old settled cleanup cannot close the worker used by a new run", async () => {
		const host = createHost();
		await host.emit("agent_start", "chat-a");
		await host.call("computer_observe");
		const delayed = deferred();
		host.driver.releaseWait = delayed.promise;
		const oldCleanup = host.emit("agent_settled", "chat-a");
		await host.emit("agent_start", "chat-b");
		expect((await host.call("computer_observe", {}, "chat-b")).structuredContent).toMatchObject({
			status: "observed",
		});
		const closesBeforeOldCleanup = host.driver.closeCount;
		delayed.resolve();
		await oldCleanup;
		expect(host.driver.closeCount).toBe(closesBeforeOldCleanup);
	});

	it("native control Stop revokes the run before closing input and aborts its owning host", async () => {
		const host = createHost();
		await host.emit("agent_start");
		await host.call("computer_observe");
		expect(host.driver.controlOwnerId).toBeTypeOf("string");
		const close = vi.spyOn(host.driver, "close");
		host.stopControl();
		expect(close).toHaveBeenCalledOnce();
		expect(host.abort).toHaveBeenCalledOnce();
		expect(close.mock.invocationCallOrder[0]).toBeLessThan(host.abort.mock.invocationCallOrder[0]);
		await expect(host.call("computer_observe")).rejects.toThrow("桌面操作已停止");
		await expect(host.call("computer_release")).resolves.toMatchObject({ structuredContent: { status: "released" } });
	});

	it("a late control Stop cannot abort the next run of the same chat", async () => {
		const host = createHost();
		await host.emit("agent_start");
		const oldOwner = host.driver.controlOwnerId;
		await host.emit("agent_start");
		expect(host.driver.controlOwnerId).not.toBe(oldOwner);
		const closes = host.driver.closeCount;
		host.stopControl({ ownerId: oldOwner });
		expect(host.abort).not.toHaveBeenCalled();
		expect(host.driver.closeCount).toBe(closes);
		await expect(host.call("computer_observe")).resolves.toMatchObject({ structuredContent: { status: "observed" } });
	});

	it("native Stop cancels only the owning plugin host", async () => {
		const first = createHost();
		await first.emit("agent_start", "chat-a");
		const second = createHost();
		await second.emit("agent_start", "chat-b");
		first.stopControl();
		expect(first.abort).toHaveBeenCalledOnce();
		expect(second.abort).not.toHaveBeenCalled();
		expect(second.driver.closeCount).toBe(0);
	});

	it("a stopped in-flight action remains unknown and cannot obtain another token", async () => {
		const host = createHost();
		await host.emit("agent_start");
		const observed = await host.call("computer_observe");
		const content = observed.structuredContent as { observation: { observationId: string } };
		const entered = deferred();
		const finish = deferred();
		vi.spyOn(host.driver, "act").mockImplementationOnce(async () => {
			entered.resolve();
			await finish.promise;
			throw new Error("native worker closed after Stop");
		});
		const action = host.call("computer_act", {
			observationId: content.observation.observationId,
			action: "type",
			text: "abc",
		});
		await entered.promise;
		host.stopControl();
		finish.resolve();
		expect((await action).structuredContent).toMatchObject({
			status: "unknown",
			code: "user_stopped",
			retryable: false,
		});
		await expect(host.call("computer_observe")).rejects.toThrow("桌面操作已停止");
	});

	it("an old native cleanup rejection cannot close a replacement run", async () => {
		const host = createHost();
		await host.emit("agent_start");
		const delayed = deferred();
		vi.spyOn(host.driver, "release").mockImplementationOnce(async () => {
			await delayed.promise;
			throw new Error("old worker closed by next run");
		});
		const oldCleanup = host.emit("agent_settled");
		await host.emit("agent_start");
		delayed.resolve();
		await expect(oldCleanup).resolves.toBeUndefined();
		await expect(host.call("computer_observe")).resolves.toMatchObject({ structuredContent: { status: "observed" } });
	});

	it("still surfaces cleanup failures belonging to the current run", async () => {
		const host = createHost();
		await host.emit("agent_start");
		vi.spyOn(host.driver, "release").mockRejectedValueOnce(new Error("current cleanup failure"));
		await expect(host.emit("agent_settled")).rejects.toThrow("current cleanup failure");
	});

	it("a synchronous run replacement during Stop cleanup is not aborted by the old callback", async () => {
		const host = createHost();
		await host.emit("agent_start");
		host.driver.onClose = () => {
			void host.emit("agent_start");
		};
		host.stopControl();
		expect(host.abort).not.toHaveBeenCalled();
		host.driver.onClose = undefined;
		await expect(host.call("computer_observe")).resolves.toMatchObject({ structuredContent: { status: "observed" } });
	});
});
