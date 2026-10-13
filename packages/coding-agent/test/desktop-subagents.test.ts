import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DesktopSubagentSource,
	getDesktopSubagent,
	listDesktopSubagents,
} from "../src/modes/desktop/subagents.ts";

describe("read-only desktop subagent inspection", () => {
	let fixture: string;
	let source: DesktopSubagentSource;
	const startedAt = "2026-10-13T07:00:00.000Z";
	const launchedAt = "2026-10-13T06:59:59.000Z";

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), "owl-subagent-inspection-"));
		source = { parentSessionId: "parent", parentFile: join(fixture, "parent.jsonl"), parentRunning: false };
		writeFileSync(
			source.parentFile,
			`${JSON.stringify({ type: "session", id: "parent", cwd: fixture, timestamp: launchedAt })}\n`,
		);
	});

	afterEach(() => {
		if (
			dirname(resolve(fixture)) !== resolve(tmpdir()) ||
			!basename(fixture).startsWith("owl-subagent-inspection-")
		) {
			throw new Error("Unexpected test fixture location");
		}
		rmSync(fixture, { recursive: true, force: true });
	});

	function parentMessage(message: Record<string, unknown>, timestamp = launchedAt): void {
		appendFileSync(source.parentFile, `${JSON.stringify({ type: "message", timestamp, message })}\n`);
	}

	function launch(toolCallId: string, task = "审查图片", args?: Record<string, unknown>): void {
		parentMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: toolCallId, name: "subagent", arguments: args ?? { agent: "reviewer", task } },
			],
		});
	}

	function transcript(
		runId: string,
		childIndex = 0,
		agent = "reviewer",
	): { transcriptPath: string; metadataPath: string } {
		const artifacts = join(fixture, "subagent-artifacts");
		mkdirSync(artifacts, { recursive: true });
		const transcriptPath = join(artifacts, `${runId}_${agent}_${childIndex}_transcript.jsonl`);
		const metadataPath = join(artifacts, `${runId}_${agent}_${childIndex}_meta.json`);
		const rows = [
			{
				recordType: "message",
				sourceEventType: "initial_prompt",
				agent,
				runId,
				childIndex,
				timestamp: startedAt,
				message: { role: "user", content: [{ type: "text", text: "[prompt redacted]" }] },
			},
			{
				recordType: "tool_start",
				timestamp: startedAt,
				toolCallId: "read-1",
				toolName: "read",
				argsPayload: JSON.stringify({ path: "frame.png" }),
			},
			{
				recordType: "message",
				timestamp: startedAt,
				text: "正在核对画面",
				message: { role: "assistant", content: [{ type: "text", text: "正在核对画面" }] },
			},
		];
		writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		return { transcriptPath, metadataPath };
	}

	function childSession(runId: string, childIndex = 0, task = "审查图片", agent = "reviewer"): string {
		const path = join(fixture, "parent", runId, `run-${childIndex}`, "session.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			[
				{ type: "session", id: `${runId}-${childIndex}`, cwd: fixture, timestamp: startedAt },
				{ type: "session_info", name: `subagent-${agent}-${runId}-${childIndex + 1}`, timestamp: startedAt },
				{
					type: "message",
					timestamp: startedAt,
					message: { role: "user", content: [{ type: "text", text: `Task: ${task}` }] },
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n") + "\n",
		);
		return path;
	}

	it("opens the recorded transcript without a child session file and changes no logs", async () => {
		launch("call-one");
		const paths = transcript("run-one");
		parentMessage({
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "call-one",
			details: { runId: "run-one", results: [{ agent: "reviewer", index: 0, exitCode: 0, artifactPaths: paths }] },
		});
		writeFileSync(paths.metadataPath, JSON.stringify({ agent: "reviewer", exitCode: 0, timestamp: startedAt }));
		const original = readFileSync(source.parentFile, "utf8");
		const originalTranscript = readFileSync(paths.transcriptPath, "utf8");
		const summaries = await listDesktopSubagents(source, { toolCallId: "call-one", cwd: fixture });
		expect(summaries).toEqual([
			expect.objectContaining({ id: "run-one:0", toolCallId: "call-one", status: "completed", task: "审查图片" }),
		]);
		const detail = await getDesktopSubagent(source, "run-one");
		expect(detail.messages).toHaveLength(2);
		expect(detail.activity.find((row) => row.type === "tool_start")?.args).toEqual({ path: "frame.png" });
		expect(detail.currentTool).toBeUndefined();
		expect(detail.truncated).toBe(false);
		expect(readFileSync(source.parentFile, "utf8")).toBe(original);
		expect(readFileSync(paths.transcriptPath, "utf8")).toBe(originalTranscript);
		expect(existsSync(join(fixture, "parent", "run-one"))).toBe(false);
		expect(await listDesktopSubagents(source, { cwd: join(fixture, "other") })).toEqual([]);
	});

	it("keeps repeated reviewer calls associated with their own run IDs", async () => {
		for (const [runId, callId] of [
			["first-run", "first-call"],
			["second-run", "second-call"],
		]) {
			launch(callId, runId);
			parentMessage({
				role: "toolResult",
				toolName: "subagent",
				toolCallId: callId,
				details: {
					runId,
					results: [{ agent: "reviewer", index: 0, exitCode: 0, artifactPaths: transcript(runId) }],
				},
			});
		}
		const result = await listDesktopSubagents(source, { toolCallId: "first-call" });
		expect(result.map((child) => child.runId)).toEqual(["first-run"]);
		expect(result[0]?.task).toBe("first-run");
	});

	it("shows live activity before metadata or a parent tool result exists, tolerating a partial final record", async () => {
		launch("active-call");
		childSession("active-run");
		const paths = transcript("active-run");
		appendFileSync(paths.transcriptPath, '{"recordType":"tool_end"');
		source.parentRunning = true;
		const [child] = await listDesktopSubagents(source, { toolCallId: "active-call" });
		expect(child).toMatchObject({ status: "running", currentTool: "read", toolCallId: "active-call" });
		const detail = await getDesktopSubagent(source, "active-run");
		expect(detail.activity).toHaveLength(3);
	});

	it("does not treat a live exitCode zero as completed, and terminal metadata ends a stale running snapshot", async () => {
		launch("live-call");
		const paths = transcript("live-run");
		source.parentRunning = true;
		source.liveToolResults = [
			{
				toolCallId: "live-call",
				details: {
					runId: "live-run",
					results: [
						{ agent: "reviewer", index: 0, exitCode: 0, progress: { status: "running" }, artifactPaths: paths },
					],
				},
			},
		];
		expect((await getDesktopSubagent(source, "live-run")).status).toBe("running");
		writeFileSync(paths.metadataPath, JSON.stringify({ exitCode: 0, timestamp: startedAt }));
		expect((await getDesktopSubagent(source, "live-run")).status).toBe("completed");
	});

	it("prefers a persisted completion over an earlier in-flight snapshot", async () => {
		launch("finished-call");
		const paths = transcript("finished-run");
		source.liveToolResults = [
			{
				toolCallId: "finished-call",
				details: {
					runId: "finished-run",
					results: [
						{ agent: "reviewer", index: 0, exitCode: 0, progress: { status: "running" }, artifactPaths: paths },
					],
				},
			},
		];
		parentMessage({
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "finished-call",
			details: {
				runId: "finished-run",
				results: [{ agent: "reviewer", index: 0, exitCode: 0, artifactPaths: paths }],
			},
		});
		expect((await getDesktopSubagent(source, "finished-run")).status).toBe("completed");
	});

	it("reads background progress while the parent is idle and never takes steps from a different run", async () => {
		launch("background-call");
		const asyncDir = join(fixture, "async-run");
		mkdirSync(asyncDir);
		const sessionFile = childSession("background-run");
		const paths = transcript("background-run");
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				runId: "background-run",
				steps: [{ agent: "reviewer", status: "running", sessionFile, transcriptPath: paths.transcriptPath }],
			}),
		);
		parentMessage({
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "background-call",
			details: { asyncId: "background-run", asyncDir, results: [] },
		});
		const [summary] = await listDesktopSubagents(source, { toolCallId: "background-call" });
		expect(summary).toMatchObject({ runId: "background-run", status: "running", currentTool: "read" });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({ runId: "different-run", steps: [{ agent: "reviewer", status: "failed", sessionFile }] }),
		);
		expect((await getDesktopSubagent(source, "background-run")).status).toBe("unknown");
	});

	it("keeps one public child when the detached run ID differs from its session directory ID", async () => {
		launch("detached-call");
		const sessionFile = childSession("storage-run");
		const paths = transcript("public-async-run");
		parentMessage({
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "detached-call",
			details: {
				runId: "public-async-run",
				results: [{ agent: "reviewer", index: 0, sessionFile, exitCode: 0, artifactPaths: paths }],
			},
		});
		const children = await listDesktopSubagents(source);
		expect(children.map((child) => child.id)).toEqual(["public-async-run:0"]);
		expect(children[0]?.toolCallId).toBe("detached-call");
	});

	it("lists every legacy parallel child by index and restores its delegated task", async () => {
		launch("parallel-call", "", {
			tasks: [
				{ agent: "reviewer", task: "检查一" },
				{ agent: "reviewer", task: "检查二" },
			],
		});
		parentMessage({
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "parallel-call",
			details: {
				runId: "parallel-run",
				results: [0, 1].map((index) => ({
					agent: "reviewer",
					index,
					exitCode: 0,
					artifactPaths: transcript("parallel-run", index),
				})),
			},
		});
		const children = await listDesktopSubagents(source, { toolCallId: "parallel-call" });
		expect(children.map((child) => child.id).sort()).toEqual(["parallel-run:0", "parallel-run:1"]);
		expect(children.find((child) => child.childIndex === 1)?.task).toBe("检查二");
	});

	it("uses workflow child run IDs instead of overwriting children with the workflow's shared index", async () => {
		launch("workflow-call", "", { workflow: "review-workflow" });
		childSession("workflow-child-a", 0, "步骤一");
		childSession("workflow-child-b", 0, "步骤二");
		transcript("workflow-child-a");
		transcript("workflow-child-b");
		source.liveToolResults = [
			{
				toolCallId: "workflow-call",
				details: {
					runId: "workflow-root",
					workflowChildren: {
						version: 1,
						parentToolCallId: "workflow-call",
						children: [
							{ childId: "one", runId: "workflow-child-a", agent: "reviewer", state: "running" },
							{ childId: "two", runId: "workflow-child-b", agent: "reviewer", state: "completed" },
						],
					},
					results: [
						{ workflowKey: "one", agent: "reviewer", index: 0, progress: { status: "running" }, exitCode: 0 },
						{ workflowKey: "two", agent: "reviewer", index: 0, exitCode: 0 },
					],
				},
			},
		];
		const children = await listDesktopSubagents(source, { toolCallId: "workflow-call" });
		expect(children.map((child) => child.id).sort()).toEqual(["workflow-child-a:0", "workflow-child-b:0"]);
		expect(children.find((child) => child.runId === "workflow-child-a")?.status).toBe("running");
		expect(children.find((child) => child.runId === "workflow-child-b")?.task).toBe("步骤二");
	});

	it("keeps stopped and interrupted children distinct from tool failures", async () => {
		for (const [runId, flags] of [
			["stopped-run", { stopped: true }],
			["paused-run", { interrupted: true }],
		] as const) {
			launch(runId);
			parentMessage({
				role: "toolResult",
				toolName: "subagent",
				toolCallId: runId,
				details: {
					runId,
					results: [
						{
							agent: "reviewer",
							index: 0,
							exitCode: 1,
							progress: { status: "failed" },
							...flags,
							artifactPaths: transcript(runId),
						},
					],
				},
			});
		}
		expect((await getDesktopSubagent(source, "stopped-run")).status).toBe("stopped");
		expect((await getDesktopSubagent(source, "paused-run")).status).toBe("paused");
	});

	it("does not mark an orphaned old child running just because its log lacks terminal metadata", async () => {
		launch("orphan-call");
		childSession("orphan-run");
		expect((await getDesktopSubagent(source, "orphan-run")).status).toBe("unknown");
	});

	it("rejects traversal, foreign children, and a mismatched parent identity", async () => {
		await expect(getDesktopSubagent(source, "../foreign")).rejects.toThrow("无效");
		await expect(getDesktopSubagent(source, "foreign-run")).rejects.toThrow("此父会话");
		await expect(getDesktopSubagent(source, "foreign-run", -1)).rejects.toThrow("无效");
		await expect(listDesktopSubagents({ ...source, parentSessionId: "wrong-parent" })).rejects.toThrow("不一致");
	});
});
