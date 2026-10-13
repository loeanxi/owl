import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { DesktopSubagentSummary } from "../bridge/protocol.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { selectedSubagent, SubagentView, type SubagentSelection } from "./SubagentView.tsx";

vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return { ...actual, useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot) };
});

function run(id: string, toolCallId: string, parentSessionId = "parent"): DesktopSubagentSummary {
	return { id, runId: id.split(":")[0], childIndex: Number(id.split(":")[1] ?? 0), parentSessionId, toolCallId, agent: "reviewer", task: "审查成片", cwd: "D:/owl", status: "completed", updatedAt: "2026-10-13T06:00:00Z" };
}

afterEach(() => setUiLanguage("zh"));

describe("subagent navigation identity", () => {
	it("opens the exact delegation when the same agent is used in different turns", () => {
		const runs = [run("old:0", "first"), run("new:0", "second")];
		expect(selectedSubagent(runs, { parentSessionId: "parent", toolCallId: "second" })?.id).toBe("new:0");
		expect(selectedSubagent(runs, { parentSessionId: "parent", toolCallId: "missing" })).toBeUndefined();
	});
	it("selects each parallel child by its stable identity and rejects another parent's records", () => {
		const runs = [run("batch:0", "parallel"), run("batch:1", "parallel"), run("other:0", "parallel", "another-parent")];
		expect(selectedSubagent(runs, { parentSessionId: "parent", id: "batch:1" })?.childIndex).toBe(1);
		expect(selectedSubagent(runs, { parentSessionId: "parent", id: "other:0" })).toBeUndefined();
		expect(selectedSubagent(runs, { parentSessionId: "parent" })).toBeUndefined();
		expect(selectedSubagent([runs[1]!, runs[0]!], { parentSessionId: "parent", toolCallId: "parallel" })?.id).toBe("batch:0");
	});
});

function render(selection: SubagentSelection, connected = true, listError?: string): string {
	return renderToStaticMarkup(<SubagentView client={{} as BridgeClient} connected={connected} selection={selection} runs={[]} listLoading={false} listError={listError} view="chat" onBack={() => {}} onRefresh={() => {}} onSelect={() => {}} />);
}

describe("subagent activity recovery", () => {
	it("retains the original delegation when an old run has no readable activity and escapes artifact text", () => {
		const html = render({ parentSessionId: "parent", toolCallId: "call", card: { id: "call", name: "subagent", args: '{"task":"<script>bad()</script>"}', summary: "reviewer", status: "ok", output: { text: "<img src=x onerror=bad()>", totalLines: 1 } } });
		expect(html).toContain("这次委派尚未找到可查看的运行记录");
		expect(html).toContain("返回父会话");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).not.toContain("<textarea");
	});
	it("shows disconnection and actionable errors without a stuck spinner", () => {
		setUiLanguage("en");
		const html = render({ parentSessionId: "parent", id: "old:0" }, false, "request timed out");
		expect(html).toContain("Disconnected");
		expect(html).toContain("request timed out");
		expect(html).toContain("Reload");
		expect(html).toContain('role="alert"');
		expect(html).not.toContain("Loading subagent activity");
	});
});
