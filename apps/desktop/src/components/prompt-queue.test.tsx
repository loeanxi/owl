import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionQueueInput, SessionQueueItem, SessionQueueReturnedInput, SessionQueueReturnedSummary, SessionQueueSnapshot } from "../bridge/protocol.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { Composer } from "./Composer.tsx";
import { promptQueueText as text } from "./prompt-queue-copy.ts";

vi.mock("../bridge/native.ts", () => ({ listenForOsFileDrop: async () => () => {}, readLocalImage: async () => undefined }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null }));
type Props = React.ComponentProps<typeof Composer>;
type Response = { ok: boolean; result?: unknown; error?: string };
const empty: SessionQueueSnapshot = { steering: [], followUp: [] };
const image = { type: "image" as const, data: "cXVldWVkLWltYWdl", mimeType: "image/png" };
const fullText = "[Attached files for this turn]\n- user literal\n\n保留这段用户原文\n";
const input: SessionQueueInput = { messageId: "message-one", text: fullText, images: [image], attachedPaths: ["notes/reference.md"], state: "queued" };
const item: SessionQueueItem = { messageId: input.messageId, text: "保留这段…", textTruncated: true, imageCount: 1, attachedPaths: input.attachedPaths, state: "queued" };
let root: Root;
let container: HTMLElement;
let props: Props;
let receipts: SessionQueueReturnedInput[];
let request = vi.fn(async (_request: Record<string, unknown>): Promise<Response> => ({ ok: true }));
function summary(receipt: SessionQueueReturnedInput): SessionQueueReturnedSummary {
	return { receiptId: receipt.receiptId, sourceSessionId: receipt.sourceSessionId, sourceCwd: receipt.sourceCwd, createdAt: receipt.createdAt, messageId: receipt.input.messageId, text: receipt.input.text, textTruncated: false, imageCount: receipt.input.images.length, attachedPaths: receipt.input.attachedPaths };
}
function returned(receiptId = "receipt-one"): SessionQueueReturnedInput { return { receiptId, sourceSessionId: "session-one", sourceCwd: "D:/source-project", createdAt: 1, input }; }

beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Node", dom.window.Node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("CSS", { escape: (value: string) => value });
	dom.window.getSelection = () => null;
	setUiLanguage("zh"); receipts = [];
	container = dom.document.getElementById("root")!; root = createRoot(container);
	request = vi.fn(async (payload: Record<string, unknown>): Promise<Response> => {
		switch (payload.type) {
			case "session.queue.returned.list": return { ok: true, result: { receipts: receipts.map(summary) } };
			case "session.queue.returned.get": return { ok: true, result: { receipt: receipts.find((receipt) => receipt.receiptId === payload.receiptId) } };
			case "session.queue.get": return { ok: true, result: { input, queue: props.queued } };
			case "session.queue.remove": case "session.queue.promote": return { ok: true, result: { queue: empty } };
			case "session.queue.take": {
				const receipt = returned(String(payload.operationId)); receipts.push(receipt);
				return { ok: true, result: { receipt, queue: empty } };
			}
			case "session.queue.returned.remove": receipts = receipts.filter((receipt) => receipt.receiptId !== payload.receiptId); return { ok: true, result: { receipts: receipts.map(summary) } };
			case "fs.stat": return { ok: true, result: { isFile: true, isDirectory: false, size: 1 } };
			default: return { ok: false, error: "unknown request" };
		}
	});
	props = {
		client: { request, onStatus: () => () => {} } as unknown as BridgeClient, connected: true, disabled: false, running: true, hideEnvironment: true, hideMascot: true,
		onSend: vi.fn(() => false), onAbort: vi.fn(), onPause: vi.fn(), providers: [], model: "fixture/model", onModel: vi.fn(), thinkingLevel: "high", onThinkingLevel: vi.fn(), approvalMode: "confirm", onApprovalMode: vi.fn(), sessionInfo: undefined,
		workspaceDir: "D:/current-project", projects: [], onSwitchProject: vi.fn(), commands: [], searchFiles: async () => [],
		queueProfile: "D:/profile-one", queueSessionId: "session-one", queued: { steering: [], followUp: [item] },
		onQueueChange: vi.fn((queue) => { props = { ...props, queued: queue }; root.render(<Composer {...props} />); }),
	};
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
async function render(patch: Partial<Props> = {}): Promise<void> { props = { ...props, ...patch }; await act(async () => root.render(<Composer {...props} />)); }
function button(label: string): HTMLButtonElement { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label); if (!found) throw new Error(`Missing ${label}`); return found; }
async function click(label: string): Promise<void> { await act(async () => button(label).click()); }
const editor = (): HTMLElement => container.querySelector<HTMLElement>('[role="textbox"]')!;

describe("queue materials and durable retrieval", () => {
	it.each(["remove", "promote", "take", "preview"] as const)("ignores a late %s acknowledgement when synchronous navigation starts before a render", async (action) => {
		let current = true; const pending = Promise.withResolvers<Response>(); const base = request.getMockImplementation()!;
		const requestType = action === "preview" ? "session.queue.get" : `session.queue.${action}`;
		request.mockImplementation((payload) => payload.type === requestType ? pending.promise : base(payload));
		await render({ queueIsCurrent: () => current }); await click(text(action));
		const operationId = String(request.mock.calls.find(([payload]) => payload.type === requestType)?.[0].operationId ?? "receipt-one");
		current = false;
		await act(async () => pending.resolve({ ok: true, result: { queue: empty, input, receipt: returned(operationId) } }));
		expect(props.onQueueChange).not.toHaveBeenCalled(); expect(container.querySelector(".owl-prompt-queue-preview")).toBeNull(); expect(container.querySelector("[data-queue-receipt-id]")).toBeNull();
	});
	it("shows material counts and previews exact full user text, images and references", async () => {
		await render(); expect(container.textContent).toContain(text("images", { n: 1 })); expect(container.textContent).toContain(text("files", { n: 1 }));
		await click(text("preview")); expect(request).toHaveBeenCalledWith({ type: "session.queue.get", sessionId: "session-one", messageId: "message-one" });
		expect(container.querySelector(".owl-prompt-queue-preview pre")?.textContent).toBe(fullText);
		expect(container.querySelector(".owl-prompt-queue-images img")?.getAttribute("src")).toBe(`data:image/png;base64,${image.data}`);
		expect(container.querySelector(".owl-prompt-queue-files")?.textContent).toContain("notes/reference.md");
	});

	it("targets a stable message ID and does not remove the shifted neighbour on a stale failure", async () => {
		const pending = Promise.withResolvers<Response>(); const base = request.getMockImplementation()!;
		request.mockImplementation((payload) => payload.type === "session.queue.remove" ? pending.promise : base(payload));
		await render(); await click(text("remove"));
		const neighbour = { ...item, messageId: "message-two", text: "另一条要求" };
		await render({ queued: { steering: [], followUp: [neighbour] } });
		await act(async () => pending.resolve({ ok: false, result: { queue: { steering: [], followUp: [neighbour] } }, error: "already delivering" }));
		expect(request).toHaveBeenCalledWith({ type: "session.queue.remove", sessionId: "session-one", lane: "followUp", messageId: "message-one" });
		expect(container.querySelector('[data-queue-message-id="message-two"]')).not.toBeNull(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("already delivering");
	});

	it("blocks duplicate same-tick queue mutations and exposes retry on rejection", async () => {
		const pending = Promise.withResolvers<Response>(); const base = request.getMockImplementation()!;
		request.mockImplementationOnce(base).mockImplementationOnce(() => pending.promise);
		await render(); await act(async () => { const remove = button(text("remove")); remove.click(); remove.click(); });
		expect(request.mock.calls.filter(([payload]) => payload.type === "session.queue.remove")).toHaveLength(1);
		expect(button(text("remove")).disabled).toBe(true);
		await act(async () => pending.resolve({ ok: false, error: "connection rejected action" }));
		await click(text("retry")); expect(request.mock.calls.filter(([payload]) => payload.type === "session.queue.remove")).toHaveLength(2);
	});

	it("retrieves only after acknowledgement and merges every material without replacing the existing draft", async () => {
		await render({ draftRequest: { id: 1, text: "已有草稿", images: [{ ...image, data: "existing-image" }], attachedPaths: ["D:/current-project/existing.md"], replace: true } });
		await click(text("take")); expect(editor().textContent).toBe("已有草稿"); expect(receipts).toHaveLength(1);
		await click(text("append")); expect(editor().textContent).toBe(`已有草稿\n\n${fullText}`);
		expect(receipts).toHaveLength(1); expect(request.mock.calls.some(([payload]) => payload.type === "session.queue.returned.remove")).toBe(false);
		await click(t("composer.sendNextTurn"));
		expect(props.onSend).toHaveBeenCalledWith(`已有草稿\n\n${fullText.trimEnd()}`, [{ ...image, data: "existing-image" }, image], ["D:/current-project/existing.md", "D:/source-project/notes/reference.md"], "queue");
	});

	it("uses the same durable operation ID when a take acknowledgement fails and is retried", async () => {
		const base = request.getMockImplementation()!; let fail = true;
		request.mockImplementation((payload) => payload.type === "session.queue.take" && fail ? (fail = false, Promise.resolve({ ok: false, error: "ack lost" })) : base(payload));
		await render({ initialDraft: "不能清空" }); await click(text("take")); expect(editor().textContent).toBe("不能清空");
		await click(text("retry")); const calls = request.mock.calls.filter(([payload]) => payload.type === "session.queue.take");
		expect(calls).toHaveLength(2); expect(calls[0][0].operationId).toBe(calls[1][0].operationId); expect(receipts).toHaveLength(1);
	});

	it("shows delivery state and disables mutations without hiding full inspection", async () => {
		await render({ queued: { steering: [], followUp: [{ ...item, state: "delivering" }] } });
		expect(button(text("take")).disabled).toBe(true); expect(button(text("remove")).disabled).toBe(true); expect(button(text("promote")).disabled).toBe(true); expect(button(text("preview")).disabled).toBe(false);
		expect(container.textContent).toContain(text("delivering"));
	});

	it("retains retrieved input across session changes, including an empty new conversation", async () => {
		receipts = [returned()]; await render({ queueSessionId: undefined, queued: undefined, running: false, initialDraft: "新会话草稿" });
		expect(button(text("append")).disabled).toBe(false); await click(text("append"));
		expect(editor().textContent).toBe(`新会话草稿\n\n${fullText}`); expect(receipts).toHaveLength(1);
	});

	it("does not append an old retrieval after the user switches conversations", async () => {
		receipts = [returned()]; const pending = Promise.withResolvers<Response>(); const base = request.getMockImplementation()!;
		request.mockImplementation((payload) => payload.type === "session.queue.returned.get" ? pending.promise : base(payload));
		await render({ initialDraft: "会话A" }); await click(text("append"));
		await render({ queueSessionId: "session-two", draftRequest: { id: 2, text: "会话B的草稿", replace: true } });
		await act(async () => pending.resolve({ ok: true, result: { receipt: returned() } }));
		expect(editor().textContent).toBe("会话B的草稿"); expect(receipts).toHaveLength(1);
	});

	it("checks synchronous ownership even before the navigation render commits", async () => {
		receipts = [returned()]; let current = true; const pending = Promise.withResolvers<Response>(); const base = request.getMockImplementation()!;
		request.mockImplementation((payload) => payload.type === "session.queue.returned.get" ? pending.promise : base(payload));
		await render({ initialDraft: "保留原草稿", queueIsCurrent: () => current }); await click(text("append")); current = false;
		await act(async () => pending.resolve({ ok: true, result: { receipt: returned() } }));
		expect(editor().textContent).toBe("保留原草稿"); expect(receipts).toHaveLength(1);
	});

	it("keeps another account's late take result out of the current account view", async () => {
		const pending = Promise.withResolvers<Response>(); const base = request.getMockImplementation()!;
		request.mockImplementation((payload) => payload.type === "session.queue.take" ? pending.promise : base(payload));
		await render(); await click(text("take")); const operationId = String(request.mock.calls.find(([payload]) => payload.type === "session.queue.take")![0].operationId);
		const otherClient = { request: vi.fn(async () => ({ ok: true, result: { receipts: [] } })), onStatus: () => () => {} } as unknown as BridgeClient;
		await render({ client: otherClient, queueProfile: "D:/profile-two", queueSessionId: "other-session", queued: empty });
		await act(async () => pending.resolve({ ok: true, result: { receipt: returned(operationId), queue: empty } }));
		expect(container.querySelector("[data-queue-receipt-id]")).toBeNull();
		expect(otherClient.request).toHaveBeenCalledOnce();
	});

	it("refreshes current-account receipts after a late take without appending to the new session or accepting an older empty list", async () => {
		const taking = Promise.withResolvers<Response>(); const oldList = Promise.withResolvers<Response>(); const base = request.getMockImplementation()!;
		let listCount = 0;
		request.mockImplementation((payload) => {
			if (payload.type === "session.queue.take") return taking.promise;
			if (payload.type === "session.queue.returned.list" && ++listCount === 2) return oldList.promise;
			return base(payload);
		});
		await render({ initialDraft: "草稿A" }); await click(text("take"));
		const operationId = String(request.mock.calls.find(([payload]) => payload.type === "session.queue.take")![0].operationId);
		await render({ queueSessionId: "session-two", queued: empty, draftRequest: { id: 3, text: "草稿B", replace: true } });
		receipts = [returned(operationId)];
		await act(async () => taking.resolve({ ok: true, result: { receipt: receipts[0], queue: empty } }));
		expect(container.querySelector(`[data-queue-receipt-id="${operationId}"]`)).not.toBeNull(); expect(editor().textContent).toBe("草稿B");
		await act(async () => oldList.resolve({ ok: true, result: { receipts: [] } }));
		expect(container.querySelector(`[data-queue-receipt-id="${operationId}"]`)).not.toBeNull(); expect(editor().textContent).toBe("草稿B");
	});

	it("does not append a different receipt returned for the requested identity", async () => {
		receipts = [returned()]; const base = request.getMockImplementation()!;
		request.mockImplementation((payload) => payload.type === "session.queue.returned.get" ? Promise.resolve({ ok: true, result: { receipt: returned("wrong-receipt") } }) : base(payload));
		await render({ initialDraft: "保留" }); await click(text("append"));
		expect(editor().textContent).toBe("保留"); expect(container.querySelector('[role="alert"]')?.textContent).toContain(text("missingPayload"));
	});

	it("removes a persistent original only after explicit confirmation", async () => {
		receipts = [returned()]; await render(); await click(text("forget"));
		expect(request.mock.calls.some(([payload]) => payload.type === "session.queue.returned.remove")).toBe(false);
		await click(text("confirmForget")); expect(receipts).toHaveLength(0); expect(container.querySelector("[data-queue-receipt-id]")).toBeNull();
	});
});
