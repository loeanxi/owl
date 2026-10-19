import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createProcessToolDefinition } from "../src/core/tools/process.ts";
import {
	getSessionProcess,
	registerSessionProcess,
	takePending,
	terminateSessionProcesses,
	writeSessionProcess,
} from "../src/core/tools/process-store.ts";

const owner = "process-exit-feedback";
const context = { cwd: process.cwd(), sessionManager: { getSessionId: () => owner } } as ExtensionToolContext;
const processTool = createProcessToolDefinition();
afterEach(() => terminateSessionProcesses(owner));

function poll(sessionId: number) {
	return processTool.execute(
		"poll-exit",
		{ action: "poll", session_id: sessionId, yield_time_ms: 1000 },
		undefined,
		undefined,
		context,
	);
}

async function completed(exitCode: number, command = "node verify.mjs", shellName?: string, output = "") {
	const child = spawn(
		process.execPath,
		["-e", `process.stdout.write(${JSON.stringify(output)}); process.exitCode=${exitCode};`],
		{
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const options = { child, sessionId: owner, command, shellName, cwd: process.cwd(), acceptsStdin: true };
	const entry = registerSessionProcess(options);
	await entry.exitPromise;
	return entry;
}

describe("background process completion feedback", () => {
	it.each([0, 1, 2, 139])("reports completed exit %s accurately", async (exitCode) => {
		const entry = await completed(exitCode);
		const result = await poll(entry.id);
		expect(result.structuredContent).toMatchObject({ status: "exited", exit_code: exitCode });
		expect(Boolean(result.isError)).toBe(exitCode !== 0);
	});

	it.each([
		["grep missing file", "", false],
		["diff before after | head -10", "1c1\n< before\n---\n> after\n", false],
		["npm test 2>&1 | grep FAIL | head -10", "FAIL verification\n", true],
		["cd missing && grep missing file", "bash: cd: missing: No such file or directory\n", true],
	])("uses retained Bash diagnostics for %s", async (command, output, isError) => {
		const entry = await completed(1, command, "bash", output);
		takePending(entry);
		const result = await poll(entry.id);
		expect(Boolean(result.isError)).toBe(isError);
		expect(result.structuredContent).toMatchObject({ exit_code: 1 });
	});

	it("does not infer a Bash query from an unknown execution backend", async () => {
		const entry = await completed(1, "grep missing file");
		expect((await poll(entry.id)).isError).toBe(true);
	});

	it("keeps unknown signal termination as an error", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
		const entry = registerSessionProcess({
			child,
			sessionId: owner,
			command: "node worker.mjs",
			cwd: process.cwd(),
			acceptsStdin: false,
		});
		child.kill("SIGTERM");
		await entry.exitPromise;
		expect(entry.killed).toBe(false);
		expect((await poll(entry.id)).isError).toBe(true);
	});

	it("does not use incomplete retained output to downgrade a nonzero exit", async () => {
		const entry = await completed(1, "grep missing file", "bash");
		entry.recent.append("x".repeat(2 * 1024 * 1024));
		expect(entry.recent.snapshot().omittedBytes).toBeGreaterThan(0);
		expect((await poll(entry.id)).isError).toBe(true);
	});

	it.each([0, 1])("polls exit %s after a real Bash command yields", async (exitCode) => {
		const result = await createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }).execute(
			"background-exit",
			{ command: `read -r release; printf 'finished\\n'; exit ${exitCode}`, yield_time_ms: 1000 },
			undefined,
			undefined,
			context,
		);
		expect(result.structuredContent).toMatchObject({ status: "running", session_id: expect.any(Number) });
		expect(result.isError).not.toBe(true);
		const sessionId = (result.structuredContent as { session_id: number }).session_id;
		const entry = getSessionProcess(sessionId, owner)!;
		if (exitCode === 1) {
			const running = await poll(sessionId);
			expect(running.structuredContent).toMatchObject({ status: "running" });
			expect(running.isError).not.toBe(true);
		}
		expect(writeSessionProcess(entry, "continue\n")).toBe(true);
		await entry.exitPromise;
		const finished = await poll(sessionId);
		expect(finished.structuredContent).toMatchObject({ status: "exited", exit_code: exitCode });
		expect(Boolean(finished.isError)).toBe(exitCode !== 0);
	});
});
