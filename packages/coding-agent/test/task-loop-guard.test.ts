import { describe, expect, it } from "vitest";
import type { ToolResultEvent } from "../src/core/extensions/types.ts";
import { TaskLoopGuard } from "../src/extensions/task-check/loop-guard.ts";

function result(
	toolName: string,
	input: Record<string, unknown>,
	isError = false,
	text = "Completed the operation.",
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "fixture-call",
		toolName,
		input,
		isError,
		content: [{ type: "text", text }],
		details: undefined,
	};
}

function failed(command = "node check.mjs"): ToolResultEvent {
	return result("bash", { command }, true, "Dependency unavailable.");
}

function discovery(loaded: boolean): ToolResultEvent {
	return result(
		"tool_search",
		{ query: "Fill the form" },
		false,
		JSON.stringify({
			loaded: loaded ? ["browser_fill_form"] : [],
			steps: [
				{
					status: loaded ? "metadata_match" : "no_match",
					intent: { capability: "browser", action: "fill", target: "service-request-form" },
				},
			],
		}),
	);
}

describe("TaskLoopGuard failure windows", () => {
	it.each(["read", "ls", "grep", "bash", "task_check", "tool_search"])(
		"keeps repeated failures across an unrelated successful %s",
		(toolName) => {
			const guard = new TaskLoopGuard();
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(guard.observe(failed())).toBe(false);
				guard.observe(toolName === "tool_search" ? discovery(true) : result(toolName, { path: "src/file.ts" }));
			}
			expect(guard.observe(failed())).toBe(true);
			expect(guard.stop).toEqual({ reason: "repeated-error", toolName: "bash", count: 3 });
		},
	);

	it("clears only the recovered call while preserving another call's failures", () => {
		const guard = new TaskLoopGuard();
		for (let attempt = 0; attempt < 2; attempt++) {
			guard.observe(failed("node first.mjs"));
			guard.observe(failed("node second.mjs"));
		}
		guard.observe(result("bash", { command: "node first.mjs" }));
		expect(guard.observe(failed("node first.mjs"))).toBe(false);
		expect(guard.observe(failed("node first.mjs"))).toBe(false);
		expect(guard.stop).toBeUndefined();
		expect(guard.observe(failed("node second.mjs"))).toBe(true);
	});

	it("matches successful recovery by normalized argument keys rather than a tool call id", () => {
		const guard = new TaskLoopGuard();
		const error = result("probe", { offset: 1, target: { path: "file", mode: "read" } }, true, "Missing file.");
		guard.observe(error);
		guard.observe(error);
		guard.observe(result("probe", { target: { mode: "read", path: "file" }, offset: 1 }));
		expect(guard.observe(error)).toBe(false);
		expect(guard.observe(error)).toBe(false);
		expect(guard.observe(error)).toBe(true);
	});

	it.each(["read", "same-call", "tool_search"])(
		"does not lose a stop when a successful %s result arrives later in the same batch",
		(kind) => {
			const guard = new TaskLoopGuard();
			guard.observe(failed());
			guard.observe(failed());
			expect(guard.observe(failed())).toBe(true);
			const stop = guard.stop;
			guard.observe(
				kind === "tool_search"
					? discovery(true)
					: kind === "same-call"
						? result("bash", { command: "node check.mjs" })
						: result("read", { path: "src/file.ts" }),
			);
			expect(guard.stop).toBe(stop);
		},
	);

	it.each(["edit", "write", "apply_patch"])("opens a fresh failure window after a successful %s", (toolName) => {
		const guard = new TaskLoopGuard();
		guard.observe(failed());
		guard.observe(failed());
		guard.observe(result(toolName, { path: "src/file.ts" }));
		expect(guard.observe(failed())).toBe(false);
		expect(guard.observe(failed())).toBe(false);
		expect(guard.stop).toBeUndefined();
		expect(guard.observe(failed())).toBe(true);
		guard.observe(result(toolName, { path: "src/file.ts" }));
		expect(guard.stop).toBeUndefined();
		expect(guard.observe(failed())).toBe(false);
	});

	it("does not reset the failure window when an edit itself fails", () => {
		const guard = new TaskLoopGuard();
		guard.observe(failed());
		guard.observe(failed());
		guard.observe(result("edit", { path: "src/file.ts" }, true, "Old text was not found."));
		expect(guard.observe(failed())).toBe(true);
	});

	it("counts the same error rather than combining distinct diagnostics", () => {
		const guard = new TaskLoopGuard();
		guard.observe(failed());
		guard.observe(failed());
		const changedError = result("bash", { command: "node check.mjs" }, true, "Different failure.");
		expect(guard.observe(changedError)).toBe(false);
		expect(guard.observe(changedError)).toBe(false);
		expect(guard.observe(changedError)).toBe(true);
	});
});

describe("TaskLoopGuard independent discovery window", () => {
	it.each(["read", "tool_search"])("resets discovery after successful %s without forgetting failures", (kind) => {
		const guard = new TaskLoopGuard();
		for (let attempt = 0; attempt < 2; attempt++) {
			guard.observe(discovery(false));
			guard.observe(failed());
		}
		guard.observe(kind === "tool_search" ? discovery(true) : result("read", { path: "src/file.ts" }));
		guard.observe(discovery(false));
		guard.observe(discovery(false));
		expect(guard.stop).toBeUndefined();
		expect(guard.observe(failed())).toBe(true);
		expect(guard.stop).toEqual({ reason: "repeated-error", toolName: "bash", count: 3 });
	});

	it("starts discovery counting again after a different successful operation", () => {
		const guard = new TaskLoopGuard();
		guard.observe(discovery(false));
		guard.observe(discovery(false));
		guard.observe(result("read", { path: "src/file.ts" }));
		guard.observe(discovery(false));
		guard.observe(discovery(false));
		expect(guard.stop).toBeUndefined();
		guard.observe(discovery(false));
		expect(guard.stop).toEqual({ reason: "discovery-no-progress", toolName: "tool_search", count: 3 });
	});

	it("does not treat task_check bookkeeping as discovery progress", () => {
		const guard = new TaskLoopGuard();
		guard.observe(discovery(false));
		guard.observe(discovery(false));
		guard.observe(result("task_check", {}));
		guard.observe(discovery(false));
		expect(guard.stop?.reason).toBe("discovery-no-progress");
	});

	it("resets latched stops and both windows at a new user turn", () => {
		const guard = new TaskLoopGuard();
		guard.observe(failed());
		guard.observe(failed());
		guard.observe(discovery(false));
		guard.observe(discovery(false));
		guard.observe(discovery(false));
		guard.reset();
		expect(guard.stop).toBeUndefined();
		expect(guard.observe(failed())).toBe(false);
		guard.observe(discovery(false));
		expect(guard.stop).toBeUndefined();
	});
});
