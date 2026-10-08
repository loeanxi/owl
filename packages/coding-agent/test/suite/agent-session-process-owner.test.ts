import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessTool, createProcessToolDefinition } from "../../src/core/tools/process.ts";
import {
	getSessionProcess,
	killSessionProcess,
	listSessionProcesses,
	type ProcessEntry,
	registerSessionProcess,
} from "../../src/core/tools/process-store.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const entries: ProcessEntry[] = [];
const closed: Promise<void>[] = [];
afterEach(async () => {
	for (const entry of entries.splice(0)) killSessionProcess(entry);
	await Promise.all(closed.splice(0));
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function ownerProcess(harness: Harness, name: string) {
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let output = "";
	const child = spawn(
		process.execPath,
		[
			"-e",
			"process.stdin.setEncoding('utf8');process.stdout.write('READY\\n');process.stdin.on('data',value=>{process.stdout.write('ECHO:'+value);process.stdin.destroy();});",
		],
		{ cwd: harness.tempDir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
	const entry = registerSessionProcess({
		child,
		sessionId: harness.sessionManager.getSessionId(),
		command: name,
		cwd: harness.tempDir,
		acceptsStdin: true,
		onData: (chunk) => {
			output += chunk;
			if (output.includes("READY")) ready();
		},
	});
	entries.push(entry);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			started,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("Owned child did not start")), 3000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	return entry;
}

describe("native process ownership", () => {
	it("limits model list/poll/write/kill to the real calling session while preserving standalone access", async () => {
		const a = await createHarness();
		const b = await createHarness();
		harnesses.push(a, b);
		const entryA = await ownerProcess(a, "OWNER_A");
		const entryB = await ownerProcess(b, "OWNER_B");
		const ctxA = a.session.extensionRunner.createToolContext("process-a", undefined);
		const ctxB = b.session.extensionRunner.createToolContext("process-b", undefined);
		const tool = createProcessToolDefinition();
		const list = await tool.execute("list-a", { action: "list" }, undefined, undefined, ctxA);
		expect(list.structuredContent).toMatchObject({ sessions: [{ id: entryA.id }] });
		for (const action of ["poll", "write", "kill"] as const) {
			const denied = await tool.execute(
				`deny-${action}`,
				{ action, session_id: entryB.id, chars: "FORBIDDEN\n", yield_time_ms: 1000 },
				undefined,
				undefined,
				ctxA,
			);
			expect(denied.isError).toBe(true);
			expect(entryB.killed).toBe(false);
			expect(entryB.exitCode).toBeUndefined();
		}
		const own = await tool.execute(
			"own-write",
			{ action: "write", session_id: entryA.id, chars: "allowed\n", yield_time_ms: 1000 },
			undefined,
			undefined,
			ctxA,
		);
		expect(own.isError).not.toBe(true);
		expect(entryA.recent.snapshot().content).toContain("ECHO:allowed");
		const killed = await tool.execute(
			"own-kill",
			{ action: "kill", session_id: entryB.id },
			undefined,
			undefined,
			ctxB,
		);
		expect(killed.isError).not.toBe(true);
		expect(entryB.killed).toBe(true);
		const standalone = await createProcessTool().execute("admin-list", { action: "list" });
		expect(standalone.structuredContent).toMatchObject({
			sessions: expect.arrayContaining(
				[{ id: entryA.id }, { id: entryB.id }].map((entry) => expect.objectContaining(entry)),
			),
		});
		expect(listSessionProcesses("")).toHaveLength(0);
		expect(getSessionProcess(entryA.id, "")).toBeUndefined();
		expect(a.faux.state.callCount).toBe(0);
		expect(b.faux.state.callCount).toBe(0);
	});
});
