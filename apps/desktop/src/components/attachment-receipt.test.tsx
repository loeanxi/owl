import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../bridge/client.ts";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { AttachmentReceipt } from "./AttachmentReceipt.tsx";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));
let container: HTMLElement;
let root: Root;
let client: BridgeClient;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Event", dom.window.Event); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	frames = new Map(); sequence = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id; }); vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	container = document.getElementById("root")!; root = createRoot(container); client = new BridgeClient("ws://attachment.test");
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function button(text: string): HTMLButtonElement { const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text); if (!result) throw new Error(`Missing ${text}: ${container.textContent}`); return result; }
async function click(text: string): Promise<void> { await act(async () => button(text).click()); }
async function render(node: React.ReactNode): Promise<void> { await act(async () => root.render(node)); }
async function flush(): Promise<void> { await act(async () => { const current = [...frames.values()]; frames.clear(); current.forEach((callback) => callback(0)); }); }
const receipt = { path: "a.ts", status: "referenced" as const, evidence: [] };

describe("attachment receipt actions", () => {
	it("shows path-only references honestly, checks metadata, retains open errors and retries without changing read status", async () => {
		const request = vi.spyOn(client, "request").mockResolvedValueOnce({ ok: false, error: "ENOENT: missing" }).mockResolvedValue({ ok: true, result: { isFile: true } });
		const open = vi.fn(); await render(<AttachmentReceipt receipt={receipt} cwd="D:/project" client={client} onOpenFile={open} />);
		await click("a.ts已引用"); expect(container.textContent).toContain("附带路径不代表正文已读取");
		await click("打开附件"); expect(container.querySelector('[role="alert"]')?.textContent).toContain("ENOENT"); expect(open).not.toHaveBeenCalled();
		await click("重试打开"); expect(open).toHaveBeenCalledExactlyOnceWith("a.ts"); expect(request).toHaveBeenCalledWith({ type: "fs.stat", cwd: "D:/project", path: "a.ts" }); expect(container.querySelector('[data-read-status="referenced"]')).not.toBeNull();
	});
	it("opens explicit external attachments through metadata and acknowledged system-open requests", async () => {
		const request = vi.spyOn(client, "request").mockResolvedValueOnce({ ok: true, result: { isFile: true } }).mockResolvedValueOnce({ ok: false, error: "system app failed" });
		await render(<AttachmentReceipt receipt={{ ...receipt, path: "D:/outside/report.pdf" }} cwd="D:/project" client={client} />);
		await click("report.pdf已引用"); await click("打开附件");
		expect(request).toHaveBeenNthCalledWith(1, { type: "fs.stat", cwd: "D:/outside", path: "report.pdf" }); expect(request).toHaveBeenNthCalledWith(2, { type: "open.external", action: "url", target: "file:///D:/outside/report.pdf" }); expect(container.querySelector('[role="alert"]')?.textContent).toContain("system app failed");
	});
	it("ignores old file acknowledgements after session changes while allowing a new open attempt", async () => {
		const pending = Promise.withResolvers<{ ok: boolean; result?: unknown }>(); const request = vi.spyOn(client, "request").mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true, result: { isFile: true } }); const open = vi.fn();
		const view = (sessionId: string) => <AttachmentReceipt receipt={receipt} cwd="D:/project" sessionId={sessionId} client={client} onOpenFile={open} />;
		await render(view("one")); await click("a.ts已引用"); await act(async () => { const action = button("打开附件"); action.click(); action.click(); }); expect(request).toHaveBeenCalledOnce();
		await render(view("two")); await click("打开附件"); expect(open).toHaveBeenCalledOnce();
		await act(async () => pending.resolve({ ok: false, result: undefined })); expect(open).toHaveBeenCalledOnce(); expect(container.querySelector('[role="alert"]')).toBeNull();
	});
});

describe("real ChatStream read-record navigation", () => {
	it("uses the producing assistant as well as tool ID when providers reuse call IDs across turns", async () => {
		const tool = (text: string): ToolCard => ({ id: "reused-call", name: "read", args: JSON.stringify({ path: "a.ts" }), summary: "读取a.ts", status: "ok", output: { text, totalLines: 1 } });
		const entries: ChatEntry[] = [{ kind: "user", text: "上一轮", attachedPaths: ["a.ts"] }, { kind: "assistant", text: "旧回答", thinking: "", tools: [tool("OLD BODY")] }, { kind: "user", text: "当前轮", attachedPaths: ["a.ts"] }, { kind: "assistant", text: "当前回答", thinking: "", tools: [tool("NEW BODY")] }];
		await render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />);
		const surface = container.querySelector<HTMLElement>(".owl-chat-scroll")!; Object.defineProperties(surface, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } }); surface.scrollTop = 0; surface.scrollTo = vi.fn(); surface.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
		const latest = [...container.querySelectorAll<HTMLElement>(".owl-attachment-receipt")].at(-1)!;
		await act(async () => latest.querySelector<HTMLButtonElement>("button")!.click());
		await act(async () => [...latest.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("查看读取记录"))!.click());
		await flush(); await flush();
		const target = container.querySelector<HTMLElement>('[data-attachment-target="true"]'); expect(target?.dataset.toolOwner).toBe("3"); expect(target?.textContent).toContain("NEW BODY"); expect(container.textContent).not.toContain("OLD BODY");
	});
	it("expands the exact historical read tool without marking the next turn's same-path reference read", async () => {
		const read: ToolCard = { id: "historical-read", name: "read", args: JSON.stringify({ path: "a.ts", offset: 10, limit: 2 }), summary: "读取a.ts", status: "ok", output: { text: "line10\nline11\n\n[9 more lines in file. Use offset=12 to continue.]", totalLines: 4 } };
		const entries: ChatEntry[] = [{ kind: "user", entryId: "old-user", text: "读材料", attachedPaths: ["a.ts"] }, { kind: "assistant", text: "第一轮完成", thinking: "", tools: [read, { ...read, id: "other-read", args: JSON.stringify({ path: "b.ts" }), summary: "读取b.ts" }] }, { kind: "user", entryId: "new-user", text: "只引用", attachedPaths: ["a.ts"] }, { kind: "assistant", text: "当前回复", thinking: "", tools: [] }];
		await render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />);
		const surface = container.querySelector<HTMLElement>(".owl-chat-scroll")!; Object.defineProperties(surface, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } }); surface.scrollTop = 0; surface.getBoundingClientRect = () => ({ top: 0 } as DOMRect); surface.scrollTo = vi.fn();
		expect(container.querySelectorAll('[data-read-status="partial"]')).toHaveLength(1); expect(container.querySelectorAll('[data-read-status="referenced"]')).toHaveLength(1);
		await click("a.ts部分内容"); expect(container.textContent).toContain("10–11"); await click("查看读取记录 · read");
		await flush(); await flush();
		const target = container.querySelector('[data-tool-id="historical-read"]'); expect(target).not.toBeNull(); expect(target?.querySelector('[aria-expanded="true"]')).not.toBeNull(); expect(target?.textContent).toContain("line10"); expect(target?.getAttribute("data-attachment-target")).toBe("true"); expect(surface.scrollTo).toHaveBeenCalledOnce();
		expect(container.querySelectorAll('[data-read-status="referenced"]')).toHaveLength(1);
	});
});
