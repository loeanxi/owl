import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";

const notRepository = "fatal: not a git repository (or any of the parent directories): .git\n";

async function execute(command: string, output = notRepository, exitCode = 128) {
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(output));
			return { exitCode };
		},
	};
	const definition = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
	return definition.execute("git-query-feedback", { command }, undefined, undefined, {
		cwd: process.cwd(),
	} as ExtensionToolContext);
}

describe("bash tool contract", () => {
	it("keeps search on the read-only tools and leaves bash for commands that must run", () => {
		const definition = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false });
		expect(definition.description).toContain("Search file contents with the grep tool");
		expect(definition.promptSnippet).toContain("tests, git, builds, scripts");
	});
});

describe("bash read-only Git query feedback", () => {
	it.each([
		"git -C /d/owl/Owl-def rev-parse --short HEAD",
		"git -C'/d/owl/path with spaces' log --oneline -3",
		'git -C "/d/owl/path with spaces" status --short',
		"git -C /d/owl -C 'path with spaces' --no-pager log -1",
		"git --git-dir=/__owl_not_a_repo__ status --short 2>&1 | head -5 && echo --- && git --git-dir=/__owl_not_a_repo__ log -1",
	])("recognizes a diagnosed non-repository query without losing its exit code: %s", async (command) => {
		const result = await execute(command);
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toMatchObject({ output: notRepository, exit_code: 128 });
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("not a shell failure") }),
		]);
	});

	it.each([
		["git -C /d/owl/Owl-def log --oneline -3 2>/dev/null", ""],
		[
			'ls -d /d/owl/*/ 2>/dev/null && echo "=== Owl-def ===" && ls /d/owl/Owl-def 2>/dev/null | head -20 && echo "=== git ===" && git -C /d/owl/Owl-def rev-parse --short HEAD 2>/dev/null; git -C /d/owl/Owl-def log --oneline -3 2>/dev/null',
			"=== Owl-def ===\nsorting.py\n=== git ===\n",
		],
		["git -C /d/owl/Owl-def status", "fatal: detected dubious ownership in repository\n"],
		["git -C /d/owl/Owl-def log missing", "fatal: ambiguous argument 'missing': unknown revision\n"],
		["git -C /d/owl/Owl-def status", "fatal: Unable to create '.git/index.lock': Permission denied\n"],
		["git -C /d/owl/Owl-def status", `${notRepository}fatal: repository data is corrupt\n`],
	])("keeps unknown or unrelated exit-128 failures visible: %s", async (command, output) => {
		const result = await execute(command, output);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ output, exit_code: 128 });
	});

	it("preserves the legacy stderr-silenced git-dir probe without extending it to -C paths", async () => {
		const result = await execute("git --git-dir=/__owl_not_a_repo__ log --oneline -3 2>/dev/null", "");
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toMatchObject({ output: "", exit_code: 128 });
	});

	it.each([
		"git -C /d/owl/Owl-def commit -m message",
		"git -C /d/owl/Owl-def reset --hard",
		"git status; git reset --hard",
		"git status && git commit -m message",
		'echo "git status"; git reset --hard',
		"git -C /d/owl/Owl-def commit -m 'git status'",
		"git branch -D example",
		"git remote add origin example",
		"git log --output=history.txt",
	])("does not disguise a writing command or a mixed chain as a query: %s", async (command) => {
		expect((await execute(command)).isError).toBe(true);
	});

	it.each([
		'git log "--output=history.txt"; git -C /missing status',
		'git log "--output" "history.txt"; git -C /missing status',
	])("keeps quoted Git output-file options in mixed chains visible as errors: %s", async (command) => {
		expect((await execute(command)).isError).toBe(true);
	});

	it("requires the diagnostic to be a Git fatal line and the exit code to be 128", async () => {
		expect((await execute("git status", "Earlier prose said not a git repository\n")).isError).toBe(true);
		expect((await execute("git status", notRepository, 1)).isError).toBe(true);
	});
});
