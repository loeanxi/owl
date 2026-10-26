import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { chatToolText } from "./chat-tool-copy.ts";
import { Composer } from "./Composer.tsx";

vi.mock("../bridge/native.ts", () => ({ listenForOsFileDrop: async () => () => {}, readLocalImage: async () => undefined }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let root: Root;
let container: HTMLElement;
let requests: { type: string; values?: unknown }[];

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll("\\", "\\\\") });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	dom.window.getSelection = () => null;
	setUiLanguage("zh");
	requests = [];
	container = dom.document.getElementById("root")!; root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const editor = (): HTMLElement => container.querySelector<HTMLElement>('[role="textbox"]')!;

describe("rich paste downgrade", () => {
	function renderComposer(): Promise<void> {
		const client = { request: (payload: { type: string; values?: unknown }) => { requests.push(payload); return Promise.resolve({ ok: true, result: {} }); } } as unknown as BridgeClient;
		return act(async () => root.render(<Composer client={client} connected disabled={false} running={false} hideEnvironment hideMascot onSend={() => false} onAbort={() => {}} providers={[]} model="m" onModel={() => {}} thinkingLevel="high" onThinkingLevel={() => {}} approvalMode="confirm" onApprovalMode={() => {}} workspaceDir="D:/p" queueProfile="p" queueSessionId="s" projects={[]} onSwitchProject={() => {}} commands={[]} searchFiles={async () => []} />)) as unknown as Promise<void>;
	}
	function pasteEvent(html: string, plain: string): Event {
		const event = new window.Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperties(event, { clipboardData: { value: { getData: (type: string) => (type === "text/html" ? html : type === "text/plain" ? plain : ""), items: [] } } });
		return event;
	}

	it("inserts the plain-text variant instead of styled markup", async () => {
		await renderComposer();
		await act(async () => editor().dispatchEvent(pasteEvent('<span style="color:red">有 <b>格式</b> 的一句</span>', "有 格式 的一句")));
		expect(editor().textContent).toBe("有 格式 的一句");
		// 默认行为被拦下：编辑器里没有出现任何元素节点。
		expect(editor().querySelector("span, b")).toBeNull();
	});

	it("leaves plain-only or identical pastes to the browser", async () => {
		await renderComposer();
		const before = editor().textContent;
		await act(async () => editor().dispatchEvent(pasteEvent("", "纯文本粘贴")));
		// 未 preventDefault：linkedom 里编辑器内容不变（默认插入不发生），也不抛错。
		expect(editor().textContent).toBe(before);
	});
});

describe("tool records in-place toggle copy", () => {
	it("pairs expand and collapse labels", () => {
		expect(chatToolText("expandRecords")).toBe("展开工具记录");
		expect(chatToolText("collapseRecords")).toBe("收起工具记录");
	});
});
