import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingResponses, PendingResponsesContext } from "../bridge/pending-responses.ts";
import type { PermissionRequest, QuestionAnswerPayload, QuestionRequest } from "../bridge/protocol.ts";
import { t } from "../i18n/index.ts";
import { DynamicIsland } from "./DynamicIsland.tsx";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { QuestionDock } from "./QuestionDock.tsx";

vi.mock("./ChatStream.tsx", () => ({ renderMarkdown: (text: string) => text }));
let container: HTMLElement;
let root: Root;
let controller: PendingResponses;
const permission: PermissionRequest = {
	type: "permission_request",
	requestId: "permission",
	sessionId: "background",
	toolName: "bash",
	input: { command: "git diff -- src/example.ts" },
};
const question: QuestionRequest = {
	type: "question_request",
	requestId: "question",
	sessionId: "one",
	questions: [
		{ header: "方案", question: "选哪个方案？", multiSelect: false, options: [{ label: "甲" }, { label: "乙" }] },
		{ header: "范围", question: "选择范围", multiSelect: true, options: [{ label: "一" }, { label: "二" }] },
	],
};

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"MutationObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	vi.stubGlobal("cancelAnimationFrame", () => {});
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	controller = new PendingResponses();
});
afterEach(async () => {
	await act(async () => root.unmount());
	controller.invalidate();
	vi.unstubAllGlobals();
});
async function render(children: React.ReactNode): Promise<void> {
	await act(async () =>
		root.render(<PendingResponsesContext.Provider value={controller}>{children}</PendingResponsesContext.Provider>),
	);
}
function button(label: string): HTMLButtonElement {
	const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => (item.textContent ?? "").replace("Ctrl+Enter", "").trim() === label,
	);
	if (!result) throw new Error(`Missing ${label}: ${container.textContent}`);
	return result;
}
async function click(label: string): Promise<void> {
	await act(async () => button(label).click());
}
async function choose(label: string): Promise<void> {
	await act(async () => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
}

describe("pending approval and question feedback", () => {
	it("shows the actual approval object, supports later, and retains business failures until a retry succeeds", async () => {
		const later = vi.fn();
		const confirmed = vi.fn();
		const pending = Promise.withResolvers<{ ok: boolean; error?: string }>();
		const respond = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: true });
		await render(
			<PermissionDialog
				request={permission}
				contextLabel="B 项目接口修复"
				workspace="D:/beta"
				onLater={later}
				onDecide={() => {
					void controller.submit({
						requestId: permission.requestId,
						sessionId: permission.sessionId,
						respond,
						confirmed,
					});
				}}
			/>,
		);
		expect(container.textContent).toContain("git diff -- src/example.ts");
		expect(container.textContent).toContain("D:/beta");
		await click("稍后处理");
		expect(later).toHaveBeenCalledOnce();
		expect(respond).not.toHaveBeenCalled();
		await act(async () => {
			const allow = button(t("perm.allow"));
			allow.click();
			allow.click();
		});
		expect(respond).toHaveBeenCalledOnce();
		expect(button(t("perm.allow")).disabled).toBe(true);
		expect(button(t("perm.deny")).disabled).toBe(true);
		expect(container.querySelector('.owl-pending-feedback[role="status"]')?.textContent).toContain("等待提交确认");
		await act(async () => pending.resolve({ ok: false, error: "Host rejected this request" }));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Host rejected");
		expect(confirmed).not.toHaveBeenCalled();
		await click("原样重试");
		expect(confirmed).toHaveBeenCalledOnce();
	});

	it("retains all answers, current page and notes after a failure and retries its original payload", async () => {
		controller.saveQuestionDraft(question.requestId, {
			states: [
				{ picked: new Set(), custom: "", customOpen: false, note: "", noteOpen: false, previewOpen: new Set() },
				{
					picked: new Set(),
					custom: "补充范围",
					customOpen: true,
					note: "保留备注",
					noteOpen: true,
					previewOpen: new Set(),
				},
			],
			current: 0,
			missing: new Set(),
			collapsed: false,
		});
		let payload: QuestionAnswerPayload[] | undefined;
		const respond = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, error: "offline" })
			.mockResolvedValueOnce({ ok: true });
		const answer = (id: string, answers: QuestionAnswerPayload[]) => {
			payload = answers;
			void controller.submit({
				requestId: id,
				sessionId: "one",
				respond: () => respond(answers),
				confirmed: vi.fn(),
			});
		};
		await render(
			<QuestionDock requests={[question]} activeRequest={question} onAnswer={answer}>
				<div />
			</QuestionDock>,
		);
		await choose("甲");
		await click(t("question.next"));
		await choose("一");
		await choose("二");
		await click(t("question.submit"));
		expect(container.textContent).toContain("offline");
		expect(container.querySelector('[aria-label="一"]')?.getAttribute("aria-checked")).toBe("true");
		expect(container.querySelector("textarea")?.value).toBe("保留备注");
		expect(payload?.[0].selectedLabels).toEqual(["甲"]);
		expect(payload?.[1].selectedLabels).toEqual(["一", "二"]);
		await click("原样重试");
		expect(respond.mock.calls[1][0]).toEqual(respond.mock.calls[0][0]);
	});

	it("restores independent request drafts across active conversation switches and complete view unmounts", async () => {
		const second = { ...question, requestId: "second", sessionId: "two" };
		const view = (active: QuestionRequest, requests: QuestionRequest[] = [question, second]) => (
			<QuestionDock requests={requests} activeRequest={active} onAnswer={() => {}}>
				<div />
			</QuestionDock>
		);
		await render(view(question));
		await choose("甲");
		await render(view(second));
		const secondColumn = container.querySelector<HTMLElement>(".owl-question-anchor__column:not([hidden])")!;
		await act(async () => secondColumn.querySelector<HTMLElement>('[aria-label="乙"]')!.click());
		await render(null);
		await render(view(question, [question]));
		expect(container.querySelector('[aria-label="甲"]')?.getAttribute("aria-checked")).toBe("true");
		await render(view(second, [second]));
		expect(container.querySelector('[aria-label="乙"]')?.getAttribute("aria-checked")).toBe("true");
	});

	it("offers reopening approval details from the island with the actual command and project visible", async () => {
		const openDetails = vi.fn();
		const allow = vi.fn();
		await render(
			<DynamicIsland
				running={[
					{
						id: "background",
						title: "B接口修复",
						step: "bash",
						startedAt: 1,
						lastActivityAt: 1,
						waiting: true,
						waitKind: "permission",
						whisper: "",
					},
				]}
				notice={null}
				titleOf={() => "B接口修复"}
				onOpen={() => {}}
				permissionFor={() => ({
					requestId: "permission",
					toolName: "bash",
					description: "git diff -- src/example.ts",
					contextLabel: "B接口修复",
					workspace: "D:/beta",
				})}
				onOpenPermission={openDetails}
				onPermission={allow}
			/>,
		);
		expect(container.textContent).toContain("git diff -- src/example.ts");
		expect(container.textContent).toContain("D:/beta");
		await click("查看详情");
		expect(openDetails).toHaveBeenCalledWith("permission");
		await click("允许此操作");
		expect(allow).toHaveBeenCalledWith("permission", true);
	});
});
