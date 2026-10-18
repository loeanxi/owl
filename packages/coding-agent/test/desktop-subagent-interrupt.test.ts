import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { interruptDesktopSubagent } from "../src/modes/desktop/subagent-interrupt.ts";
import { listDesktopSubagents } from "../src/modes/desktop/subagents.ts";

vi.mock("../src/modes/desktop/subagents.ts", () => ({ listDesktopSubagents: vi.fn() }));
const source = { parentSessionId: "parent", parentFile: "parent.jsonl", parentRunning: true };

function control(isError = false) {
	const execute = vi.fn().mockResolvedValue({
		isError,
		content: [{ type: "text", text: isError ? "Not interruptible" : "Interrupt requested" }],
	});
	const context = { owner: "parent" };
	const runner = {
		getToolDefinition: vi.fn(() => ({ execute })),
		createToolContext: vi.fn(() => context),
	} as unknown as Pick<ExtensionRunner, "getToolDefinition" | "createToolContext">;
	return { runner, execute, context };
}

describe("desktop delegation interrupt", () => {
	it("verifies ownership before dispatching a real run-level interrupt", async () => {
		vi.mocked(listDesktopSubagents).mockResolvedValue([{ runId: "owned-run", status: "running" }] as never);
		const { runner, execute, context } = control();
		await expect(interruptDesktopSubagent(source, "owned-run", runner, "request")).resolves.toEqual({
			message: "Interrupt requested",
		});
		expect(execute).toHaveBeenCalledWith(
			"desktop-interrupt:request",
			{ action: "interrupt", id: "owned-run" },
			undefined,
			undefined,
			context,
		);
	});

	it("never interrupts a run absent from this parent's inventory", async () => {
		vi.mocked(listDesktopSubagents).mockResolvedValue([]);
		const { runner, execute } = control();
		await expect(interruptDesktopSubagent(source, "foreign-run", runner, "request")).rejects.toThrow("not found");
		expect(execute).not.toHaveBeenCalled();
	});

	it("reports extension refusal instead of claiming success", async () => {
		vi.mocked(listDesktopSubagents).mockResolvedValue([{ runId: "owned-run", status: "running" }] as never);
		const { runner } = control(true);
		await expect(interruptDesktopSubagent(source, "owned-run", runner, "request")).rejects.toThrow(
			"Not interruptible",
		);
	});

	it("does not dispatch a completed run or malformed run ID", async () => {
		vi.mocked(listDesktopSubagents).mockResolvedValue([{ runId: "owned-run", status: "completed" }] as never);
		const { runner, execute } = control();
		await expect(interruptDesktopSubagent(source, "owned-run", runner, "request")).rejects.toThrow(
			"no longer running",
		);
		await expect(interruptDesktopSubagent(source, "../run", runner, "request")).rejects.toThrow("Invalid");
		expect(execute).not.toHaveBeenCalled();
	});
});
