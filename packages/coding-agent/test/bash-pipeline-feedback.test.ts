import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";

async function execute(command: string, output: string, exitCode = 1) {
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(output));
			return { exitCode };
		},
	};
	return createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false }).execute(
		"pipeline-feedback",
		{ command },
		undefined,
		undefined,
		{ cwd: process.cwd() } as ExtensionToolContext,
	);
}

describe("bash pipeline failure attribution", () => {
	it.each([
		[
			'cd . && npm test 2>&1 | grep -E "FAIL|Tests" | head -40',
			" FAIL example.test.ts\nTests 1 failed | 10 passed\n",
		],
		[
			'cd . && npx vitest run example.test.ts 2>&1 | grep -A 40 "Failed Tests" | head -60',
			"Failed Tests 1\nAssertionError: expected -1 to be greater than or equal to 0\n",
		],
		["npm test 2>&1 | tail -40", "npm error code 1\n"],
		["false | grep missing", ""],
		["node verify.mjs 2>/dev/null", ""],
		["node verify.mjs 2>/dev/null | tail -5", ""],
		["node verify.mjs && grep missing package.json", ""],
		["test -f package.json && node verify.mjs", ""],
		["ls missing 2>/dev/null; node verify.mjs", ""],
		['echo "cat missing 2>/dev/null"; node verify.mjs', "cat missing 2>/dev/null\n"],
		["cat missing | grep something", "cat: missing: No such file or directory\n"],
	])("preserves actual or ambiguous failure in %s", async (command, output) => {
		const result = await execute(command, output);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ output, exit_code: 1 });
		expect(result.content).toEqual([{ type: "text", text: expect.not.stringContaining("no lines matched") }]);
	});

	it.each([
		["grep missing package.json", "", 1, "no lines matched"],
		["printf 'hello\\n' | grep missing | head -5", "", 1, "no lines matched"],
		["grep -c missing package.json", "0\n", 1, "no lines matched"],
		["diff before.txt after.txt | head -20", "1c1\n< before\n---\n> after\n", 1, "the inputs differ"],
		["yes | head -1", "y\n", 141, "SIGPIPE"],
	])("preserves normal query status in %s", async (command, output, exitCode, status) => {
		const result = await execute(command, output, exitCode);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(status) }]);
	});

	it.each([
		["(printf 'FAIL regression\\n'; exit 1) 2>&1 | grep FAIL | head -5", true, "FAIL regression\n"],
		["(printf 'FAIL regression\\n'; exit 1) 2>&1 | tail -5", true, "FAIL regression\n"],
		["false | grep missing", true, ""],
		["printf 'hello\\n' | grep missing", false, ""],
	])("verifies real shell producer status for %s", async (command, isError, output) => {
		const result = await createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }).execute(
			"real-pipeline-feedback",
			{ command, timeout: 5 },
			undefined,
			undefined,
			{ cwd: process.cwd() } as ExtensionToolContext,
		);
		expect(result.isError).toBe(isError);
		expect(result.structuredContent).toMatchObject({ exit_code: 1, output });
		if (isError)
			expect(result.content).toEqual([{ type: "text", text: expect.not.stringContaining("no lines matched") }]);
	});
});
