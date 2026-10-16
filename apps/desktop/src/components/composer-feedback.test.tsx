import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderModelsMessage } from "../bridge/protocol.ts";
import type { AttachmentIssue } from "../hooks/attachment-preflight.ts";
import type { ModelSelectionFeedback } from "../hooks/use-model-selection.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { AttachmentPreflightNotice } from "./AttachmentPreflightNotice.tsx";
import { ModelSelectionNotice } from "./ModelSelectionNotice.tsx";

const providers: ProviderModelsMessage[] = [{ id: "fixture", models: [{ id: "new", name: "New model", contextWindow: 200000, input: ["text", "image"] }, { id: "old", name: "Previous model" }] }];
const feedback: ModelSelectionFeedback = { status: "pending", target: "fixture/new", actual: "fixture/old", running: true };
let root: Root;
let container: HTMLElement;

beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(children: React.ReactNode): Promise<void> {
	await act(async () => root.render(<div className="owl-composer-feedback">{children}</div>));
}

describe("compact composer feedback", () => {
	it("leaves no notice content when there is no model feedback or attachment issue", async () => {
		await render(<><ModelSelectionNotice providers={providers} /><AttachmentPreflightNotice checking={false} issues={[]} onRemove={vi.fn()} onRetry={vi.fn()} /></>);
		expect(container.querySelector(".owl-composer-feedback")?.childElementCount).toBe(0);
		expect(container.querySelector("[role]")).toBeNull();
	});

	it("keeps a concrete model error beside retry and preserves its complete safe text in native details", async () => {
		const onRetry = vi.fn();
		const error = `No API key for the selected provider\n${"详细诊断 <script>bad()</script> & \"quoted\" ".repeat(12)}\nMODEL_ERROR_TAIL`;
		await render(<ModelSelectionNotice feedback={{ ...feedback, status: "error", error }} providers={providers} onRetry={onRetry} />);
		const notice = container.querySelector('[role="alert"]')!;
		const head = notice.querySelector(".owl-composer-notice-head")!;
		expect(head.textContent).toContain("No API key");
		expect(head.textContent).not.toContain("MODEL_ERROR_TAIL");
		const details = notice.querySelector("details")!;
		expect(details.hasAttribute("open")).toBe(false);
		expect(details.querySelector("summary")?.textContent).toBe("模型详情");
		expect(details.querySelector("pre")?.textContent).toBe(error);
		expect(details.textContent).toContain("本次选择：fixture/new");
		expect(details.textContent).toContain("上次确认的模型：fixture/old");
		expect(details.textContent).toContain("已发出的请求不会重启");
		expect(notice.querySelector("script")).toBeNull();
		await act(async () => head.querySelector<HTMLButtonElement>("button")!.click());
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it("shows the pending target while retaining the confirmed actual model and busy semantics", async () => {
		await render(<ModelSelectionNotice feedback={feedback} providers={providers} onRetry={vi.fn()} />);
		const notice = container.querySelector('[role="status"]')!;
		expect(notice.getAttribute("aria-busy")).toBe("true");
		expect(notice.querySelector(".owl-composer-notice-head")?.textContent).toContain("正在确认切换为 New model");
		expect(notice.textContent).toContain("上次确认的模型：fixture/old");
		expect(notice.textContent).toContain("200,000");
		expect(notice.textContent).toContain("支持图片");
		expect(notice.querySelector("button")).toBeNull();
	});

	it("keeps a new-task selection distinct from a confirmed active-session model", async () => {
		await render(<ModelSelectionNotice feedback={{ ...feedback, status: "selected", actual: "fixture/new", running: false }} providers={providers} />);
		expect(container.querySelector(".owl-composer-notice-head")?.textContent).toContain("已为新任务选择 New model，创建会话时应用");
		expect(container.textContent).not.toContain("会话已确认");
		expect(container.textContent).not.toContain("后续请求使用已确认");
		expect(container.textContent).toContain("fixture/new");
		await render(<ModelSelectionNotice feedback={{ ...feedback, status: "confirmed", target: "fixture/new", actual: "fixture/old", running: false }} providers={providers} />);
		expect(container.querySelector(".owl-composer-notice-head")?.textContent).toContain("会话已确认选择 Previous model");
		expect(container.textContent).toContain("本次选择：fixture/new");
		expect(container.textContent).toContain("会话已确认选择 fixture/old");
	});

	it("puts a single file name and reason directly beside exact remove and retry actions", async () => {
		const onRemove = vi.fn();
		const onRetry = vi.fn();
		const issue = { path: "D:\\项目\\很长的完整目录\\<note>&报告.txt", reason: "无法访问此文件，请检查权限或重新选择" };
		await render(<AttachmentPreflightNotice checking={false} issues={[issue]} onRemove={onRemove} onRetry={onRetry} />);
		const notice = container.querySelector('[role="alert"]')!;
		const head = notice.querySelector(".owl-composer-notice-head")!;
		expect(head.textContent).toContain("<note>&报告.txt");
		expect(head.textContent).toContain(issue.reason);
		const details = notice.querySelector("details")!;
		expect(details.hasAttribute("open")).toBe(false);
		expect(details.querySelector("code")?.textContent).toBe(issue.path);
		expect(details.textContent).toContain("输入已保留");
		expect(details.textContent).toContain("此检查只确认文件能否访问");
		expect(notice.querySelector("note")).toBeNull();
		const actions = head.querySelectorAll<HTMLButtonElement>("button");
		await act(async () => { actions[0]!.click(); actions[1]!.click(); });
		expect(onRemove).toHaveBeenCalledExactlyOnceWith(issue.path);
		expect(onRetry).toHaveBeenCalledOnce();
		expect(notice.querySelectorAll("button")).toHaveLength(2);
	});

	it("counts multiple blockers and retains every full path, reason and per-file removal in details", async () => {
		const onRemove = vi.fn();
		const issues: AttachmentIssue[] = [
			{ path: "D:/project/one.txt", reason: "文件已不存在" },
			{ path: `D:/project/${"长路径/".repeat(30)}two.txt`, reason: `EACCES: ${"原始错误\n".repeat(70)}ATTACHMENT_REASON_TAIL` },
			{ path: "//server/share/three.txt", reason: "权限被拒绝" },
		];
		await render(<AttachmentPreflightNotice checking={false} issues={issues} onRemove={onRemove} onRetry={vi.fn()} />);
		const head = container.querySelector(".owl-composer-notice-head")!;
		expect(head.textContent).toContain("3 个文件引用暂时无法访问");
		expect(head.textContent).toContain("one.txt: 文件已不存在");
		expect(head.querySelectorAll("button")).toHaveLength(1);
		const details = container.querySelector("details")!;
		expect(details.hasAttribute("open")).toBe(false);
		const rows = details.querySelectorAll("li");
		expect(rows).toHaveLength(3);
		for (const [index, issue] of issues.entries()) {
			expect(rows[index]!.querySelector("code")?.textContent).toBe(issue.path);
			expect(rows[index]!.querySelector("p")?.textContent).toBe(issue.reason);
		}
		await act(async () => rows[1]!.querySelector<HTMLButtonElement>("button")!.click());
		expect(onRemove).toHaveBeenCalledExactlyOnceWith(issues[1]!.path);
		expect(rows[1]!.querySelector("button")?.getAttribute("aria-label")).toContain("two.txt");
	});

	it("retains prior attachment blockers while checking and disables retry and every removal", async () => {
		const onRemove = vi.fn();
		const onRetry = vi.fn();
		const issues = [{ path: "D:/one.txt", reason: "无法访问" }, { path: "D:/two.txt", reason: "文件不存在" }];
		await render(<AttachmentPreflightNotice checking={true} issues={issues} onRemove={onRemove} onRetry={onRetry} />);
		const notice = container.querySelector('[role="status"]')!;
		expect(notice.getAttribute("aria-busy")).toBe("true");
		expect(notice.querySelector(".owl-composer-notice-head")?.textContent).toContain("正在检查文件引用");
		expect(notice.textContent).toContain("待复核 2 个文件引用");
		for (const button of notice.querySelectorAll<HTMLButtonElement>("button")) {
			expect(button.disabled).toBe(true);
			await act(async () => button.click());
		}
		expect(onRemove).not.toHaveBeenCalled();
		expect(onRetry).not.toHaveBeenCalled();
		await render(<AttachmentPreflightNotice checking={true} issues={[]} onRemove={onRemove} onRetry={onRetry} />);
		expect(container.querySelector("[role=status]")?.textContent).toBe("正在检查文件引用…");
		expect(container.querySelector("details, button")).toBeNull();
	});

	it("updates both notices to English without losing model-selection or attachment details", async () => {
		const renderNotices = (): React.JSX.Element => <><ModelSelectionNotice feedback={{ ...feedback, status: "selected", actual: "fixture/new" }} providers={providers} /><AttachmentPreflightNotice checking={false} issues={[{ path: "D:/one.txt", reason: "EACCES" }, { path: "D:/two.txt", reason: "ENOENT" }]} onRemove={vi.fn()} onRetry={vi.fn()} /></>;
		await render(renderNotices());
		await act(async () => setUiLanguage("en"));
		expect(container.textContent).toContain("Applied when its session is created");
		expect(container.textContent).toContain("Model details");
		expect(container.textContent).toContain("2 file references are unavailable");
		expect(container.textContent).toContain("File details (2)");
		expect(container.textContent).toContain("Check again");
		expect(container.textContent).toContain("D:/two.txt");
		expect(container.textContent).not.toContain("Session model selection confirmed");
	});
});
