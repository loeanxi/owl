import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTaskCheckExtension } from "../../src/extensions/task-check/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const OUTPUT = " RUN v4.1.11 __CWD__\n ✓ test/probe.test.ts (2 tests)\n Test Files 1 passed (1)\n Tests 2 passed (2)\n";

async function runCheck(
	command: string,
	options: {
		claim?: string | ((harness: Harness) => string);
		evidence?: string;
		kind?: boolean;
		id?: string;
		output?: string;
		structured?: Record<string, unknown>;
		isError?: boolean;
	} = {},
) {
	const output = options.output ?? OUTPUT;
	const harness = await createHarness({
		initialActiveToolNames: ["task_check", "bash"],
		settings: { retry: { enabled: false } },
		extensionFactories: [
			createTaskCheckExtension(),
			(pi) =>
				pi.registerTool({
					name: "bash",
					label: "Offline runner",
					description: "Replay a command result without executing it",
					parameters: Type.Object({ command: Type.String() }),
					execute: async (_id, _input, _signal, _update, ctx) => ({
						isError: options.isError ?? false,
						content: [{ type: "text", text: output.replaceAll("__CWD__", ctx.cwd.replaceAll("\\", "/")) }],
						structuredContent: {
							output: output.replaceAll("__CWD__", ctx.cwd.replaceAll("\\", "/")),
							truncated: false,
							exit_code: 0,
							...options.structured,
						},
						details: {},
					}),
				}),
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command }, { id: "test-run" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(
			fauxToolCall("task_check", {
				goal: "Verify the authorized regression without editing the test file",
				criteria: [
					{
						criterion:
							typeof options.claim === "function"
								? options.claim(harness)
								: (options.claim ?? "Run test/probe.test.ts successfully"),
						status: "verified",
						evidence: options.evidence ?? "Vitest reports Test Files 1 passed (1), Tests 2 passed (2).",
						...(options.kind === false ? {} : { evidenceKind: "command" }),
						...(options.id === "none" ? {} : { toolCallId: options.id ?? "test-run" }),
					},
				],
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The observed validation result is recorded."),
	]);
	await harness.session.prompt("Run the existing regression and record actual command evidence.");
	return { harness, result: getToolResult(harness, "task_check") };
}

describe("task_check command evidence", () => {
	it("accepts a successful actual runner proof without requiring a test-file edit", async () => {
		const { result } = await runCheck("npx vitest run test/probe.test.ts");
		expect(result.isError).toBe(false);
		expect(result.details).toMatchObject({ active: true, state: { criteria: [{ evidenceKind: "command" }] } });
	});

	it("gives the original unlinked pipeline claim a command-proof template instead of demanding a write", async () => {
		const { result } = await runCheck("npx vitest run test/probe.test.ts 2>&1 | tail -25", {
			kind: false,
			id: "none",
		});
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain('"evidenceKind":"command"');
		expect(getMessageText(result)).not.toContain("Host did not observe a successful edit or write");
	});

	it.each(["read-file", "modified-file", "读取文件"])(
		"does not turn the filename %s into a semantic claim",
		async (name) => {
			const file = `test/${name}.test.ts`;
			const { result } = await runCheck(`npx vitest run ${file}`, {
				claim: `Run ${file} successfully`,
				output: OUTPUT.replaceAll("test/probe.test.ts", file),
				evidence: "The generated catalogs test reports Test Files 1 passed (1), Tests 2 passed (2).",
			});
			expect(result.isError).toBe(false);
		},
	);

	it("matches quoted paths with spaces relative to the explicit cd directory", async () => {
		const { result } = await runCheck('cd "package space" && npx vitest run "test space/probe.test.ts"', {
			claim: 'Run "test space/probe.test.ts" successfully',
			output: OUTPUT.replace("__CWD__", "__CWD__/package space").replace(
				"test/probe.test.ts",
				"test space/probe.test.ts",
			),
		});
		expect(result.isError).toBe(false);
	});

	it.each([
		"echo npx vitest run test/probe.test.ts",
		"node other-runner.js test/probe.test.ts",
		"npx vitest run other.test.ts -t test/probe.test.ts",
		"npx vitest run test/probe.test.ts # ignored",
		"npx vitest run test/probe.test.ts | tail -25",
		"npx vitest run test/probe.test.ts || true",
		"npx vitest run test/probe.test.ts; echo success",
		"npx vitest run $(echo test/probe.test.ts)",
		"cd -P && npx vitest run test/probe.test.ts",
	])("rejects unsupported command grammar: %s", async (command) => {
		const { result } = await runCheck(command);
		expect(result.isError).toBe(true);
	});

	it.each([
		{ exit_code: 128 },
		{ exit_code: undefined },
		{ exit_code: null },
		{ status: "running" },
		{ status: "unknown" },
		{ truncated: true },
		{ truncated: undefined },
		{ output: null },
	])("rejects incomplete or unsuccessful structured results: %j", async (structured) => {
		const { result } = await runCheck("npx vitest run test/probe.test.ts", { structured });
		expect(result.isError).toBe(true);
	});

	it.each([
		OUTPUT.replace("✓ test/probe.test.ts (2 tests)\n", ""),
		OUTPUT.replace("✓ test/probe.test.ts", "✓ other/test/probe.test.ts"),
		OUTPUT.replace("✓ test/probe.test.ts", "✓ test/unrelated.test.ts"),
		OUTPUT.replace("RUN v4.1.11 __CWD__", "RUN v4.1.11 /other-project"),
		OUTPUT.replace("Tests 2 passed (2)", "Tests 0 passed (0)"),
		OUTPUT.replace("Tests 2 passed (2)", "Tests 2 skipped (2)"),
		OUTPUT.replace("Test Files 1 passed (1)", "Test Files 1 failed (1)"),
	])("rejects output without matching positive file/test results", async (output) => {
		const { result } = await runCheck("npx vitest run test/probe.test.ts", { output });
		expect(result.isError).toBe(true);
	});

	it.each([
		"Updated test/probe.test.ts",
		"Generated test/probe.test.ts",
		"test/probe.test.ts was modified",
		"Read test/probe.test.ts and preserve it",
		"生成 test/probe.test.ts",
	])("keeps mutation/read/generated claims out of command proof: %s", async (claim) => {
		const { result } = await runCheck("npx vitest run test/probe.test.ts", { claim });
		expect(result.isError).toBe(true);
	});

	it("rejects an absolute claim naming the same relative selector in another directory", async () => {
		const { result } = await runCheck("cd other-project && npx vitest run test/probe.test.ts", {
			claim: (harness) => `Run ${join(harness.tempDir, "test/probe.test.ts")} successfully`,
			output: OUTPUT.replace("__CWD__", "__CWD__/other-project"),
		});
		expect(result.isError).toBe(true);
	});

	it("never describes an explicitly running call as having exited zero", async () => {
		const { result } = await runCheck("npx vitest run test/probe.test.ts", {
			claim: "Updated src/probe.ts",
			kind: false,
			id: "none",
			structured: { status: "running", exit_code: undefined },
		});
		expect(getMessageText(result)).toContain("Commands without a completed exit code");
		expect(getMessageText(result)).not.toContain("Commands that exited 0");
	});

	it("does not reuse a previous user turn's command proof", async () => {
		const { harness } = await runCheck("npx vitest run test/probe.test.ts");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task_check", {
					goal: "Verify again",
					criteria: [
						{
							criterion: "Run test/probe.test.ts",
							status: "verified",
							evidence: "The earlier runner returned two tests passed.",
							evidenceKind: "command",
							toolCallId: "test-run",
						},
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("A new command observation is required."),
		]);
		await harness.session.prompt("Verify the test result again.");
		expect(getToolResult(harness, "task_check").isError).toBe(true);
	});

	it.each([false, true])("restores evidenceKind and rejects unknown saved kinds (corrupt=%s)", async (corrupt) => {
		const { harness: original } = await runCheck("npx vitest run test/probe.test.ts");
		const manager = SessionManager.inMemory(original.tempDir, undefined, [
			original.sessionManager.getHeader()!,
			...original.sessionManager.getEntries(),
		]);
		if (corrupt)
			manager.appendCustomEntry("owl-task-check", {
				version: 1,
				goal: "Invalid saved kind",
				criteria: [
					{
						criterion: "Run test/probe.test.ts",
						status: "verified",
						evidence: "The earlier runner returned two tests passed.",
						evidenceKind: "write",
						toolCallId: "test-run",
					},
				],
			});
		const resumed = await createHarness({
			sessionManager: manager,
			initialActiveToolNames: ["task_check"],
			extensionFactories: [createTaskCheckExtension()],
			settings: { retry: { enabled: false } },
		});
		harnesses.push(resumed);
		resumed.setResponses([
			fauxAssistantMessage(fauxToolCall("task_check", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Only inspecting the stored state."),
		]);
		await resumed.session.prompt("Only inspect the stored checklist.");
		if (corrupt) expect(getToolResult(resumed, "task_check").details).toMatchObject({ state: null, active: false });
		else
			expect(getToolResult(resumed, "task_check").details).toMatchObject({
				state: { criteria: [{ evidenceKind: "command" }] },
				active: false,
			});
	});
});
