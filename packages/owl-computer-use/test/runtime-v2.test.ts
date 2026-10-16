import type { ExtensionToolContext } from "@owl/owl-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type {
	ComputerDriverPort,
	NativeActInput,
	NativeActResult,
	NativeObservation,
	WindowRow,
} from "../src/driver/protocol.ts";
import { ComputerUseRuntime } from "../src/plugin/runtime.ts";
import { createComputerTools } from "../src/plugin/tools-v2.ts";

const window: WindowRow = {
	hwnd: 42,
	pid: 123,
	process: "test-app",
	title: "isolated test window",
	class: "Edit",
	x: -800,
	y: 20,
	w: 800,
	h: 600,
	minimized: false,
	foreground: true,
};
const jpeg = "/9j/2Q==";
const imageOwner = { sessionId: "chat-a", imageInput: true };
const textOwner = { sessionId: "chat-a", imageInput: false };

class FakeDriver implements ComputerDriverPort {
	readonly actions: NativeActInput[] = [];
	readonly observations: { hwnd?: number; includeImage?: boolean; maxWidth?: number }[] = [];
	windowRows = [{ ...window }];
	uia = true;
	backgroundUia = true;
	patterns = ["Value", "Invoke"];
	input = true;
	imageAvailable = true;
	diagnostics: string[] = [];
	result: NativeActResult = { status: "issued" };
	actError: Error | undefined;
	released = 0;
	private counter = 0;

	async windows(): Promise<WindowRow[]> {
		return this.windowRows;
	}
	async observe(options: { hwnd?: number; includeImage?: boolean; maxWidth?: number }): Promise<NativeObservation> {
		this.observations.push(options);
		return {
			observationId: `native-${++this.counter}`,
			target: this.windowRows.find((row) => row.hwnd === options.hwnd) ?? null,
			elements: [
				{
					id: "e1",
					name: "Name",
					controlType: "Edit",
					enabled: true,
					password: false,
					rect: { x: -780, y: 40, width: 100, height: 30 },
					patterns: this.patterns,
				},
			],
			capabilities: {
				uia: this.uia,
				windowCapture: this.imageAvailable,
				input: this.input,
				backgroundUia: this.backgroundUia,
			},
			diagnostics: this.diagnostics,
			...(options.includeImage && this.imageAvailable
				? {
						screenshot: {
							imageWidth: 400,
							imageHeight: 300,
							screenWidth: 800,
							screenHeight: 600,
							originX: -800,
							originY: 20,
							jpeg,
						},
					}
				: {}),
		};
	}
	async act(input: NativeActInput): Promise<NativeActResult> {
		this.actions.push(input);
		if (this.actError) throw this.actError;
		return this.result;
	}
	async release(): Promise<void> {
		this.released++;
	}
}

function context(sessionId = "chat-a", imageInput = true): ExtensionToolContext {
	// Only these host-supplied fields are read by the tools; no real agent/provider is started.
	return {
		sessionManager: { getSessionId: () => sessionId },
		model: { input: imageInput ? ["text", "image"] : ["text"] },
	} as ExtensionToolContext;
}

describe("host-owned computer observations", () => {
	it("mirror input to an unrelated window does not invalidate the pending read", async () => {
		const driver = new FakeDriver();
		driver.windowRows.push({ ...window, hwnd: 99, pid: 999, foreground: false });
		const runtime = new ComputerUseRuntime(driver);
		await runtime.observe(imageOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const observe = driver.observe.bind(driver);
		vi.spyOn(driver, "observe").mockImplementationOnce(async (options) => {
			entered.resolve();
			await finish.promise;
			return observe(options);
		});
		const pending = runtime.observe(imageOwner, { windowId: "99" });
		await entered.promise;
		expect(runtime.interruptForWindow("111")).toBe(false);
		finish.resolve();
		const fresh = await pending;
		expect(fresh.observationId).not.toBe("");
		expect(fresh.screenshot).toBeDefined();
	});

	it("takeover of the already adopted window invalidates a pending read but allows recovery", async () => {
		const driver = new FakeDriver();
		driver.windowRows.push({ ...window, hwnd: 99, pid: 999, foreground: false });
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const observe = driver.observe.bind(driver);
		vi.spyOn(driver, "observe").mockImplementationOnce(async (options) => {
			entered.resolve();
			await finish.promise;
			return observe(options);
		});
		const pending = runtime.observe(imageOwner, { windowId: "99" });
		await entered.promise;
		expect(runtime.interruptForWindow(first.windowId!)).toBe(false);
		finish.resolve();
		expect(await pending).toMatchObject({ observationId: "", code: "read_conflict", retryable: true });
		expect((await runtime.observe(imageOwner)).observationId).not.toBe("");
	});

	it("old pending read completion cannot erase the new run's pending target marker", async () => {
		const driver = new FakeDriver();
		driver.windowRows.push({ ...window, hwnd: 99, pid: 999, foreground: false });
		const runtime = new ComputerUseRuntime(driver);
		const oldEntered = Promise.withResolvers<void>();
		const oldFinish = Promise.withResolvers<void>();
		const newEntered = Promise.withResolvers<void>();
		const newFinish = Promise.withResolvers<void>();
		const observe = driver.observe.bind(driver);
		vi.spyOn(driver, "observe")
			.mockImplementationOnce(async (options) => {
				oldEntered.resolve();
				await oldFinish.promise;
				return observe(options);
			})
			.mockImplementationOnce(async (options) => {
				newEntered.resolve();
				await newFinish.promise;
				return observe(options);
			});
		const old = runtime.observe(imageOwner, { windowId: "99" });
		await oldEntered.promise;
		runtime.beginRun("chat-b");
		const nextOwner = { sessionId: "chat-b", imageInput: true };
		const next = runtime.observe(nextOwner, { windowId: "42" });
		await newEntered.promise;
		oldFinish.resolve();
		await expect(old).rejects.toThrow("任务已结束或切换");
		expect(runtime.interruptForWindow("42")).toBe(false);
		newFinish.resolve();
		const conflicted = await next;
		expect(conflicted.observationId).toBe("");
		expect(conflicted.screenshot).toBeUndefined();
		expect((await runtime.observe(nextOwner)).observationId).not.toBe("");
	});
	it("mirror input to a newly selected target invalidates only the pending read without stopping the run", async () => {
		const driver = new FakeDriver();
		driver.windowRows.push({ ...window, hwnd: 99, pid: 999, title: "new observed target", foreground: false });
		const runtime = new ComputerUseRuntime(driver);
		await runtime.observe(imageOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const observe = driver.observe.bind(driver);
		vi.spyOn(driver, "observe").mockImplementationOnce(async (options) => {
			entered.resolve();
			await finish.promise;
			return observe(options);
		});
		const pending = runtime.observe(imageOwner, { windowId: "99" });
		await entered.promise;
		expect(runtime.interruptForWindow("99")).toBe(false);
		finish.resolve();
		const conflicted = await pending;
		expect(conflicted.observationId).toBe("");
		expect(conflicted.screenshot).toBeUndefined();
		expect(conflicted.windows).toHaveLength(2);
		expect(conflicted.diagnostics?.some((text) => text.startsWith("read_conflict"))).toBe(true);
		const fresh = await runtime.observe(imageOwner, { windowId: "99" });
		expect(fresh.observationId).not.toBe("");
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: fresh.observationId,
					action: "set_value",
					elementId: "e1",
					text: "fresh",
				})
			).status,
		).toBe("issued");
	});
	it.each([
		{ action: "click", x: 10, y: 20 },
		{ action: "type", text: "x" },
		{ action: "key", down: [], tap: [13] },
		{ action: "scroll", x: 10, y: 20, delta: -120 },
		{ action: "focus" },
		{ action: "restore" },
	] satisfies Omit<NativeActInput, "observationId">[])(
		"explicit background refuses foreground operation without taking the desktop: %j",
		async (operation) => {
			const driver = new FakeDriver();
			const runtime = new ComputerUseRuntime(driver);
			const first = await runtime.observe(imageOwner);
			const result = await runtime.act(imageOwner, {
				observationId: first.observationId,
				...operation,
				inputMode: "background",
			});
			expect(result).toMatchObject({ status: "blocked", code: "foreground_required", requiresExclusive: true });
			expect(driver.actions).toHaveLength(0);
			const second = await runtime.observe(imageOwner);
			expect(
				(
					await runtime.act(imageOwner, {
						observationId: second.observationId,
						...operation,
						inputMode: "foreground",
					})
				).status,
			).toBe("issued");
			expect(driver.actions).toHaveLength(1);
			expect(driver.actions[0].inputMode).toBe("foreground");
		},
	);

	it("background UIA works without the global input monitor and survives mirror input in another window", async () => {
		const driver = new FakeDriver();
		driver.input = false;
		driver.windowRows.push({ ...window, hwnd: 99, pid: 999, title: "user workspace", foreground: false });
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const act = driver.act.bind(driver);
		vi.spyOn(driver, "act").mockImplementationOnce(async (input) => {
			entered.resolve();
			await finish.promise;
			return act(input);
		});
		const pending = runtime.act(textOwner, {
			observationId: first.observationId,
			action: "set_value",
			elementId: "e1",
			text: "background",
			inputMode: "background",
		});
		await entered.promise;
		expect(runtime.interruptForWindow("99")).toBe(false);
		expect(runtime.interruptForWindow(first.windows.find((row) => row.hwnd === 99)!.windowId)).toBe(false);
		finish.resolve();
		const result = await pending;
		expect(result.status).toBe("issued");
		expect(result.observation?.observationId).not.toBe("");
		expect(driver.actions).toHaveLength(1);
		expect(driver.actions[0].inputMode).toBe("background");
		expect((await runtime.observe(textOwner)).observationId).not.toBe("");
	});

	it("a target-window takeover interrupts a background action, permits recovery and owned cleanup", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.spyOn(driver, "act").mockImplementationOnce(async () => {
			entered.resolve();
			await finish.promise;
			return { status: "unknown", code: "driver_closed" };
		});
		const pending = runtime.act(textOwner, {
			observationId: first.observationId,
			action: "set_value",
			elementId: "e1",
			text: "x",
		});
		await entered.promise;
		expect(runtime.interruptForWindow(first.windowId!)).toBe(true);
		finish.resolve();
		expect((await pending).observation).toBeUndefined();
		expect((await runtime.observe(textOwner)).observationId).not.toBe("");
		await expect(runtime.releaseFor(textOwner)).resolves.toBeUndefined();
		expect(driver.released).toBe(1);
	});

	it("foreground input in flight yields to user input even in another window", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.spyOn(driver, "act").mockImplementationOnce(async () => {
			entered.resolve();
			await finish.promise;
			return { status: "partial", typedCharacters: 1 };
		});
		const pending = runtime.act(imageOwner, {
			observationId: first.observationId,
			action: "type",
			inputMode: "foreground",
			text: "abc",
		});
		await entered.promise;
		expect(runtime.interruptForWindow("99")).toBe(true);
		finish.resolve();
		expect((await pending).observation).toBeUndefined();
		expect((await runtime.observe(imageOwner)).observationId).not.toBe("");
	});

	it("missing background UIA requests exclusivity without falling back to input or focus", async () => {
		const driver = new FakeDriver();
		driver.backgroundUia = false;
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		expect(
			await runtime.act(textOwner, {
				observationId: first.observationId,
				action: "set_value",
				elementId: "e1",
				text: "x",
				inputMode: "background",
			}),
		).toMatchObject({ status: "blocked", code: "background_uia_unavailable", requiresExclusive: true });
		expect(driver.actions).toHaveLength(0);
	});

	it("cleanup after cancellation ignores the aborted action signal and preserves session ownership", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		const controller = new AbortController();
		controller.abort();
		await runtime.act(
			imageOwner,
			{ observationId: first.observationId, action: "focus", inputMode: "foreground" },
			controller.signal,
		);
		await expect(runtime.releaseFor({ ...imageOwner, sessionId: "chat-b" }, controller.signal)).rejects.toThrow(
			"会话已切换或不匹配",
		);
		const release = vi.spyOn(driver, "release");
		await expect(runtime.releaseFor(imageOwner, controller.signal)).resolves.toBeUndefined();
		expect(release).toHaveBeenCalledExactlyOnceWith();
		expect(driver.released).toBe(1);
		expect(driver.observations).toHaveLength(1);
	});

	it("a late read-conflict result from an old run cannot poison the next run", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const observe = driver.observe.bind(driver);
		vi.spyOn(driver, "observe").mockImplementationOnce(async (options) => {
			entered.resolve();
			await finish.promise;
			return { ...(await observe(options)), diagnostics: ["user_intervened: old read"] };
		});
		const old = runtime.observe(imageOwner);
		await entered.promise;
		runtime.beginRun("chat-b");
		const nextOwner = { sessionId: "chat-b", imageInput: false };
		const next = await runtime.observe(nextOwner);
		finish.resolve();
		await expect(old).rejects.toThrow("任务已结束或切换");
		expect(
			(
				await runtime.act(nextOwner, {
					observationId: next.observationId,
					action: "set_value",
					elementId: "e1",
					text: "ok",
				})
			).status,
		).toBe("issued");
	});

	it("regression: a read-only input conflict must not become host switching, a stopped run, and refused cleanup", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		driver.diagnostics = ["user_intervened: external input changed during observe"];
		const failures: string[] = [];
		let first: Awaited<ReturnType<typeof runtime.observe>> | undefined;
		let second: Awaited<ReturnType<typeof runtime.observe>> | undefined;
		try {
			first = await runtime.observe(imageOwner);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
		driver.diagnostics = [];
		try {
			second = await runtime.observe(imageOwner);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
		try {
			await runtime.releaseFor(imageOwner);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
		expect(failures).toEqual([]);
		expect(first?.observationId).toBe("");
		expect(first?.windows).toHaveLength(1);
		expect(second?.observationId).not.toBe("");
		expect(driver.released).toBe(1);
	});
	it("an already cancelled call with an old token cannot stop a newer run of the same chat", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		runtime.beginRun("chat-a");
		const next = await runtime.observe(imageOwner);
		const controller = new AbortController();
		controller.abort();
		expect(
			(
				await runtime.act(
					imageOwner,
					{ observationId: first.observationId, action: "focus", inputMode: "foreground" },
					controller.signal,
				)
			).code,
		).toBe("stale_observation");
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: next.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).status,
		).toBe("issued");
	});
	it("latches physical Escape until the host starts a new run", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		driver.result = { status: "blocked", code: "physical_escape" };
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).code,
		).toBe("physical_escape");
		expect(driver.observations).toHaveLength(1);
		await expect(runtime.observe(imageOwner)).rejects.toThrow("当前宿主任务的桌面操作已停止");
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).code,
		).toBe("run_stopped");
		runtime.beginRun("chat-a");
		driver.result = { status: "issued" };
		const second = await runtime.observe(imageOwner);
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: second.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).status,
		).toBe("issued");
	});

	it("latches cancellation without issuing any new desktop input", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		const controller = new AbortController();
		controller.abort();
		expect(
			(
				await runtime.act(
					imageOwner,
					{ observationId: first.observationId, action: "focus", inputMode: "foreground" },
					controller.signal,
				)
			).code,
		).toBe("cancelled");
		await expect(runtime.observe(imageOwner)).rejects.toThrow("桌面操作已停止");
		expect(driver.actions).toHaveLength(0);
	});

	it("does not publish a token for a read conflict and allows another observation in the same run", async () => {
		const driver = new FakeDriver();
		driver.diagnostics = ["user_intervened: external input changed during observe"];
		const runtime = new ComputerUseRuntime(driver);
		const conflicted = await runtime.observe(imageOwner);
		expect(conflicted.observationId).toBe("");
		expect(conflicted.diagnostics?.some((text) => text.startsWith("read_conflict"))).toBe(true);
		driver.diagnostics = [];
		expect((await runtime.observe(imageOwner)).observationId).not.toBe("");
		expect(driver.observations).toHaveLength(2);
	});

	it("an old interrupted action cannot revoke the new run's ownership or observation", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		runtime.beginRun("chat-a");
		const first = await runtime.observe(imageOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.spyOn(driver, "act").mockImplementationOnce(async () => {
			entered.resolve();
			await finish.promise;
			return { status: "blocked", code: "user_intervened" };
		});
		const pending = runtime.act(imageOwner, {
			observationId: first.observationId,
			action: "focus",
			inputMode: "foreground",
		});
		await entered.promise;
		runtime.beginRun("chat-b");
		const nextOwner = { sessionId: "chat-b", imageInput: true };
		const next = await runtime.observe(nextOwner);
		finish.resolve();
		await pending;
		expect(
			(await runtime.act(nextOwner, { observationId: next.observationId, action: "focus", inputMode: "foreground" }))
				.status,
		).toBe("issued");
	});

	it("does not publish a usable token when the host run ends during observation", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const observe = driver.observe.bind(driver);
		vi.spyOn(driver, "observe").mockImplementationOnce(async (options) => {
			entered.resolve();
			await finish.promise;
			return observe(options);
		});
		const pending = runtime.observe(imageOwner);
		await entered.promise;
		runtime.invalidateOwner();
		finish.resolve();
		await expect(pending).rejects.toThrow("任务已结束或切换");
		expect(driver.actions).toHaveLength(0);
	});

	it("does not adopt or expose a native result snapshot after the host run ends mid-action", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.spyOn(driver, "act").mockImplementationOnce(async () => {
			entered.resolve();
			await finish.promise;
			return { status: "issued", observation: await driver.observe({ hwnd: 42, includeImage: true }) };
		});
		const pending = runtime.act(imageOwner, {
			observationId: first.observationId,
			action: "focus",
			inputMode: "foreground",
		});
		await entered.promise;
		runtime.invalidateOwner();
		finish.resolve();
		const result = await pending;
		expect(result.status).toBe("issued");
		expect(result.observation).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("native-");
	});

	it("binds native tokens to one host observation and never forwards a model token directly", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		runtime.beginRun("chat-a");
		const first = await runtime.observe(imageOwner);
		expect(first.observationId).not.toMatch(/^native-/);
		const action = await runtime.act(imageOwner, {
			observationId: first.observationId,
			action: "click",
			inputMode: "foreground",
			x: 10,
			y: 20,
		});
		expect(driver.actions).toEqual([
			{ observationId: "native-1", action: "click", inputMode: "foreground", x: 10, y: 20 },
		]);
		expect(action.status).toBe("issued");
		expect(action.observation?.observationId).not.toBe(first.observationId);
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).code,
		).toBe("stale_observation");
		expect(driver.actions).toHaveLength(1);
	});

	it("rejects forged tokens and tokens from another chat without input", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		expect(
			(await runtime.act(imageOwner, { observationId: "native-1", action: "focus", inputMode: "foreground" })).code,
		).toBe("stale_observation");
		expect(
			(
				await runtime.act(
					{ ...imageOwner, sessionId: "chat-b" },
					{ observationId: first.observationId, action: "focus", inputMode: "foreground" },
				)
			).code,
		).toBe("owner_mismatch");
		expect(driver.actions).toHaveLength(0);
	});

	it("invalidates observations on the next run of the same chat", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		runtime.beginRun("chat-a");
		const first = await runtime.observe(imageOwner);
		runtime.beginRun("chat-a");
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "type",
					inputMode: "foreground",
					text: "no",
				})
			).code,
		).toBe("stale_observation");
		expect(driver.actions).toHaveLength(0);
	});

	it("rejects the old chat's token after the host switches to another chat", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		runtime.beginRun("chat-a");
		const first = await runtime.observe(imageOwner);
		runtime.beginRun("chat-b");
		const secondOwner = { sessionId: "chat-b", imageInput: true };
		const second = await runtime.observe(secondOwner);
		expect(
			(
				await runtime.act(secondOwner, {
					observationId: first.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).code,
		).toBe("stale_observation");
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: second.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).code,
		).toBe("owner_mismatch");
		expect(driver.actions).toHaveLength(0);
		expect(
			(
				await runtime.act(secondOwner, {
					observationId: second.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).status,
		).toBe("issued");
		expect(driver.actions).toHaveLength(1);
	});

	it("expires a snapshot even if the app looks unchanged", async () => {
		const driver = new FakeDriver();
		let now = 1000;
		const runtime = new ComputerUseRuntime(driver, { observationTtlMs: 1000, now: () => now });
		const first = await runtime.observe(imageOwner);
		now = 2000;
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).code,
		).toBe("expired_observation");
		expect(driver.actions).toHaveLength(0);
	});

	it("text-only models can use UIA but cannot guess coordinates", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		expect(first.screenshot).toBeUndefined();
		expect(driver.observations[0].includeImage).toBe(false);
		expect(
			(
				await runtime.act(textOwner, {
					observationId: first.observationId,
					action: "click",
					inputMode: "foreground",
					x: 1,
					y: 2,
				})
			).code,
		).toBe("image_required");
		const second = await runtime.observe(textOwner);
		driver.result = { status: "confirmed" };
		expect(
			(
				await runtime.act(textOwner, {
					observationId: second.observationId,
					action: "set_value",
					elementId: "e1",
					text: "中文",
				})
			).status,
		).toBe("confirmed");
		expect(driver.actions).toHaveLength(1);
	});

	it("does not upgrade a text-only observation into coordinate permission when the model changes", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "click",
					inputMode: "foreground",
					x: 10,
					y: 20,
				})
			).code,
		).toBe("image_required");
		const second = await runtime.observe(imageOwner);
		expect(
			(
				await runtime.act(textOwner, {
					observationId: second.observationId,
					action: "click",
					inputMode: "foreground",
					x: 10,
					y: 20,
				})
			).code,
		).toBe("image_required");
		expect(driver.actions).toHaveLength(0);
	});

	it("requires the actual screenshot for coordinates, not a capability flag", async () => {
		const driver = new FakeDriver();
		driver.imageAvailable = false;
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "click",
					inputMode: "foreground",
					x: 1,
					y: 2,
				})
			).code,
		).toBe("image_required");
		expect(driver.actions).toHaveLength(0);
	});

	it("rejects coordinates outside the delivered image", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "click",
					inputMode: "foreground",
					x: 400,
					y: 20,
				})
			).code,
		).toBe("coordinate_out_of_bounds");
		expect(driver.actions).toHaveLength(0);
	});

	it("rejects unsupported UIA actions before driver dispatch", async () => {
		const driver = new FakeDriver();
		driver.uia = false;
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		expect(
			(await runtime.act(textOwner, { observationId: first.observationId, action: "invoke", elementId: "e1" })).code,
		).toBe("pattern_unavailable");
		const second = await runtime.observe(textOwner);
		driver.uia = true;
		expect(
			(await runtime.act(textOwner, { observationId: second.observationId, action: "toggle", elementId: "e1" }))
				.code,
		).toBe("pattern_unavailable");
		expect(driver.actions).toHaveLength(0);
	});

	it("does not replay unknown or partial input and supplies one fresh observation", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		for (const status of ["unknown", "partial"] as const) {
			const first = await runtime.observe(imageOwner);
			driver.result = { status, typedCharacters: 2 };
			const before = driver.actions.length;
			const result = await runtime.act(imageOwner, {
				observationId: first.observationId,
				action: "type",
				inputMode: "foreground",
				text: "abc",
			});
			expect(result.status).toBe(status);
			expect(result.typedCharacters).toBe(2);
			expect(result.observation).toBeDefined();
			expect(driver.actions.length - before).toBe(1);
		}
	});

	it("preserves timeout uncertainty instead of returning success", async () => {
		const driver = new FakeDriver();
		driver.actError = new Error("driver timeout");
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		const result = await runtime.act(imageOwner, {
			observationId: first.observationId,
			action: "type",
			inputMode: "foreground",
			text: "abc",
		});
		expect(result.status).toBe("unknown");
		expect(result.message).toContain("勿重复提交");
		expect(driver.actions).toHaveLength(1);
	});

	it("lists candidates when there is no foreground app and never observes the whole desktop", async () => {
		const driver = new FakeDriver();
		driver.windowRows[0].foreground = false;
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		expect(first.target).toBeNull();
		expect(first.windows[0].windowId).toBe("w1");
		expect(driver.observations).toEqual([{ hwnd: 0, includeImage: false, maxWidth: 1568 }]);
		const second = await runtime.observe(imageOwner, { windowId: "w1" });
		expect(second.target?.hwnd).toBe(42);
	});

	it("does not restore minimized targets during read-only observation", async () => {
		const driver = new FakeDriver();
		driver.windowRows[0].minimized = true;
		const runtime = new ComputerUseRuntime(driver);
		expect((await runtime.observe(imageOwner, { windowId: "42" })).target?.minimized).toBe(true);
		expect(driver.actions).toHaveLength(0);
	});

	it("release invalidates only runtime observations and calls the owning driver", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		await expect(runtime.releaseFor({ ...imageOwner, sessionId: "chat-b" })).rejects.toThrow("会话已切换");
		expect(driver.released).toBe(0);
		await runtime.releaseFor(imageOwner);
		expect(driver.released).toBe(1);
		expect(
			(
				await runtime.act(imageOwner, {
					observationId: first.observationId,
					action: "focus",
					inputMode: "foreground",
				})
			).status,
		).toBe("blocked");
	});
});

describe("computer v2 model tool contract", () => {
	it("publishes inputMode and preserves requiresExclusive in native model output", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const [observe, act] = createComputerTools(runtime);
		expect(Value.Check(act.parameters, { observationId: "x", action: "focus", inputMode: "background" })).toBe(true);
		expect(Value.Check(act.parameters, { observationId: "x", action: "focus", inputMode: "auto" })).toBe(true);
		const observation = await runtime.observe(imageOwner);
		const result = await act.execute(
			"t1",
			{ observationId: observation.observationId, action: "click", x: 10, y: 20, inputMode: "background" },
			undefined,
			undefined,
			context(),
		);
		expect(result.structuredContent).toMatchObject({ status: "blocked", requiresExclusive: true });
		expect(Value.Check(act.outputSchema!, result.structuredContent)).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(driver.actions).toHaveLength(0);
		const observed = await observe.execute("t2", {}, undefined, undefined, context());
		expect(JSON.stringify(observed.structuredContent)).toContain('"backgroundUia":true');
		driver.result = { status: "blocked", code: "native_exclusive", requiresExclusive: true };
		const fresh = await runtime.observe(textOwner);
		const nativeBlocked = await act.execute(
			"t3",
			{ observationId: fresh.observationId, action: "set_value", elementId: "e1", text: "x" },
			undefined,
			undefined,
			context("chat-a", false),
		);
		expect(nativeBlocked.structuredContent).toMatchObject({
			status: "blocked",
			code: "native_exclusive",
			requiresExclusive: true,
		});
		expect(Value.Check(act.outputSchema!, nativeBlocked.structuredContent)).toBe(true);
		expect(driver.actions).toHaveLength(1);
	});
	it("rejects an inherited action property with a recoverable error even before framework validation", async () => {
		const driver = new FakeDriver();
		const [, act] = createComputerTools(new ComputerUseRuntime(driver));
		const malformed = { observationId: "x", action: "constructor" } as unknown as Parameters<typeof act.execute>[1];
		await expect(act.execute("t1", malformed, undefined, undefined, context())).rejects.toThrow("标准格式：{");
		expect(driver.actions).toHaveLength(0);
	});
	it("publishes flat, deferred, sequential model-only tools with separate read/write hints", () => {
		const tools = createComputerTools(new ComputerUseRuntime(new FakeDriver()));
		expect(tools.map((tool) => tool.name)).toEqual(["computer_observe", "computer_act", "computer_release"]);
		for (const tool of tools) {
			expect(tool.parameters.type).toBe("object");
			expect(tool.defaultActive).toBe(false);
			expect(tool.exposure).toBe("model-only");
			expect(tool.executionMode).toBe("sequential");
			expect(tool.outputSchema).toBeDefined();
		}
		expect(tools[0].annotations?.readOnlyHint).toBe(true);
		expect(tools[1].annotations?.readOnlyHint).toBe(false);
	});

	it("returns an actual image block and keeps base64 out of structuredContent", async () => {
		const [observe] = createComputerTools(new ComputerUseRuntime(new FakeDriver()));
		const update = vi.fn();
		const result = await observe.execute("t1", {}, undefined, update, context());
		expect(result.content).toContainEqual({ type: "image", data: jpeg, mimeType: "image/jpeg" });
		expect(JSON.stringify(result.structuredContent)).not.toContain(jpeg);
		expect(Value.Check(observe.outputSchema!, result.structuredContent)).toBe(true);
		expect(update).toHaveBeenCalledOnce();
	});

	it("does not return screenshots to text-only models", async () => {
		const [observe] = createComputerTools(new ComputerUseRuntime(new FakeDriver()));
		const result = await observe.execute("t1", {}, undefined, undefined, context("chat-a", false));
		expect(result.content.every((block) => block.type === "text")).toBe(true);
		expect(JSON.stringify(result.structuredContent)).toContain("e1");
	});

	it.each([
		{},
		{ action: "type", inputMode: "foreground", text: "x" },
		{ observationId: "x", action: "click", inputMode: "foreground" },
		{ observationId: "x", action: "key", inputMode: "foreground" },
		{ observationId: "x", action: "invoke" },
		{ observationId: "x", action: "focus", inputMode: "foreground", text: "x" },
		{ observationId: "x", action: "key", inputMode: "foreground", combo: "win+l" },
		{ observationId: "x", action: "key", inputMode: "foreground", combo: "control+alt+delete" },
		{ observationId: "x", action: "key", inputMode: "foreground", combo: "alt+ctrl+del" },
		{ observationId: "x", action: "key", inputMode: "foreground", combo: "shift+win+l" },
	] as const)("rejects incomplete/conflicting parameters with a copyable recovery template: %j", async (params) => {
		const driver = new FakeDriver();
		const [, act] = createComputerTools(new ComputerUseRuntime(driver));
		await expect(act.execute("t1", params, undefined, undefined, context())).rejects.toThrow("标准格式：{");
		expect(driver.actions).toHaveLength(0);
	});

	it("allows empty observe parameters but never an empty act dispatch", () => {
		const [observe, act] = createComputerTools(new ComputerUseRuntime(new FakeDriver()));
		expect(Value.Check(observe.parameters, {})).toBe(true);
		// Flat optional fields let a weak model reach the actionable execute-level recovery error.
		expect(Value.Check(act.parameters, {})).toBe(true);
	});

	it("does not publish or accept model-supplied owner/run/capability fields", () => {
		const [observe, act] = createComputerTools(new ComputerUseRuntime(new FakeDriver()));
		expect(Value.Check(observe.parameters, { sessionId: "chat-b", imageInput: true })).toBe(false);
		expect(
			Value.Check(act.parameters, {
				observationId: "x",
				action: "focus",
				inputMode: "foreground",
				sessionId: "chat-b",
				runId: "forged",
			}),
		).toBe(false);
	});

	it("checks the real tool host context even when both chats use the same image model", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		runtime.beginRun("chat-a");
		const [observe, act] = createComputerTools(runtime);
		const result = await observe.execute("t1", {}, undefined, undefined, context("chat-a"));
		const structured = result.structuredContent;
		if (structured === null || typeof structured !== "object" || !("observation" in structured))
			throw new Error("missing structured observation");
		const observation = structured.observation;
		if (
			observation === null ||
			typeof observation !== "object" ||
			!("observationId" in observation) ||
			typeof observation.observationId !== "string"
		)
			throw new Error("missing host token");
		const blocked = await act.execute(
			"t2",
			{ observationId: observation.observationId, action: "focus", inputMode: "foreground" },
			undefined,
			undefined,
			context("chat-b"),
		);
		expect(blocked.isError).toBe(true);
		expect(blocked.structuredContent).toMatchObject({ status: "blocked", code: "owner_mismatch" });
		expect(driver.actions).toHaveLength(0);
		expect(JSON.stringify(result.structuredContent)).not.toContain("native-");
	});
});

describe("adaptive computer-use routing", () => {
	it.each(["missing", "ambiguous"])("cancelled %s discovery cannot resume in the same host run", async (kind) => {
		const driver = new FakeDriver();
		if (kind === "ambiguous") driver.windowRows.push({ ...window, hwnd: 99, foreground: false });
		const runtime = new ComputerUseRuntime(driver);
		const controller = new AbortController();
		vi.spyOn(driver, "observe").mockImplementationOnce(async () => {
			controller.abort();
			throw new Error("discovery cancelled");
		});
		await expect(
			runtime.observe(imageOwner, { windowQuery: kind === "missing" ? "Notepad" : "test-app" }, controller.signal),
		).rejects.toThrow("discovery cancelled");
		await expect(runtime.observe(imageOwner)).rejects.toThrow("桌面操作已停止");
		expect(driver.actions).toHaveLength(0);
	});

	it("text-only observations deliver bounded field/document contents while stripping password readback", async () => {
		const driver = new FakeDriver();
		const nativeObserve = driver.observe.bind(driver);
		vi.spyOn(driver, "observe").mockImplementation(async (options) => {
			const observation = await nativeObserve(options);
			return {
				...observation,
				elements: [
					{
						...observation.elements[0],
						value: "Owl complete",
						text: "Document contents",
						isReadOnly: false,
						truncated: true,
					},
					{
						...observation.elements[0],
						id: "password",
						password: true,
						value: "secret-value",
						text: "secret-text",
						isReadOnly: false,
					},
				],
			};
		});
		const [observe] = createComputerTools(new ComputerUseRuntime(driver));
		const result = await observe.execute("readback", {}, undefined, undefined, context("chat-a", false));
		expect(result.structuredContent).toMatchObject({
			observation: {
				elements: [
					{ value: "Owl complete", text: "Document contents", isReadOnly: false, truncated: true },
					{ id: "password", password: true },
				],
			},
		});
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(JSON.stringify(result)).not.toContain("secret-text");
		expect(Value.Check(observe.outputSchema!, result.structuredContent)).toBe(true);
	});

	it("auto scroll uses an available background Scroll pattern without global input permission", async () => {
		const driver = new FakeDriver();
		driver.input = false;
		driver.patterns = ["Scroll"];
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		const result = await runtime.act(textOwner, {
			observationId: first.observationId,
			action: "scroll",
			elementId: "e1",
			delta: -120,
		});
		expect(result.status).toBe("issued");
		expect(driver.actions).toHaveLength(1);
		expect(driver.actions[0]).toMatchObject({ inputMode: "auto", action: "scroll" });
	});

	it("a worker closed by mirror input reports recoverable read conflict rather than ending the run", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		await runtime.observe(imageOwner);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		vi.spyOn(driver, "observe").mockImplementationOnce(async () => {
			entered.resolve();
			await finish.promise;
			throw new Error("computer-use driver closed");
		});
		const pending = runtime.observe(imageOwner);
		await entered.promise;
		runtime.interruptForWindow("42");
		finish.resolve();
		expect(await pending).toMatchObject({ observationId: "", code: "read_conflict", retryable: true });
		expect((await runtime.observe(imageOwner)).observationId).not.toBe("");
	});

	it.each([
		{
			status: "blocked",
			code: "user_busy",
			requestedMode: "auto",
			executedMode: "foreground",
			executedAction: "key",
			fallbackReason: "Keyboard requires foreground",
			retryable: true,
			retryAfterMs: 750,
			nextAction: "computer_observe after activity settles",
			idleWaitMs: 3000,
			idleQuietForMs: 40,
		},
		{
			status: "issued",
			requestedMode: "auto",
			executedMode: "foreground",
			executedAction: "key",
			idleWaitMs: 0,
			idleGrantedAtMs: 1_760_000_000_123,
			idleQuietForMs: 1001,
		},
	] satisfies NativeActResult[])(
		"keeps route and idle-gate metadata in model output: $status",
		async (nativeResult) => {
			const driver = new FakeDriver();
			driver.result = nativeResult;
			const runtime = new ComputerUseRuntime(driver);
			const [, act] = createComputerTools(runtime);
			const first = await runtime.observe(imageOwner);
			const result = await act.execute(
				"busy",
				{ observationId: first.observationId, action: "key", combo: "enter" },
				undefined,
				undefined,
				context(),
			);
			expect(result.structuredContent).toMatchObject(driver.result);
			expect(Value.Check(act.outputSchema!, result.structuredContent)).toBe(true);
			const text = result.content.find((block) => block.type === "text");
			if (text?.type !== "text") throw new Error("missing model text output");
			const rendered: unknown = JSON.parse(text.text.slice(text.text.indexOf("\n") + 1));
			expect(rendered).toMatchObject(driver.result);
			if (nativeResult.idleGrantedAtMs === undefined) {
				expect(result.structuredContent).not.toHaveProperty("idleGrantedAtMs");
				expect(rendered).not.toHaveProperty("idleGrantedAtMs");
			}
			expect(driver.actions).toHaveLength(1);
		},
	);

	it("multiple query matches require window selection before input", async () => {
		const driver = new FakeDriver();
		driver.windowRows.push({ ...window, hwnd: 99, foreground: false });
		const runtime = new ComputerUseRuntime(driver);
		const result = await runtime.observe(imageOwner, { windowQuery: "test-app" });
		expect(result).toMatchObject({ target: null, code: "target_ambiguous", retryable: true });
		expect(result.nextAction).toContain("windowId");
		expect(driver.actions).toHaveLength(0);
	});

	it("a discovery token cannot direct keyboard input to an unknown window", async () => {
		const driver = new FakeDriver();
		driver.windowRows = [];
		const runtime = new ComputerUseRuntime(driver);
		const result = await runtime.observe(imageOwner);
		expect(
			(await runtime.act(imageOwner, { observationId: result.observationId, action: "key", down: [], tap: [13] }))
				.code,
		).toBe("target_required");
		expect(driver.actions).toHaveLength(0);
	});

	it("publishes auto routing and application launch on one flat schema", () => {
		const [observe, act] = createComputerTools(new ComputerUseRuntime(new FakeDriver()));
		expect(Value.Check(observe.parameters, { windowQuery: "Notepad" })).toBe(true);
		expect(Value.Check(act.parameters, { observationId: "x", action: "type", text: "x", inputMode: "auto" })).toBe(
			true,
		);
		expect(Value.Check(act.parameters, { observationId: "x", action: "open_app", app: "notepad" })).toBe(true);
		expect(
			Value.Check(act.parameters, { observationId: "x", action: "type", elementId: "e1", text: "x", replace: true }),
		).toBe(true);
	});

	it("dispatches default auto once and preserves the driver's selected route", async () => {
		const driver = new FakeDriver();
		driver.result = {
			status: "confirmed",
			requestedMode: "auto",
			executedMode: "background",
			executedAction: "set_value",
			fallbackReason: "Value pattern supports replacement",
		};
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(textOwner);
		const result = await runtime.act(textOwner, {
			observationId: first.observationId,
			action: "type",
			elementId: "e1",
			text: "whole field",
			replace: true,
		});
		expect(driver.actions).toHaveLength(1);
		expect(driver.actions[0]).toMatchObject({ inputMode: "auto", replace: true });
		expect(result).toMatchObject({
			requestedMode: "auto",
			executedMode: "background",
			executedAction: "set_value",
			fallbackReason: "Value pattern supports replacement",
		});
	});

	it("finds a named application instead of repeatedly observing Owl's foreground window", async () => {
		const driver = new FakeDriver();
		driver.windowRows[0].title = "owl";
		driver.windowRows.push({
			...window,
			hwnd: 99,
			process: "Notepad",
			title: "Untitled — Notepad",
			foreground: false,
		});
		const runtime = new ComputerUseRuntime(driver);
		const found = await runtime.observe(imageOwner, { windowQuery: "notepad" });
		expect(found.target?.hwnd).toBe(99);
		expect(driver.observations[0].hwnd).toBe(99);
	});

	it("missing applications return an owned discovery token and actionable launch guidance", async () => {
		const driver = new FakeDriver();
		const nativeObserve = driver.observe.bind(driver);
		vi.spyOn(driver, "observe").mockImplementation(async (options) => ({
			...(await nativeObserve(options)),
			target: null,
			elements: [],
			screenshot: undefined,
		}));
		const runtime = new ComputerUseRuntime(driver);
		const missing = await runtime.observe(imageOwner, { windowQuery: "notepad" });
		expect(missing.target).toBeNull();
		expect(missing.observationId).not.toBe("");
		expect(missing.nextAction).toContain("open_app");
		driver.result = {
			status: "issued",
			target: { ...window, hwnd: 99, process: "Notepad" },
			requestedMode: "auto",
			executedMode: "background",
			executedAction: "open_app",
		};
		const result = await runtime.act(imageOwner, {
			observationId: missing.observationId,
			action: "open_app",
			app: "notepad",
		});
		expect(result.status).toBe("issued");
		expect(driver.actions[0]).toMatchObject({ action: "open_app", app: "notepad", inputMode: "auto" });
		expect(driver.observations.at(-1)?.hwnd).toBe(99);
	});

	it("normal activity conflicts do not latch a permanent stopped run", async () => {
		const driver = new FakeDriver();
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		driver.result = {
			status: "blocked",
			code: "user_intervened",
			retryable: true,
			retryAfterMs: 750,
			nextAction: "Observe the target again after user activity settles.",
		};
		const blocked = await runtime.act(imageOwner, {
			observationId: first.observationId,
			action: "key",
			down: [],
			tap: [13],
		});
		expect(blocked).toMatchObject({ code: "user_intervened", retryable: true, retryAfterMs: 750 });
		const fresh = await runtime.observe(imageOwner);
		expect(fresh.observationId).not.toBe("");
		expect((await runtime.act(imageOwner, { observationId: first.observationId, action: "focus" })).code).toBe(
			"stale_observation",
		);
	});

	it("mirror takeover invalidates the current lease but lets the same run observe again", async () => {
		const runtime = new ComputerUseRuntime(new FakeDriver());
		const first = await runtime.observe(imageOwner);
		expect(runtime.interruptForWindow(first.windowId!)).toBe(false);
		const fresh = await runtime.observe(imageOwner);
		expect(fresh.observationId).not.toBe(first.observationId);
		expect((await runtime.act(imageOwner, { observationId: first.observationId, action: "focus" })).code).toBe(
			"stale_observation",
		);
	});

	it("unknown auto results are not replayed or converted into foreground success", async () => {
		const driver = new FakeDriver();
		driver.result = { status: "unknown", executedMode: "background", executedAction: "invoke" };
		const runtime = new ComputerUseRuntime(driver);
		const first = await runtime.observe(imageOwner);
		const result = await runtime.act(imageOwner, {
			observationId: first.observationId,
			action: "click",
			elementId: "e1",
		});
		expect(result).toMatchObject({
			status: "unknown",
			requestedMode: "auto",
			executedMode: "background",
			retryable: false,
		});
		expect(result.nextAction).toContain("computer_observe");
		expect(driver.actions).toHaveLength(1);
	});

	it.each(["notepad.exe & whoami", "cmd.exe /c calc", "powershell -Command calc", "https://example.com"])(
		"rejects command strings as application launch targets: %s",
		async (app) => {
			const driver = new FakeDriver();
			const runtime = new ComputerUseRuntime(driver);
			const [, act] = createComputerTools(runtime);
			const first = await runtime.observe(imageOwner);
			await expect(
				act.execute(
					"launch",
					{ observationId: first.observationId, action: "open_app", app },
					undefined,
					undefined,
					context(),
				),
			).rejects.toThrow("标准格式：{");
			expect(driver.actions).toHaveLength(0);
		},
	);
});
