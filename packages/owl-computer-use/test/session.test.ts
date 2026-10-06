/**
 * ComputerDriverSession 协议层单测。
 *
 * 用 node 子进程跑 test/fake-driver.mjs 当伪 worker（真 IPC、真 JSON 行），
 * 覆盖：ready 门、请求/响应关联、错误响应、worker 崩溃重建、坐标换算。
 * @module owl-computer-use/test/session
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputerDriverSession } from "../src/driver/session.ts";
import { parseKeyCombo } from "../src/plugin/tools.ts";

const fakeDriverPath = fileURLToPath(new URL("./fake-driver.mjs", import.meta.url));

function fakeFactory(mode: "normal" | "flaky" = "normal") {
	return () => spawn(process.execPath, [fakeDriverPath, mode], { stdio: ["pipe", "pipe", "pipe"] });
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
