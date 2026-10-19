import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSessionProcesses, terminateSessionProcesses } from "../../src/core/tools/process-store.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await closeBackground(harness);
		harness.cleanup();
	}
});

async function closeBackground(harness: Harness): Promise<void> {
	const children = listSessionProcesses(harness.sessionManager.getSessionId()).map((entry) =>
		entry.child.exitCode === null
			? new Promise<void>((resolve) => entry.child.once("close", () => resolve()))
			: Promise.resolve(),
	);
	terminateSessionProcesses(harness.sessionManager.getSessionId());
	await Promise.all(children);
}

async function setup(): Promise<Harness> {
	const harness = await createHarness({
		initialActiveToolNames: ["read", "write", "edit", "bash", "grep", "find", "process"],
		toolActivation: "eager",
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

function call(name: string, args: ToolCall["arguments"]) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

const nodeCommand = `'${process.execPath.replaceAll("\\", "/").replaceAll("'", "'\\''")}' worker.mjs`;

describe("second-round agent reliability through actual Windows file and process boundaries", () => {
	it.each(["array", "single-object", "json-string", "legacy"])(
		"preserves Chinese paths, spaces, BOM and CRLF through %s edit arguments",
		async (shape) => {
			const harness = await setup();
			const path = join(harness.tempDir, "中文 目录", "配置 文件.txt");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "\uFEFF说明\r\n目标 = 1;\r\n保留\r\n");
			const edit = { oldText: "目标 = 1;", newText: "目标 = 2;" };
			const input: ToolCall["arguments"] =
				shape === "legacy"
					? { path, ...edit }
					: {
							path,
							edits:
								shape === "single-object" ? edit : shape === "json-string" ? JSON.stringify([edit]) : [edit],
						};
			harness.setResponses([
				call("read", { path }),
				call("edit", input),
				call("write", { path, content: "\uFEFF说明\r\n目标 = 2;\r\n保留\r\n已确认\r\n" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt(
				"Read, edit the target value, then append the confirmation while preserving all other content.",
			);
			expect(
				harness.session.messages
					.filter((message) => message.role === "toolResult" && message.isError)
					.map(getMessageText),
			).toEqual([]);
			expect(readFileSync(path, "utf8")).toBe("\uFEFF说明\r\n目标 = 2;\r\n保留\r\n已确认\r\n");
		},
	);

	it("rejects structured edit text without changing bytes and accepts corrected parameters", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "input.txt");
		writeFileSync(path, "original\n");
		harness.setResponses([
			call("read", { path }),
			call("edit", { path, edits: [{ oldText: { text: "original" }, newText: "corrected" }] }),
			() => {
				expect(readFileSync(path, "utf8")).toBe("original\n");
				return call("edit", { path, edits: [{ oldText: "original", newText: "corrected" }] });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Correct the malformed edit arguments and complete the edit.");
		const edits = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "edit",
		);
		expect(edits.map((message) => message.isError)).toEqual([true, false]);
		expect(readFileSync(path, "utf8")).toBe("corrected\n");
	});

	it("refuses an overwrite based on a partial read and recovers after a full read", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "two-lines.txt");
		writeFileSync(path, "visible\nhidden\n");
		harness.setResponses([
			call("read", { path, limit: 1 }),
			call("write", { path, content: "complete replacement\n" }),
			() => {
				expect(readFileSync(path, "utf8")).toBe("visible\nhidden\n");
				return call("read", { path });
			},
			call("write", { path, content: "complete replacement\n" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Do not overwrite unread content; obtain the complete file before replacing it.");
		const writes = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "write",
		);
		expect(writes.map((message) => message.isError)).toEqual([true, false]);
		expect(readFileSync(path, "utf8")).toBe("complete replacement\n");
	});

	it("does not overwrite an external edit made after a full read in the same user request", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "shared.txt");
		writeFileSync(path, "original\n");
		harness.setResponses([
			call("read", { path }),
			() => {
				writeFileSync(path, "another writer's change\n");
				return call("write", { path, content: "stale replacement\n" });
			},
			fauxAssistantMessage("Stopped before overwriting an external change."),
		]);
		await harness.session.prompt("Update the file while preserving any concurrent external edits.");
		expect(getToolResult(harness, "write").isError).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("another writer's change\n");
	});

	it("treats native grep and find no-match outcomes as successful empty searches", async () => {
		const harness = await setup();
		const installedFd = join(homedir(), ".owl", "agent", "bin", process.platform === "win32" ? "fd.exe" : "fd");
		if (existsSync(installedFd)) vi.stubEnv("PATH", `${dirname(installedFd)}${delimiter}${process.env.PATH ?? ""}`);
		writeFileSync(join(harness.tempDir, "known.txt"), "present value\n");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("grep", { pattern: "absent_value_20261019", path: harness.tempDir }),
					fauxToolCall("find", { pattern: "absent*.txt", path: harness.tempDir }),
				],
				{ stopReason: "toolUse" },
			),
			call("grep", { pattern: "present value", path: harness.tempDir, literal: true }),
			fauxAssistantMessage("No absent matches; the existing value is present."),
		]);
		await harness.session.prompt("Search for missing content and filenames, then confirm the existing content.");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.filter((message) => message.isError).map(getMessageText)).toEqual([]);
		expect(getMessageText(results[0])).toContain("No matches found");
		expect(getMessageText(results[1])).toContain("No files found");
		expect(getMessageText(results[2])).toContain("present value");
	});

	it("preserves both independent changes when two edits of the same read file are requested together", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "concurrent.txt");
		writeFileSync(path, "left=1\nright=2\n");
		harness.setResponses([
			call("read", { path }),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", { path, edits: [{ oldText: "left=1", newText: "left=10" }] }),
					fauxToolCall("edit", { path, edits: [{ oldText: "right=2", newText: "right=20" }] }),
				],
				{ stopReason: "toolUse" },
			),
			call("read", { path }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Update both independent values in the same file and verify both survived.");
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult" && message.isError)
				.map(getMessageText),
		).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe("left=10\nright=20\n");
		expect(getMessageText(getToolResult(harness, "read"))).toBe("left=10\nright=20\n");
	});

	it.each([0, 1])("retains the real exit status %s after a yielded worker receives input", async (exitCode) => {
		const harness = await setup();
		writeFileSync(
			join(harness.tempDir, "worker.mjs"),
			`process.stdin.once("data", () => { console.log("WORKER_FINISHED"); process.exit(${exitCode}); });\n`,
		);
		let sessionId = 0;
		harness.setResponses([
			call("bash", { command: nodeCommand, yield_time_ms: 1000 }),
			() => {
				const match = /session_id: (\d+)/.exec(getMessageText(getToolResult(harness, "bash")));
				if (!match) throw new Error("Worker did not yield a session");
				sessionId = Number(match[1]);
				return call("process", { action: "write", session_id: sessionId, chars: "finish\n", yield_time_ms: 1000 });
			},
			() => call("process", { action: "poll", session_id: sessionId, yield_time_ms: 1000 }),
			fauxAssistantMessage("Recorded the actual exit status."),
		]);
		await harness.session.prompt("Run the worker in the background, send its input, and report its real exit code.");
		const outcomes = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "process",
		);
		expect(outcomes.map((message) => message.isError)).toEqual([exitCode !== 0, exitCode !== 0]);
		expect(getMessageText(outcomes[0])).toContain("WORKER_FINISHED");
		expect(getMessageText(outcomes[1])).toContain(`exited (code ${exitCode}`);
	});

	it("settles a cancelled task promptly while the process tool is waiting for background output", async () => {
		const harness = await setup();
		writeFileSync(join(harness.tempDir, "worker.mjs"), 'process.stdin.once("data", () => process.exit(0));\n');
		let entered = () => {};
		const pollStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "process") entered();
		});
		harness.setResponses([
			call("bash", { command: nodeCommand, yield_time_ms: 1000 }),
			() => {
				const result = getToolResult(harness, "bash");
				const match = /session_id: (\d+)/.exec(getMessageText(result));
				if (!match) throw new Error(`Bash did not yield a background session: ${getMessageText(result)}`);
				const sessionId = Number(match[1]);
				return call("process", { action: "poll", session_id: sessionId, yield_time_ms: 300000 });
			},
			fauxAssistantMessage("must not continue after cancellation"),
		]);
		const run = harness.session.prompt("Start the local worker and wait for its completion until I cancel.");
		let abort: Promise<void> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			expect(await Promise.race([pollStarted.then(() => true), run.then(() => false)])).toBe(true);
			// The start event precedes dispatch; allow the real process poll to enter its pending wait.
			await new Promise((resolve) => setTimeout(resolve, 50));
			abort = harness.session.abort();
			const promptly = await Promise.race([
				abort.then(() => true),
				new Promise<boolean>((resolve) => {
					timeout = setTimeout(() => resolve(false), 1000);
				}),
			]);
			expect(promptly, "Cancellation must not wait for the 300-second process polling deadline").toBe(true);
			expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);
		} finally {
			if (timeout) clearTimeout(timeout);
			await closeBackground(harness);
			await abort;
			await run;
		}
	});
});
