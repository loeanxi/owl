/**
 * ComputerDriverSession 协议层单测。
 *
 * 用 node 子进程跑 test/fake-driver.mjs 当伪 worker（真 IPC、真 JSON 行），
 * 覆盖：ready 门、请求/响应关联、错误响应、worker 崩溃重建、坐标换算。
 * @module owl-computer-use/test/session
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerDriverSession } from "../src/driver/session.ts";
import { parseKeyCombo } from "../src/plugin/tools.ts";

const fakeDriverPath = fileURLToPath(new URL("./fake-driver.mjs", import.meta.url));

interface DriverAudit {
	workers: ChildProcessWithoutNullStreams[];
	requests: Record<string, unknown>[];
}

function fakeFactory(mode = "normal", audit?: DriverAudit) {
	return () => {
		const worker = spawn(process.execPath, [fakeDriverPath, mode], { stdio: ["pipe", "pipe", "pipe"] });
		audit?.workers.push(worker);
		let buffer = "";
		worker.stderr.setEncoding("utf8");
		worker.stderr.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.startsWith("request:")) audit?.requests.push(JSON.parse(line.slice(8)) as Record<string, unknown>);
				newline = buffer.indexOf("\n");
			}
		});
		return worker;
	};
}

describe("ComputerDriverSession", () => {
	let session: ComputerDriverSession;

	beforeEach(() => {
		session = new ComputerDriverSession(fakeFactory(), {
			readyTimeoutMs: 5000,
			requestTimeoutMs: 5000,
			idleTimeoutMs: 0,
		});
	});

	afterEach(() => {
		session.close();
	});

	it("waits for ready and correlates requests by id", async () => {
		const cursor = await session.cursor();
		expect(cursor).toEqual({ x: 111, y: 222 });
		// 第二次请求 id 递增不串线。
		const again = await session.cursor();
		expect(again).toEqual({ x: 111, y: 222 });
	});

	it("rejects with the worker's error message", async () => {
		await expect(session.key([91], [76])).rejects.toThrow(/blocked/i);
	});

	it("stores screenshot meta and converts image coords to screen coords", async () => {
		const meta = await session.screenshot(-1, 1568, 80);
		expect(meta.imageWidth).toBe(784); // fake driver 模拟 2 倍缩放
		expect(meta.imageHeight).toBe(392);
		expect(meta.screenWidth).toBe(1568);
		expect(meta.screenHeight).toBe(784);

		const screen = session.toScreenSpace(100, 50);
		expect(screen).toEqual({ x: 200, y: 100 });
	});

	it("click/scroll map coords through the last screenshot", async () => {
		await session.screenshot(-1, 1568, 80);
		const clicked = await session.click(10, 10, "left", false);
		expect(clicked).toEqual({ clicked: true, x: 20, y: 20 });
	});

	it("refuses coordinates before any screenshot", () => {
		expect(() => session.toScreenSpace(1, 1)).toThrow(/screenshot/i);
	});

	it("respawns the worker after it dies mid-session", async () => {
		const flaky = new ComputerDriverSession(fakeFactory("flaky"), {
			readyTimeoutMs: 5000,
			requestTimeoutMs: 5000,
			idleTimeoutMs: 0,
		});
		try {
			await flaky.cursor(); // fake driver 处理完第一条命令就退出
			await new Promise((resolve) => setTimeout(resolve, 150));
			const after = await flaky.cursor(); // 崩溃后自动重建
			expect(after).toEqual({ x: 111, y: 222 });
		} finally {
			flaky.close();
		}
	});

	it("awaits each response before issuing the next command", async () => {
		session.close();
		session = new ComputerDriverSession(fakeFactory("serial-check"), { idleTimeoutMs: 0 });
		const results = await Promise.all([session.cursor(), session.type("one"), session.cursor()]);
		expect(results).toEqual([{ x: 111, y: 222 }, { typed: true }, { x: 111, y: 222 }]);
	});

	it("does not count ready or queue waiting against execution timeout", async () => {
		session.close();
		session = new ComputerDriverSession(fakeFactory("delayed-ready"), {
			readyTimeoutMs: 2000,
			requestTimeoutMs: 60,
			queueTimeoutMs: 2000,
			idleTimeoutMs: 0,
		});
		expect(await Promise.all([session.cursor(), session.cursor()])).toEqual([
			{ x: 111, y: 222 },
			{ x: 111, y: 222 },
		]);
	});

	it("expires a queued command without sending it or stopping the active command", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), {
			queueTimeoutMs: 25,
			requestTimeoutMs: 2000,
			idleTimeoutMs: 0,
		});
		await session.cursor();
		const first = session.type("slow");
		const waiting = session.type("must-not-run");
		await expect(waiting).rejects.toThrow(/queue/);
		expect(await first).toEqual({ typed: true });
		expect(audit.requests.some((request) => request.text === "must-not-run")).toBe(false);
		expect(audit.workers).toHaveLength(1);
	});

	it("removes aborted queued commands before dispatch", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 0 });
		await session.cursor();
		const first = session.type("slow");
		const controller = new AbortController();
		const queued = session.type("must-not-run", controller.signal);
		const rejected = expect(queued).rejects.toThrow(/aborted/);
		controller.abort();
		await rejected;
		await first;
		expect(audit.requests.some((request) => request.text === "must-not-run")).toBe(false);
		expect(audit.workers[0].killed).toBe(false);
	});

	it("aborts issued input by stopping its worker and invalidating screenshots", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 0 });
		await session.screenshot(-1, 1568, 80);
		const controller = new AbortController();
		const active = session.type("hang", controller.signal);
		const rejected = expect(active).rejects.toThrow(/aborted/);
		await vi.waitFor(() => expect(audit.requests.some((request) => request.text === "hang")).toBe(true));
		controller.abort();
		await rejected;
		expect(audit.workers[0].killed).toBe(true);
		expect(session.screenshotMeta).toBeUndefined();
		await expect(session.click(1, 1, "left", false)).rejects.toThrow(/screenshot/);
		expect(await session.cursor()).toEqual({ x: 111, y: 222 });
		expect(audit.workers).toHaveLength(2);
		expect(audit.requests.filter((request) => request.text === "hang")).toHaveLength(1);
	});

	it("cancels a command while waiting for ready without waiting for the ready timeout", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("no-ready", audit), { readyTimeoutMs: 5000, idleTimeoutMs: 0 });
		const controller = new AbortController();
		const pending = session.cursor(controller.signal);
		const rejected = expect(pending).rejects.toThrow(/aborted/);
		controller.abort();
		await rejected;
		expect(audit.requests).toEqual([]);
		expect(audit.workers[0].killed).toBe(true);
	});

	it("close rejects queued work and allows a later independent restart", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 0 });
		await session.cursor();
		const active = session.type("hang");
		const queued = session.type("must-not-run");
		const failures = Promise.all([
			expect(active).rejects.toThrow(/closed/),
			expect(queued).rejects.toThrow(/closed/),
		]);
		await vi.waitFor(() => expect(audit.requests.some((request) => request.text === "hang")).toBe(true));
		session.close();
		await failures;
		expect(await session.cursor()).toEqual({ x: 111, y: 222 });
		expect(audit.requests.some((request) => request.text === "must-not-run")).toBe(false);
		expect(audit.workers).toHaveLength(2);
	});

	it("times out issued work without replaying it or dispatching queued actions", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { requestTimeoutMs: 100, idleTimeoutMs: 0 });
		await session.cursor();
		const active = session.type("hang");
		const queued = session.type("must-not-run");
		await Promise.all([expect(active).rejects.toThrow(/unknown/), expect(queued).rejects.toThrow(/unknown/)]);
		expect(audit.workers[0].killed).toBe(true);
		expect(audit.requests.filter((request) => request.text === "hang")).toHaveLength(1);
		expect(audit.requests.some((request) => request.text === "must-not-run")).toBe(false);
	});

	it("cleans up ready listeners and can recover after ready timeout", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		let count = 0;
		session.close();
		session = new ComputerDriverSession(() => fakeFactory(count++ === 0 ? "no-ready" : "normal", audit)(), {
			readyTimeoutMs: 200,
			idleTimeoutMs: 0,
		});
		await expect(session.cursor()).rejects.toThrow(/ready/);
		expect(audit.workers[0].stdout.listenerCount("data")).toBe(0);
		expect(audit.workers[0].listenerCount("exit")).toBe(0);
		expect(await session.cursor()).toEqual({ x: 111, y: 222 });
	});

	it("ignores output from a terminated worker after a new one starts", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 0 });
		await session.cursor();
		const old = audit.workers[0];
		session.close();
		const controller = new AbortController();
		const current = session.type("hang", controller.signal);
		const failure = expect(current).rejects.toThrow(/aborted/);
		await vi.waitFor(() => expect(audit.requests.some((request) => request.text === "hang")).toBe(true));
		const id = audit.requests.find((request) => request.text === "hang")?.id;
		old.stdout.emit("data", JSON.stringify({ id, ok: true, data: { typed: true } }) + "\n");
		controller.abort();
		await failure;
	});

	it("bounds the protocol buffer even when no newline arrives", async () => {
		session.close();
		session = new ComputerDriverSession(fakeFactory("flood"), { maxResponseChars: 1024, idleTimeoutMs: 0 });
		await expect(session.cursor()).rejects.toThrow(/buffer limit/);
	});

	it("rejects invalid image coordinates while preserving negative physical origins", async () => {
		await session.screenshot(-2, 1568, 80);
		expect(session.toScreenSpace(100, 50)).toEqual({ x: -1368, y: -684 });
		for (const [x, y] of [
			[-1, 0],
			[0, -1],
			[784, 0],
			[0, 392],
			[Number.NaN, 0],
			[0, Number.POSITIVE_INFINITY],
		])
			expect(() => session.toScreenSpace(x, y)).toThrow(/bounds/);
	});

	it("discards the previous mapping when a new screenshot fails validation", async () => {
		session.close();
		session = new ComputerDriverSession(fakeFactory("bad-screenshot"), { idleTimeoutMs: 0 });
		await session.screenshot(-1, 1568, 80);
		await expect(session.screenshot(-1, 1568, 80)).rejects.toThrow(/geometry/);
		expect(session.screenshotMeta).toBeUndefined();
	});

	it("converts queued coordinates after the queued screenshot has completed", async () => {
		const shot = session.screenshot(-2, 1568, 80);
		const clicked = session.click(10, 10, "left", false);
		await shot;
		expect(await clicked).toEqual({ clicked: true, x: -1548, y: -764 });
	});

	it("forwards native observe capabilities and resolves the shared WGC source", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 0 });
		const observation = await session.observe({ hwnd: 123, maxWidth: 900 });
		expect(observation.observationId).toBe("obs_1");
		expect(observation.capabilities.uia).toBe(true);
		const request = audit.requests[0];
		expect(request).toMatchObject({ cmd: "observe", hwnd: 123, maxWidth: 900, quality: 80, includeImage: true });
		expect(typeof request.captureKernelPath).toBe("string");
		expect(existsSync(String(request.captureKernelPath))).toBe(true);
	});

	it("consumes native observations and requires a new observation after act", async () => {
		const observation = await session.observe();
		expect(await session.act({ observationId: observation.observationId, action: "click", x: 10, y: 10 })).toEqual({
			status: "issued",
		});
		await expect(
			session.act({ observationId: observation.observationId, action: "type", text: "again" }),
		).rejects.toThrow(/stale/);
	});

	it("forwards automatic mode and application launch once through the observation fence", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 0 });
		const observation = await session.observe({ includeImage: false });
		await session.act({
			observationId: observation.observationId,
			action: "open_app",
			app: "notepad.exe",
			inputMode: "auto",
		});
		expect(audit.requests.filter((request) => request.cmd === "act")).toEqual([
			expect.objectContaining({
				action: "open_app",
				app: "notepad.exe",
				inputMode: "auto",
				observationId: observation.observationId,
			}),
		]);
		await expect(
			session.act({
				observationId: observation.observationId,
				action: "open_app",
				app: "notepad.exe",
				inputMode: "auto",
			}),
		).rejects.toThrow(/stale/);
		expect(audit.requests.filter((request) => request.cmd === "act")).toHaveLength(1);
	});

	it("clears image mappings for image-free native observations and on release", async () => {
		await session.observe();
		const observation = await session.observe({ includeImage: false });
		expect(session.screenshotMeta).toBeUndefined();
		await expect(
			session.act({ observationId: observation.observationId, action: "click", x: 1, y: 1 }),
		).rejects.toThrow(/screenshot/);
		expect(
			await session.act({ observationId: observation.observationId, action: "invoke", elementId: "e1" }),
		).toEqual({ status: "issued" });
		const next = await session.observe();
		await session.release();
		await expect(session.act({ observationId: next.observationId, action: "focus" })).rejects.toThrow(/stale/);
		expect(session.screenshotMeta).toBeUndefined();
	});

	it("release does not start a worker when the session has no resources", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit));
		await session.release();
		expect(audit.workers).toEqual([]);
	});

	it("release immediately after an active abort does not restart the stopped worker", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 0 });
		await session.cursor();
		const controller = new AbortController();
		const active = session.type("hang", controller.signal);
		const rejected = expect(active).rejects.toThrow(/aborted/);
		await vi.waitFor(() => expect(audit.requests.some((request) => request.text === "hang")).toBe(true));
		controller.abort();
		// release 与 drain 的 await unwind 同时发生，不能为 cleanup 新建 worker。
		await Promise.all([session.release(), rejected]);
		expect(audit.workers).toHaveLength(1);
		expect(audit.workers[0].killed).toBe(true);
		expect(audit.requests.some((request) => request.cmd === "release")).toBe(false);
		expect(await session.cursor()).toEqual({ x: 111, y: 222 });
		expect(audit.workers).toHaveLength(2);
	});

	it("invalidates observations when its worker idles out", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		session.close();
		session = new ComputerDriverSession(fakeFactory("normal", audit), { idleTimeoutMs: 20 });
		const observation = await session.observe();
		await vi.waitFor(() => expect(audit.workers[0].killed).toBe(true));
		await expect(session.act({ observationId: observation.observationId, action: "focus" })).rejects.toThrow(/stale/);
		expect(session.screenshotMeta).toBeUndefined();
	});

	it("native Stop rejects issued and queued input after synchronously notifying the owner", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		const order: string[] = [];
		const onControlStop = vi.fn(() => order.push("stop-owner"));
		session.close();
		session = new ComputerDriverSession(fakeFactory("control-stop", audit), { idleTimeoutMs: 0, onControlStop });
		session.setControlOwner("run-a");
		const observation = await session.observe();
		const active = session.act({ observationId: observation.observationId, action: "type", text: "hang" });
		const activeFailure = expect(
			active.catch((error: unknown) => {
				order.push("action-rejected");
				throw error;
			}),
		).rejects.toThrow(/stopped|unknown/);
		const queued = expect(session.cursor()).rejects.toThrow(/stopped|unknown/);
		await Promise.all([activeFailure, queued]);
		expect(order[0]).toBe("stop-owner");
		expect(onControlStop).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ ownerId: "run-a", controlId: "control-2", requestId: 2, workerGeneration: 1 }),
		);
		expect(audit.workers[0].killed).toBe(true);
		expect(audit.requests.filter((request) => request.cmd === "act")).toHaveLength(1);
		expect(audit.requests.some((request) => request.cmd === "cursor")).toBe(false);
	});

	it("accepts native Stop between requests from the last authorized control instance", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		const onControlStop = vi.fn();
		session.close();
		session = new ComputerDriverSession(fakeFactory("control-stop", audit), { idleTimeoutMs: 0, onControlStop });
		session.setControlOwner("run-a");
		const observation = await session.observe();
		await expect(session.act({ observationId: observation.observationId, action: "focus" })).resolves.toMatchObject({
			status: "issued",
		});
		await vi.waitFor(() => expect(onControlStop).toHaveBeenCalledOnce());
		expect(audit.workers[0].killed).toBe(true);
		expect(audit.workers).toHaveLength(1);
	});

	it("observations cannot authorize a control stop", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		const onControlStop = vi.fn();
		session.close();
		session = new ComputerDriverSession(fakeFactory("control-observe", audit), { idleTimeoutMs: 0, onControlStop });
		await session.observe();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(onControlStop).not.toHaveBeenCalled();
		expect(audit.workers[0].killed).toBe(false);
	});

	it("rejects mismatched control/request identity and clears authorization on host-run change", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		const onControlStop = vi.fn();
		session.close();
		session = new ComputerDriverSession(fakeFactory("control-start", audit), { idleTimeoutMs: 0, onControlStop });
		session.setControlOwner("run-a");
		const observation = await session.observe();
		await session.act({ observationId: observation.observationId, action: "focus" });
		const worker = audit.workers[0];
		for (const payload of [
			{ event: "control_stop", controlId: "forged", requestId: 2 },
			{ event: "control_stop", controlId: "control-2", requestId: 99 },
			{ event: "control_started", controlId: "forged", requestId: 2 },
		])
			worker.stdout.emit("data", JSON.stringify(payload) + "\n");
		session.setControlOwner("run-b");
		worker.stdout.emit(
			"data",
			JSON.stringify({ event: "control_stop", controlId: "control-2", requestId: 2 }) + "\n",
		);
		expect(onControlStop).not.toHaveBeenCalled();
		expect(worker.killed).toBe(true);
		expect(await session.cursor()).toEqual({ x: 111, y: 222 });
		expect(audit.workers).toHaveLength(2);
		expect(audit.workers[1].killed).toBe(false);
	});

	it("ignores native Stop from a replaced worker even after a new control starts", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		const onControlStop = vi.fn();
		session.close();
		session = new ComputerDriverSession(fakeFactory("control-start", audit), { idleTimeoutMs: 0, onControlStop });
		session.setControlOwner("run-a");
		const first = await session.observe();
		await session.act({ observationId: first.observationId, action: "focus" });
		const old = audit.workers[0];
		session.close();
		session.setControlOwner("run-b");
		const second = await session.observe();
		await session.act({ observationId: second.observationId, action: "focus" });
		old.stdout.emit("data", JSON.stringify({ event: "control_stop", controlId: "control-2", requestId: 2 }) + "\n");
		expect(onControlStop).not.toHaveBeenCalled();
		expect(audit.workers[1].killed).toBe(false);
	});

	it("release retires the native control authorization without starting another worker", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		const onControlStop = vi.fn();
		session.close();
		session = new ComputerDriverSession(fakeFactory("control-start", audit), { idleTimeoutMs: 0, onControlStop });
		session.setControlOwner("run-a");
		const observation = await session.observe();
		await session.act({ observationId: observation.observationId, action: "focus" });
		await session.release();
		audit.workers[0].stdout.emit(
			"data",
			JSON.stringify({ event: "control_stop", controlId: "control-2", requestId: 2 }) + "\n",
		);
		expect(onControlStop).not.toHaveBeenCalled();
		expect(audit.workers).toHaveLength(1);
		expect(audit.workers[0].killed).toBe(false);
	});

	it("old Stop callback cleanup cannot kill a replacement worker created synchronously", async () => {
		const audit: DriverAudit = { workers: [], requests: [] };
		let replacement: Promise<{ x: number; y: number }> | undefined;
		session.close();
		session = new ComputerDriverSession(fakeFactory("control-start", audit), {
			idleTimeoutMs: 0,
			onControlStop() {
				session.close();
				replacement = session.cursor();
			},
		});
		const observation = await session.observe();
		await session.act({ observationId: observation.observationId, action: "focus" });
		audit.workers[0].stdout.emit(
			"data",
			JSON.stringify({ event: "control_stop", controlId: "control-2", requestId: 2 }) + "\n",
		);
		expect(await replacement).toEqual({ x: 111, y: 222 });
		expect(audit.workers).toHaveLength(2);
		expect(audit.workers[1].killed).toBe(false);
	});
});

describe("parseKeyCombo", () => {
	it("parses modifiers, taps, lone modifiers, and function keys", () => {
		expect(parseKeyCombo("ctrl+s")).toEqual({ down: [0x11], tap: [0x53] });
		expect(parseKeyCombo("ctrl+shift+esc")).toEqual({ down: [0x11, 0x10], tap: [0x1b] });
		expect(parseKeyCombo("win")).toEqual({ down: [], tap: [0x5b] });
		expect(parseKeyCombo("f5")).toEqual({ down: [], tap: [0x74] });
		expect(parseKeyCombo("enter")).toEqual({ down: [], tap: [0x0d] });
	});

	it("blocks system-level combos", () => {
		expect(() => parseKeyCombo("ctrl+alt+delete")).toThrow(/blocked/i);
		expect(() => parseKeyCombo("win+l")).toThrow(/blocked/i);
	});
});
