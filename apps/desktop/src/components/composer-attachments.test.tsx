import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { Composer } from "./Composer.tsx";

vi.mock("../bridge/native.ts", () => ({ listenForOsFileDrop: async () => () => {}, readLocalImage: async () => undefined }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null }));

type Props = React.ComponentProps<typeof Composer>;
type Metadata = { ok: boolean; result?: { isFile: boolean; isDirectory: boolean }; error?: string };
let root: Root;
let container: HTMLElement;
let props: Props;
let request: ReturnType<typeof vi.fn<(payload: { type: string; path?: string }) => Promise<Metadata>>>;
const image = { type: "image" as const, mimeType: "image/png", data: "retained-image" };

beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll("\\", "\\\\") });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	dom.window.getSelection = () => null;
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!; root = createRoot(container);
	request = vi.fn(async () => ({ ok: true, result: { isFile: true, isDirectory: false } }));
	props = { client: { request: (payload: { type: string; path?: string }) => payload.type === "session.queue.returned.list" ? Promise.resolve({ ok: true, result: { receipts: [] } }) : request(payload) } as unknown as BridgeClient, connected: true, disabled: false, running: false, hideEnvironment: true, hideMascot: true, onSend: vi.fn(() => false), onAbort: vi.fn(), providers: [], model: "fixture/model", onModel: vi.fn(), thinkingLevel: "high", onThinkingLevel: vi.fn(), approvalMode: "confirm", onApprovalMode: vi.fn(), workspaceDir: "D:/project", queueProfile: "profile-a", queueSessionId: "session-a", projects: [], onSwitchProject: vi.fn(), commands: [], searchFiles: async () => [], draftRequest: { id: 1, text: "核对截图与文件", images: [image], attachedPaths: ["D:/project/valid.md", "D:/project/missing.md"], replace: true } };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render(patch: Partial<Props> = {}): Promise<void> { props = { ...props, ...patch }; await act(async () => root.render(<Composer {...props} />)); }
function button(label: string): HTMLButtonElement { const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); if (!result) throw new Error(`Missing button ${label}`); return result; }
async function click(label: string): Promise<void> { await act(async () => button(label).click()); }
const editor = (): HTMLElement => container.querySelector<HTMLElement>('[role="textbox"]')!;

describe("Composer attachment accessibility preflight", () => {
	it("retains the complete input on a missing file and removes only the chosen bad reference", async () => {
		request.mockImplementation(async (payload) => payload.path === "missing.md" ? { ok: false, error: "ENOENT: no such file" } : { ok: true, result: { isFile: true, isDirectory: false } });
		await render(); await click(t("composer.send"));
		expect(props.onSend).not.toHaveBeenCalled(); expect(editor().textContent).toBe("核对截图与文件");
		expect(container.querySelector('img[src="data:image/png;base64,retained-image"]')).not.toBeNull();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("已不存在");
		await click("移除此引用"); await click(t("composer.send"));
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("核对截图与文件", [image], ["D:/project/valid.md"], undefined);
	});

	it("does not send the old snapshot if the user edits while metadata is pending", async () => {
		const metadata = Promise.withResolvers<Metadata>(); request.mockReturnValue(metadata.promise);
		await render(); await click(t("composer.send")); expect(props.onSend).not.toHaveBeenCalled();
		expect(container.querySelector('[aria-busy="true"]')?.textContent).toContain("检查文件引用");
		await act(async () => { editor().textContent = "后续手改指令"; editor().dispatchEvent(new window.Event("input", { bubbles: true })); metadata.resolve({ ok: true, result: { isFile: true, isDirectory: false } }); });
		expect(props.onSend).not.toHaveBeenCalled(); expect(editor().textContent).toBe("后续手改指令");
	});

	it("checks repaired references again without automatically sending the preserved draft", async () => {
		request.mockResolvedValue({ ok: false, error: "EACCES: permission denied" });
		await render(); await click(t("composer.send")); expect(container.textContent).toContain("无法访问此文件");
		request.mockResolvedValue({ ok: true, result: { isFile: true, isDirectory: false } });
		await click("重新检查"); expect(props.onSend).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).toBeNull();
		await click(t("composer.send")); expect(props.onSend).toHaveBeenCalledOnce();
	});

	it("ignores an old check after changing conversation, profile or project", async () => {
		const metadata = Promise.withResolvers<Metadata>(); request.mockReturnValue(metadata.promise);
		await render(); await click(t("composer.send"));
		await render({ queueSessionId: "session-b", queueProfile: "profile-b", workspaceDir: "D:/other" });
		await act(async () => metadata.resolve({ ok: true, result: { isFile: true, isDirectory: false } }));
		expect(props.onSend).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("checks attachments for queued input and keeps pause available during the check", async () => {
		const metadata = Promise.withResolvers<Metadata>(); request.mockReturnValue(metadata.promise); const onPause = vi.fn();
		await render({ running: true, onPause }); await click(t("composer.sendNextTurn"));
		expect(button(t("composer.pause")).disabled).toBe(false); await click(t("composer.pause")); expect(onPause).toHaveBeenCalledOnce();
		await act(async () => metadata.resolve({ ok: true, result: { isFile: true, isDirectory: false } }));
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("核对截图与文件", [image], ["D:/project/valid.md", "D:/project/missing.md"], "queue");
	});

	it("does not submit a completed check after navigation starts before React commits", async () => {
		let current = true;
		const metadata = Promise.withResolvers<Metadata>(); request.mockReturnValue(metadata.promise);
		await render({ queueIsCurrent: () => current }); await click(t("composer.send"));
		await act(async () => { current = false; metadata.resolve({ ok: true, result: { isFile: true, isDirectory: false } }); });
		expect(props.onSend).not.toHaveBeenCalled(); expect(editor().textContent).toBe("核对截图与文件");
	});
});
