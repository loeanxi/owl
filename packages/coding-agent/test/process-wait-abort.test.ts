import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createProcessToolDefinition } from "../src/core/tools/process.ts";
import {
	registerSessionProcess,
	terminateSessionProcesses,
	waitSessionProcess,
} from "../src/core/tools/process-store.ts";

const owner = "process-wait-abort";
const closed: Promise<void>[] = [];
let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "owl-process-abort-"));
});
afterEach(async () => {
	terminateSessionProcesses(owner);
	await Promise.all(closed.splice(0));
	vi.restoreAllMocks();
	await rm(cwd, { recursive: true, force: true });
});

function worker() {
	const child = spawn(process.execPath, ["-e", "process.stdin.on('data', () => {});"], {
		cwd,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
	return registerSessionProcess({ child, sessionId: owner, command: "fixture", cwd, acceptsStdin: true });
}

describe("process tool waiting cancellation", () => {
	it.each(["abort", "yield"])("releases wait listeners and the timer after %s", async (outcome) => {
		const entry = worker();
		const exitListeners = entry.child.listenerCount("exit");
		const errorListeners = entry.child.listenerCount("error");
		const controller = new AbortController();
		vi.useFakeTimers();
		try {
			const wait = waitSessionProcess(entry, 300000, controller.signal).then(
				(value) => value,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(vi.getTimerCount()).toBe(1);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
			if (outcome === "abort") controller.abort();
			else await vi.advanceTimersByTimeAsync(300000);
			expect(await wait).toBe(outcome === "abort" ? "Operation aborted" : "running");
			expect(vi.getTimerCount()).toBe(0);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			expect(entry.child.listenerCount("exit")).toBe(exitListeners);
			expect(entry.child.listenerCount("error")).toBe(errorListeners);
			expect(entry.killed).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["poll", "before"],
		["poll", "during"],
		["write", "before"],
		["write", "during"],
	] as const)("cancels %s %s waiting without killing the background worker", async (action, timing) => {
		const entry = worker();
		const stdinWrite = vi.spyOn(entry.child.stdin!, "write");
		const controller = new AbortController();
		if (timing === "before") controller.abort();
		const result = createProcessToolDefinition()
			.execute(
				"abort-wait",
				{ action, session_id: entry.id, chars: "input\n", yield_time_ms: 300000 },
				controller.signal,
				undefined,
				{ cwd, sessionManager: { getSessionId: () => owner } } as ExtensionToolContext,
			)
			.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
		if (timing === "during") controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const outcome = await Promise.race([
				result,
				new Promise<string>((resolve) => {
					timer = setTimeout(() => resolve("still waiting"), 250);
				}),
			]);
			expect(outcome).toBe("Operation aborted");
			expect(entry.killed).toBe(false);
			expect(entry.exitCode).toBeUndefined();
			expect(stdinWrite).toHaveBeenCalledTimes(action === "write" && timing === "during" ? 1 : 0);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		} finally {
			if (timer) clearTimeout(timer);
			terminateSessionProcesses(owner);
			await result;
		}
	});
});
