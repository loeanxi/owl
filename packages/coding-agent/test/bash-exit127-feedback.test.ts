import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

const nativeAssertion =
	"38/38 passed\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94\r\n";

async function executeWithOutput(output: string, exitCode = 127) {
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(output));
			return { exitCode };
		},
	};
	const tool = createBashTool(process.cwd(), { operations, exposeSessionEnvironment: false });
	return tool.execute("exit-feedback", { command: "node verify.cjs" });
}

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

describe("bash exit 127 feedback", () => {
	// Real Windows replay: the available Node binary exits 0xc0000409, which Git Bash reports as 127.
	it("preserves a native assertion without diagnosing a missing binary", async () => {
		const result = await executeWithOutput(nativeAssertion);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ output: nativeAssertion, exit_code: 127 });
		expect(textOutput(result)).toContain(nativeAssertion);
		expect(textOutput(result)).not.toContain("command not found in this shell");
		expect(textOutput(result)).not.toContain("command -v");
	});

	it.each([
		"/usr/bin/bash: line 1: unavailable-command: command not found\n",
		"/bin/sh: 1: unavailable-command: not found\n",
	])("guides availability checks when the shell reports command lookup failure", async (output) => {
		const result = await executeWithOutput(output);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ output, exit_code: 127 });
		expect(textOutput(result)).toContain(output);
		expect(textOutput(result)).toContain("command -v");
	});

	it.each(["", "Application started; its own operation failed\n", "data-reader: input file not found\n"])(
		"does not infer command lookup failure from exit 127 alone",
		async (output) => {
			const result = await executeWithOutput(output);
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({ output, exit_code: 127 });
			expect(textOutput(result)).toContain("Command exited with code 127");
			expect(textOutput(result)).not.toContain("command not found in this shell");
			expect(textOutput(result)).not.toContain("command -v");
		},
	);

	it("does not let a lookup diagnostic override the subsequent native crash", async () => {
		const output = `/usr/bin/bash: child-command: command not found\n${nativeAssertion}`;
		const result = await executeWithOutput(output);
		expect(result.structuredContent).toMatchObject({ output, exit_code: 127 });
		expect(textOutput(result)).not.toContain("command -v");
	});

	it("retains the full native exit code when execution did not go through bash", async () => {
		const result = await executeWithOutput(nativeAssertion, 3221226505);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ output: nativeAssertion, exit_code: 3221226505 });
		expect(textOutput(result)).toContain("Command exited with code 3221226505");
	});
});
