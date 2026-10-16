import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../bridge/protocol.ts";
import { PendingResponses, PendingResponsesContext } from "../bridge/pending-responses.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { PermissionDialog } from "./PermissionDialog.tsx";
import { permissionDialogText as text } from "./permission-dialog-copy.ts";

type Props = Omit<React.ComponentProps<typeof PermissionDialog>, "onDecide">;
type Response = { ok: boolean; error?: string };
let root: Root;
let host: HTMLElement;
let opener: HTMLButtonElement;
let active: Element | null;
let props: Props;
let controller: PendingResponses;
let decisions: ReturnType<typeof vi.fn<(approved: boolean) => void>>;
let respond: ReturnType<typeof vi.fn<(requestId: string, approved: boolean) => Promise<Response>>>;
let confirmed: ReturnType<typeof vi.fn>;
let outerScroll: ReturnType<typeof vi.fn>;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;

const first: PermissionRequest = { type: "permission_request", requestId: "permission-one", sessionId: "conversation-one", toolName: "bash", input: { command: "git diff -- src/main.ts" } };

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	frames = new Map(); frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	active = null;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
	dom.window.HTMLElement.prototype.focus = function (): void { active = this; };
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 600, height: 40, top: 0, left: 0, right: 600, bottom: 40, toJSON: () => ({}) });
	// Linkedom reports -1 even for div[tabindex="0"]; browsers reflect the explicit value.
	Object.defineProperty(dom.window.HTMLElement.prototype, "tabIndex", { configurable: true,
		get() { const value = this.getAttribute("tabindex"); return value === null ? /^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(this.tagName) ? 0 : -1 : Number(value); },
		set(value: number) { this.setAttribute("tabindex", String(value)); },
	});
	Object.defineProperty(dom.window.HTMLElement.prototype, "open", { configurable: true, get() { return this.hasAttribute("open"); }, set(value: boolean) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); } });
	outerScroll = vi.fn(); dom.window.scrollTo = outerScroll;
	controller = new PendingResponses();
	decisions = vi.fn(); respond = vi.fn(async () => ({ ok: true })); confirmed = vi.fn();
	props = { request: first, workspace: "D:/projects/工业平台", contextLabel: "质量接口修复", onLater: vi.fn() };
	setUiLanguage("zh");
	host = dom.document.getElementById("root")!;
	opener = document.createElement("button"); opener.textContent = "原始审批入口";
	document.body.insertBefore(opener, host); opener.focus();
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	controller.invalidate();
	vi.unstubAllGlobals();
});

async function flush(): Promise<void> { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); }); }
async function render(overrides: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...overrides };
	const request = props.request;
	await act(async () => root.render(<PendingResponsesContext.Provider value={controller}><PermissionDialog {...props} onDecide={(approved) => {
		decisions(approved);
		void controller.submit({ requestId: request.requestId, sessionId: request.sessionId, respond: () => respond(request.requestId, approved), confirmed });
	}} /></PendingResponsesContext.Provider>));
	await flush();
}
function dialog(): HTMLElement { return host.querySelector<HTMLElement>(".owl-permission-dialog")!; }
function body(): HTMLElement { return host.querySelector<HTMLElement>(".owl-permission-body")!; }
function source(): HTMLDetailsElement { return host.querySelector<HTMLDetailsElement>(".owl-permission-source")!; }
function button(label: string): HTMLButtonElement {
	const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
	if (!result) throw new Error(`Missing button ${label}`);
	return result;
}
async function click(control: HTMLElement): Promise<void> { await act(async () => control.click()); }
async function key(target: HTMLElement, value: string, shiftKey = false): Promise<Event> {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value }, shiftKey: { value: shiftKey } });
	await act(async () => target.dispatchEvent(event));
	return event;
}

describe("Permission review presentation and original input", () => {
	it("shows the complete command and project clearly without approving or initially focusing Allow", async () => {
		const command = '  cd "D:/projects/超长项目/深层目录"\n' + 'echo "<保留> & 中文引号"\n'.repeat(40) + "COMMAND_TAIL_SENTINEL\n";
		const workspace = "D:/projects/" + "很长的目录/".repeat(12) + "真实项目";
		await render({ request: { ...first, input: { command } }, workspace });
		expect(host.querySelector(".owl-permission-title")?.textContent).toBe("运行 Bash 命令");
		expect(host.querySelector(".owl-permission-input-text")?.textContent).toBe(command);
		expect(host.querySelector(".owl-permission-workspace-name")?.textContent).toBe("真实项目");
		expect(host.querySelector(".owl-permission-workspace-path")?.getAttribute("title")).toBe(workspace);
		expect(host.querySelector(".owl-permission-workspace-path")?.textContent).toBe(workspace);
		expect(source().hasAttribute("open")).toBe(false);
		expect(source().textContent).toContain("conversation-one");
		expect(source().textContent).toContain("质量接口修复");
		expect(source().textContent).toContain("bash");
		expect(body().getAttribute("role")).toBe("region");
		expect(body().getAttribute("tabindex")).toBe("0");
		expect(body().getAttribute("aria-label")).toBe(text("readingRegion"));
		expect(active).toBe(dialog());
		expect(active).not.toBe(button(t("perm.allow")));
		expect(decisions).not.toHaveBeenCalled();
		expect(respond).not.toHaveBeenCalled();
	});

	it.each(["zh", "en"] as const)("keeps unknown JSON and HTML characters literal with unknown workspace in %s", async (language) => {
		setUiLanguage(language);
		const input = { payload: '<script>bad()</script> "引号" & <img src=x onerror=bad()>', path: "D:/" + "long/".repeat(50) + "最后文件.json", nested: { keep: [1, false, "多行\n原文"] } };
		const toolName = 'unknown_tool"><img src=x>';
		await render({ request: { ...first, toolName, input }, workspace: undefined });
		expect(host.querySelector(".owl-permission-title")?.textContent).toBe(text("toolAction", { tool: toolName }));
		expect(host.querySelector(".owl-permission-input-text")?.textContent).toBe(JSON.stringify(input, null, 2));
		expect(host.querySelector(".owl-permission-raw-input")?.textContent).toBe(JSON.stringify(input, null, 2));
		expect(host.querySelector("script, img, [onerror]")).toBeNull();
		expect(host.querySelector(".owl-permission-workspace-name")?.textContent).toBe(language === "en" ? "Project directory unavailable" : "项目目录暂不可用");
		expect(host.querySelector(".owl-permission-workspace-path")).toBeNull();
	});

	it("labels edit text as a preview and makes all long original edits and hidden read fields available", async () => {
		const input = { path: "D:/project/真实文件.ts", edits: [{ oldText: "旧".repeat(400) + "OLD_TAIL_SENTINEL", newText: "新".repeat(500) + "NEW_TAIL_SENTINEL" }], expectedVersion: "retain-this-field" };
		await render({ request: { ...first, toolName: "edit", input } });
		expect(host.querySelector(".owl-permission-title")?.textContent).toBe("编辑 真实文件.ts");
		expect(host.querySelector(".owl-permission-input-label")?.textContent).toBe(text("changePreview"));
		expect(source().querySelector("summary")?.textContent).toBe(text("source"));
		await click(source().querySelector("summary")!);
		source().open = true;
		expect(source().querySelector(".owl-permission-raw-input")?.textContent).toBe(JSON.stringify(input, null, 2));
		expect(source().textContent).toContain("OLD_TAIL_SENTINEL");
		expect(source().textContent).toContain("NEW_TAIL_SENTINEL");
		expect(source().textContent).toContain("retain-this-field");
		const read = { path: "D:/project/真实文件.ts", offset: 83, limit: 16, custom: { preserve: "READ_EXTRA_SENTINEL" } };
		await render({ request: { ...first, requestId: "read-request", toolName: "read", input: read } });
		expect(host.querySelector(".owl-permission-input-text")?.textContent).toBe(read.path);
		expect(host.querySelector(".owl-permission-raw-input")?.textContent).toBe(JSON.stringify(read, null, 2));
		expect(source().hasAttribute("open")).toBe(false);
	});
});

describe("Acknowledged permission decisions", () => {
	it.each([true, false])("submits approved=%s once, keeps static button labels pending and retries the original decision", async (approved) => {
		const pending = Promise.withResolvers<Response>();
		respond.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: true });
		await render();
		const label = t(approved ? "perm.allow" : "perm.deny");
		await act(async () => { const control = button(label); control.click(); control.click(); });
		expect(decisions).toHaveBeenCalledExactlyOnceWith(approved);
		expect(respond).toHaveBeenCalledExactlyOnceWith("permission-one", approved);
		expect(button(t("perm.allow")).disabled).toBe(true);
		expect(button(t("perm.deny")).disabled).toBe(true);
		expect(active).toBe(body());
		expect(button(t("perm.allow")).textContent).toBe(t("perm.allow"));
		expect(button(t("perm.deny")).textContent).toBe(t("perm.deny"));
		expect(host.querySelector('.owl-pending-feedback[role="status"]')?.textContent).toContain("等待提交确认");
		await act(async () => pending.resolve({ ok: false, error: "拒绝不是允许：Host retained request" }));
		await flush();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Host retained request");
		expect(host.querySelector(".owl-permission-raw-input")?.textContent).toBe(JSON.stringify(first.input, null, 2));
		expect(confirmed).not.toHaveBeenCalled();
		await click(button("原样重试"));
		expect(respond.mock.calls).toEqual([["permission-one", approved], ["permission-one", approved]]);
		expect(confirmed).toHaveBeenCalledOnce();
		expect(decisions).toHaveBeenCalledOnce();
	});

	it("uses Later and Escape only to defer, never as an allow or deny response", async () => {
		await render();
		await click(button("稍后处理"));
		const escape = await key(body(), "Escape");
		expect(escape.defaultPrevented).toBe(true);
		expect(props.onLater).toHaveBeenCalledTimes(2);
		expect(decisions).not.toHaveBeenCalled();
		expect(respond).not.toHaveBeenCalled();
	});

	it("keeps new pending/error notices visible by scrolling only the dialog body and preserves the long original input", async () => {
		const pending = Promise.withResolvers<Response>();
		respond.mockReturnValueOnce(pending.promise);
		const command = "echo original-line\n".repeat(200) + "COMPLETE_COMMAND_TAIL";
		await render({ request: { ...first, input: { command } } });
		const scroller = body(); const footer = host.querySelector(".owl-permission-foot")!;
		scroller.scrollTop = 900;
		await click(button(t("perm.deny"))); await flush();
		expect(scroller.scrollTop).toBe(0);
		expect(scroller.firstElementChild?.classList.contains("owl-pending-feedback")).toBe(true);
		scroller.scrollTop = 700;
		await render();
		expect(scroller.scrollTop).toBe(700);
		const error = "very-long-error <not-html>\n".repeat(120) + "ERROR_TAIL_SENTINEL";
		await act(async () => pending.resolve({ ok: false, error })); await flush();
		expect(scroller.scrollTop).toBe(0);
		expect(scroller.firstElementChild?.getAttribute("role")).toBe("alert");
		expect(scroller.querySelector('[role="alert"]')?.textContent).toContain(error);
		expect(host.querySelector(".owl-permission-input-text")?.textContent).toBe(command);
		expect(host.querySelector(".owl-permission-foot")).toBe(footer);
		expect(scroller.contains(footer)).toBe(false);
		expect(footer.querySelector(".owl-pending-feedback")).toBeNull();
		expect(outerScroll).not.toHaveBeenCalled();
	});
});

describe("Permission focus and request ownership", () => {
	it("traps Tab and Shift+Tab around body, native summary and footer while keeping the initial focus neutral", async () => {
		await render();
		const region = body(); const summary = source().querySelector<HTMLElement>("summary")!;
		const allow = button(t("perm.allow"));
		expect(active).toBe(dialog());
		const backwards = await key(dialog(), "Tab", true);
		expect(backwards.defaultPrevented).toBe(true);
		expect(active).toBe(allow);
		const forwards = await key(allow, "Tab");
		expect(forwards.defaultPrevented).toBe(true);
		expect(active).toBe(region);
		region.focus();
		expect((await key(region, "Tab")).defaultPrevented).toBe(false);
		summary.focus();
		expect((await key(summary, "Tab")).defaultPrevented).toBe(false);
		region.focus();
		expect((await key(region, "Tab", true)).defaultPrevented).toBe(true);
		expect(active).toBe(allow);
		expect(decisions).not.toHaveBeenCalled();
	});

	it("does not capture collapsed detail controls and includes them once native details opens", async () => {
		const pending = Promise.withResolvers<Response>(); respond.mockReturnValueOnce(pending.promise);
		await render({ onLater: undefined });
		await click(button(t("perm.deny")));
		const detailControl = document.createElement("button"); detailControl.textContent = "详情中的控件"; source().append(detailControl);
		const summary = source().querySelector<HTMLElement>("summary")!;
		summary.focus();
		expect((await key(summary, "Tab")).defaultPrevented).toBe(true);
		expect(active).toBe(body());
		source().open = true;
		detailControl.focus();
		expect((await key(detailControl, "Tab")).defaultPrevented).toBe(true);
		expect(active).toBe(body());
		body().focus();
		expect((await key(body(), "Tab", true)).defaultPrevented).toBe(true);
		expect(active).toBe(detailControl);
		await act(async () => pending.resolve({ ok: true }));
	});

	it("resets reading state for a new request, ignores old request feedback and restores the original opener on final unmount", async () => {
		const pending = Promise.withResolvers<Response>(); respond.mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true });
		await render();
		await click(button(t("perm.deny")));
		body().scrollTop = 400; source().open = true;
		const next: PermissionRequest = { ...first, requestId: "permission-two", sessionId: "conversation-two", toolName: "read", input: { path: "D:/other/第二份材料.md", offset: 9 } };
		await render({ request: next, workspace: "D:/other" });
		expect(body().scrollTop).toBe(0);
		expect(source().hasAttribute("open")).toBe(false);
		expect(active).toBe(dialog());
		expect(host.querySelector(".owl-permission-title")?.textContent).toBe("读取 第二份材料.md");
		expect(host.querySelector(".owl-permission-raw-input")?.textContent).toBe(JSON.stringify(next.input, null, 2));
		await act(async () => pending.resolve({ ok: false, error: "OLD_REQUEST_ERROR" }));
		expect(host.querySelector('[role="alert"]')).toBeNull();
		expect(button(t("perm.allow")).disabled).toBe(false);
		await click(button(t("perm.allow")));
		expect(respond.mock.calls).toEqual([["permission-one", false], ["permission-two", true]]);
		await act(async () => root.render(null));
		expect(active).toBe(opener);
	});
});
