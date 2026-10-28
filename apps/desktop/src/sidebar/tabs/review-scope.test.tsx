import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import type { DiffApprovalFileSummary } from "../../bridge/protocol.ts";
import { createSidebarApi } from "../api.ts";
import { ExecutionContext, type ExecutionContextValue } from "../execution-context.tsx";
import { SidebarStore } from "../store.ts";
import { ReviewTab } from "./ReviewTab.tsx";

let root: Root;
let container: HTMLElement;

function entry(id: string, sessionId: string): DiffApprovalFileSummary {
	return {
		id,
		path: `D:/project/${id}.ts`,
		displayPath: `${id}.ts`,
		status: "pending",
		originalExisted: true,
		currentExists: true,
		added: 1,
		removed: 1,
		size: 20,
		baselineAt: "2026-10-15T01:00:00.000Z",
		resolvedAt: null,
		toolCallId: id,
		sessionId,
		scope: "operation",
	};
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderReview(sessionId: string | undefined, records: DiffApprovalFileSummary[]): Promise<void> {
	const client = {
		request: vi.fn(async (request: { type: string }) => {
			if (request.type === "diffApproval.list") return { ok: true, result: { files: records } };
			return { ok: true, result: {} };
		}),
		onStatus: vi.fn(() => () => {}),
		onDiffApprovalChanged: vi.fn(() => () => {}),
	} as unknown as BridgeClient;
	const api = createSidebarApi(client);
	const context = {
		sessionId,
		profile: "profile-one",
		entries: [],
		subagents: [],
		onOpenSubagent: vi.fn(),
		onRefreshSubagents: vi.fn(),
		onSubmitFeedback: vi.fn(),
	} as unknown as ExecutionContextValue;
	await act(async () =>
		root.render(
			<ExecutionContext.Provider value={context}>
				<ReviewTab
					api={api}
					cwd="D:/project"
					client={client}
					store={new SidebarStore("D:/project")}
					tab={{ id: "review", kind: "review", title: "改动审批" }}
					onOpenFile={vi.fn()}
					gitStatus={undefined}
					onGitRefresh={vi.fn()}
				/>
			</ExecutionContext.Provider>,
		),
	);
}

describe("改动审批的跨会话隔离", () => {
	it("只列本次对话的待审改动，别把别的会话的混进来", async () => {
		await renderReview("session-a", [entry("mine", "session-a"), entry("other", "session-b")]);
		const text = container.textContent ?? "";
		expect(text).toContain("mine.ts");
		expect(text).not.toContain("other.ts");
		// 别的会话还有改动时给出提示与出口。
		expect(text).toContain("另有 1 条其它会话的改动");
	});

	it("「显示全部」后能看到工作区里的全部改动，再点回到本次对话", async () => {
		await renderReview("session-a", [entry("mine", "session-a"), entry("other", "session-b")]);
		const showAll = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			button.textContent?.includes("另有 1 条"),
		)!;
		await act(async () => showAll.click());
		expect(container.textContent ?? "").toContain("other.ts");
		const back = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "只看本次对话",
		)!;
		await act(async () => back.click());
		expect(container.textContent ?? "").not.toContain("other.ts");
	});

	it("没有会话（开始页）时按工作区看全部改动", async () => {
		await renderReview(undefined, [entry("mine", "session-a"), entry("other", "session-b")]);
		const text = container.textContent ?? "";
		expect(text).toContain("mine.ts");
		expect(text).toContain("other.ts");
	});
});
