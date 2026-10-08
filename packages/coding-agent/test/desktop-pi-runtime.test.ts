import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import * as bashTools from "../src/core/tools/bash.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { createPiBashTool, PI_SYSTEM_PROMPT } from "../src/modes/desktop/pi-runtime.ts";

describe("Pi coding prompt", () => {
	it("explains batch edit matching and current file prerequisites without suggesting unavailable tools", () => {
		expect(PI_SYSTEM_PROMPT).toContain("edits[].oldText");
		expect(PI_SYSTEM_PROMPT).toContain("original file");
		expect(PI_SYSTEM_PROMPT).toContain("overlapping or nested edits");
		expect(PI_SYSTEM_PROMPT).toContain("whole file in the current turn");
		for (const unavailable of ["codemode", "tool_search", "skill_search", "process tool", "powershell"]) {
			expect(PI_SYSTEM_PROMPT).not.toContain(unavailable);
		}
	});
});

describe("Pi foreground bash", () => {
	it("waits for the full command without exposing or using background process sessions", async () => {
		const spawnSession = vi.fn(() => {
			throw new Error("Pi must not start a background process session");
		});
		const exec = vi.fn<bashTools.BashOperations["exec"]>(async (_command, _cwd, options) => {
			options.onData(Buffer.from("pi completed\n"));
			return { exitCode: 0 };
		});
		const localOperations = vi.spyOn(bashTools, "createLocalBashOperations").mockReturnValue({ exec, spawnSession });
		try {
			const tool = createPiBashTool(process.cwd(), SettingsManager.inMemory({ shellCommandPrefix: "echo prefix;" }));
			expect(Object.keys(tool.parameters.properties)).toEqual(["command", "timeout"]);
			expect(tool.description).not.toContain("process tool");
			const result = await wrapToolDefinition(tool).execute("pi-bash", { command: "echo pi" }, undefined);
			expect(exec).toHaveBeenCalledOnce();
			expect(exec.mock.calls[0]?.[0]).toContain("echo prefix;");
			expect(exec.mock.calls[0]?.[2].timeout).toBeUndefined();
			expect(result.content).toEqual([{ type: "text", text: "pi completed\n" }]);
			expect(result.structuredContent).not.toHaveProperty("session_id");
			expect(spawnSession).not.toHaveBeenCalled();
		} finally {
			localOperations.mockRestore();
		}
	});

	it("passes timeout and cancellation to the foreground command", async () => {
		const exec = vi.fn<bashTools.BashOperations["exec"]>(async (_command, _cwd, options) => {
			options.onData(Buffer.from("finished\n"));
			return { exitCode: 0 };
		});
		const localOperations = vi.spyOn(bashTools, "createLocalBashOperations").mockReturnValue({ exec });
		try {
			const controller = new AbortController();
			const tool = createPiBashTool(process.cwd(), SettingsManager.inMemory());
			await wrapToolDefinition(tool).execute("pi-timeout", { command: "echo done", timeout: 30 }, controller.signal);
			expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 30, signal: controller.signal });
		} finally {
			localOperations.mockRestore();
		}
	});
});
