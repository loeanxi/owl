import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient, SessionEventHandler } from "../bridge/client.ts";
import type { ServerEventMessage, SessionPromptSuggestionResult } from "../bridge/protocol.ts";
import { usePromptSuggestion } from "./use-prompt-suggestion.ts";

type Options = Parameters<typeof usePromptSuggestion>[0];
type Response = { ok: boolean; result?: SessionPromptSuggestionResult };
let options: Options;
let api: ReturnType<typeof usePromptSuggestion>;
let root: Root;
let request: ReturnType<typeof vi.fn>;
let listeners: Set<SessionEventHandler>;
let sequence = 0;

function Harness(): React.JSX.Element {
	api = usePromptSuggestion(options);
	return <div>{api.suggestion}</div>;
}

beforeEach(() => {
	vi.useFakeTimers();
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(dom.document, "visibilityState", { value: "visible", writable: true, configurable: true });
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
	listeners = new Set();
	request = vi.fn(async (value: { type: string }) => value.type.endsWith(".cancel") ? { ok: true } : { ok: true, result: { basisEntryId: "answer-1", suggestion: "核对修改后的页面效果" } });
	options = {
		client: { request, onSessionEvent: (handler: SessionEventHandler) => { listeners.add(handler); return () => { listeners.delete(handler); }; } } as unknown as BridgeClient,
		connected: true, sessionId: `prediction-fixture-${++sequence}`, profile: "isolated", ownerRevision: 1, cwd: "D:/fixture", model: "fixture/model",
		running: false, paused: false, disabled: false, eligible: true, isCurrent: () => true,
	};
	root = createRoot(dom.document.getElementById("root")!);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(patch: Partial<Options> = {}): Promise<void> {
	options = { ...options, ...patch };
	await act(async () => root.render(<Harness />));
}

async function settle(): Promise<void> { await act(async () => vi.advanceTimersByTimeAsync(701)); }

async function event(type: string): Promise<void> {
	await act(async () => { for (const handler of listeners) handler({ type: "session.event", sessionId: options.sessionId, event: { type } } as unknown as ServerEventMessage); });
}

describe("composer prediction ownership and lifecycle", () => {
	it("debounces catch-up, accepts once, and waits for another settled turn", async () => {
		await render();
		expect(request).not.toHaveBeenCalled();
		await settle();
		expect(api.suggestion).toBe("核对修改后的页面效果");
		let accepted: string | undefined;
		await act(async () => { accepted = api.accept(); });
		expect(accepted).toBe("核对修改后的页面效果");
		expect(api.suggestion).toBeUndefined();
		await render({ eligible: false });
		await render({ eligible: true });
		await settle();
		expect(request).toHaveBeenCalledTimes(1);
		request.mockResolvedValue({ ok: true, result: { basisEntryId: "answer-2", suggestion: "检查验收结果" } });
		await event("agent_settled");
		await settle();
		expect(api.suggestion).toBe("检查验收结果");
	});

	it("cancels and rejects a late result after the user starts editing", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockImplementation(async (value: { type: string }) => value.type.endsWith(".cancel") ? { ok: true } : pending.promise);
		await render(); await settle();
		const original = request.mock.calls[0][0];
		await render({ eligible: false });
		expect(request).toHaveBeenLastCalledWith({ type: "session.promptSuggestion.cancel", sessionId: options.sessionId, generationId: original.generationId });
		await act(async () => pending.resolve({ ok: true, result: { basisEntryId: "old-answer", suggestion: "不要覆盖用户输入" } }));
		expect(api.suggestion).toBeUndefined();
		await render({ eligible: true }); await settle();
		expect(request.mock.calls.filter(([value]) => value.type === "session.promptSuggestion")).toHaveLength(1);
	});

	it("dismisses a not-yet-started debounce even if trimmed draft eligibility remains true", async () => {
		await render();
		await act(async () => api.dismiss());
		await settle();
		expect(request).not.toHaveBeenCalled();
		expect(api.suggestion).toBeUndefined();
	});

	it("keeps old session and old model responses outside a new owner", async () => {
		const old = Promise.withResolvers<Response>();
		request.mockImplementationOnce(() => old.promise);
		await render(); await settle();
		await render({ sessionId: "new-session", model: "fixture/other", ownerRevision: 2 });
		await settle();
		expect(api.suggestion).toBe("核对修改后的页面效果");
		await act(async () => old.resolve({ ok: true, result: { basisEntryId: "stale", suggestion: "旧会话建议" } }));
		expect(api.suggestion).toBe("核对修改后的页面效果");
	});

	it("invalidates the in-flight prediction as soon as the next run starts", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockImplementation(async (value: { type: string }) => value.type.endsWith(".cancel") ? { ok: true } : pending.promise);
		await render(); await settle(); await event("agent_start");
		await act(async () => pending.resolve({ ok: true, result: { basisEntryId: "old", suggestion: "过期建议" } }));
		expect(api.suggestion).toBeUndefined();
		expect(request.mock.calls.some(([value]) => value.type === "session.promptSuggestion.cancel")).toBe(true);
	});

	it.each([{ running: true }, { paused: true }, { disabled: true }, { connected: false }, { eligible: false }, { sessionId: undefined }, { profile: undefined }])("does not predict while unavailable: %j", async (patch) => {
		await render(patch); await settle();
		expect(request).not.toHaveBeenCalled();
		expect(api.suggestion).toBeUndefined();
	});

	it("invalidates visible predictions when the bridge client changes even for the same profile and session", async () => {
		await render(); await settle();
		expect(api.suggestion).toBe("核对修改后的页面效果");
		const replacement = vi.fn(async () => ({ ok: true, result: { basisEntryId: "new-client", suggestion: "新连接的建议" } }));
		await render({ client: { request: replacement, onSessionEvent: () => () => {} } as unknown as BridgeClient });
		expect(api.suggestion).toBeUndefined();
		await settle();
		expect(api.suggestion).toBe("新连接的建议");
		expect(replacement).toHaveBeenCalledTimes(1);
	});

	it("suppresses background-window predictions and catches up once the document is visible", async () => {
		Object.defineProperty(document, "visibilityState", { value: "hidden", writable: true, configurable: true });
		await render(); await settle();
		expect(request).not.toHaveBeenCalled();
		await act(async () => {
			Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await settle();
		expect(api.suggestion).toBe("核对修改后的页面效果");
	});

	it("ignores failed or malformed replies without retrying in a loop", async () => {
		request.mockResolvedValue({ ok: true, result: { suggestion: "没有权威回答身份" } });
		await render(); await settle();
		expect(api.suggestion).toBeUndefined();
		await render({ eligible: false }); await render({ eligible: true }); await settle();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("persists the off switch and aborts pending work", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockImplementation(async (value: { type: string }) => value.type.endsWith(".cancel") ? { ok: true } : pending.promise);
		await render(); await settle();
		await act(async () => api.setEnabled(false));
		expect(api.enabled).toBe(false);
		expect(localStorage.getItem("owl.composer.predictions.enabled")).toBe("false");
		expect(request.mock.calls.some(([value]) => value.type === "session.promptSuggestion.cancel")).toBe(true);
		await act(async () => pending.resolve({ ok: true, result: { basisEntryId: "off", suggestion: "不应出现" } }));
		expect(api.suggestion).toBeUndefined();
	});

	it("shows a turn-specific hint immediately, then replaces it with the model line", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockImplementation(async (value: { type: string }) => value.type.endsWith(".cancel") ? { ok: true } : pending.promise);
		await render({ followUp: { user: "can you speak english", assistant: "What can I help you with?" } });
		expect(api.suggestion).toContain("can you speak english");
		expect(api.suggestion).not.toContain("继续，把下一步说具体一点");
		await settle();
		await act(async () => pending.resolve({ ok: true, result: { basisEntryId: "answer-1", suggestion: "Summarize this chat in English" } }));
		expect(api.suggestion).toBe("Summarize this chat in English");
	});

	it("does not start or accept work after its caller loses ownership", async () => {
		let current = true;
		await render({ isCurrent: () => current }); await settle();
		current = false;
		expect(api.accept()).toBeUndefined();
		await render({ ownerRevision: 3 }); await settle();
		expect(request).toHaveBeenCalledTimes(1);
	});
});
