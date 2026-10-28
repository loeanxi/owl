import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import type { SessionStatsResult } from "../bridge/protocol.ts";
import { ModelSelectionNotice } from "../components/ModelSelectionNotice.tsx";
import { modelSelectionText as text } from "../components/model-selection-copy.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { useModelSelection } from "./use-model-selection.ts";

type Options = Parameters<typeof useModelSelection>[0];
type Response = { ok: boolean; result?: SessionStatsResult; error?: string };
const stats = (id: string): SessionStatsResult => ({
	model: { provider: "fixture", id },
	thinkingLevel: "high",
	availableThinkingLevels: ["high"],
	supportsThinking: true,
});
let root: Root;
let container: HTMLElement;
let options: Options;
let selection: ReturnType<typeof useModelSelection>;
let onStatus: (up: boolean) => void;
let request = vi.fn(async (_payload: unknown): Promise<Response> => ({ ok: true, result: stats("new") }));

function Harness(): React.JSX.Element {
	selection = useModelSelection(options);
	return (
		<ModelSelectionNotice
			feedback={selection.feedback}
			providers={[
				{
					id: "fixture",
					models: [{ id: "new", name: "New model", contextWindow: 200000, input: ["text", "image"] }],
				},
			]}
			onRetry={selection.retry}
		/>
	);
}

beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	request = vi.fn(async (_payload: unknown): Promise<Response> => ({ ok: true, result: stats("new") }));
	const client = {
		request,
		onStatus: (listener: (up: boolean) => void) => {
			onStatus = listener;
			return () => {};
		},
	} as unknown as BridgeClient;
	options = {
		client,
		profile: "account-one",
		sessionId: "one",
		cwd: "D:/project",
		connected: true,
		running: false,
		model: "fixture/old",
		stats: stats("old"),
		onStart: vi.fn(),
		onApplied: vi.fn(),
	};
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});
async function render(patch: Partial<Options> = {}): Promise<void> {
	options = { ...options, ...patch };
	await act(async () => root.render(<Harness />));
}
async function select(target = "fixture/new"): Promise<void> {
	await act(async () => selection.select(target));
}

describe("host-confirmed model selection", () => {
	it("keeps the current model while pending and applies only the acknowledged host snapshot", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await select();
		expect(selection.feedback).toMatchObject({ status: "pending", target: "fixture/new", actual: "fixture/old" });
		expect(options.onApplied).not.toHaveBeenCalled();
		expect(selection.isPending()).toBe(true);
		expect(container.textContent).toContain("New model");
		expect(container.textContent).toContain("200,000");
		expect(container.textContent).toContain("支持图片");
		await act(async () => pending.resolve({ ok: true, result: stats("new") }));
		expect(options.onApplied).toHaveBeenCalledExactlyOnceWith("fixture/new", stats("new"));
		expect(selection.feedback?.status).toBe("confirmed");
		expect(selection.isPending()).toBe(false);
	});

	it("retains the last confirmed selection on failure and retries the failed target", async () => {
		request.mockResolvedValueOnce({ ok: false, error: "No API key" });
		await render();
		await select();
		expect(options.onApplied).not.toHaveBeenCalled();
		expect(selection.feedback).toMatchObject({ status: "error", actual: "fixture/old" });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("No API key");
		await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
		expect(request).toHaveBeenCalledTimes(2);
		expect(selection.feedback?.status).toBe("confirmed");
	});

	it("calibrates partial application from a failure snapshot while retaining the error", async () => {
		request.mockResolvedValueOnce({ ok: false, result: stats("new"), error: "model selection extension failed" });
		await render();
		await select();
		expect(selection.feedback).toMatchObject({ status: "error", actual: "fixture/new" });
		expect(options.onApplied).toHaveBeenCalledExactlyOnceWith("fixture/new", stats("new"));
		expect(container.textContent).toContain("model selection extension failed");
	});

	it("rejects a missing confirmation snapshot instead of claiming the requested model is active", async () => {
		request.mockResolvedValueOnce({ ok: true });
		await render();
		await select();
		expect(selection.feedback?.status).toBe("error");
		expect(options.onApplied).not.toHaveBeenCalled();
		expect(container.textContent).toContain(text("unconfirmed"));
	});

	it("serializes requests and coalesces rapid selections to the newest target", async () => {
		const first = Promise.withResolvers<Response>();
		const last = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
		await render();
		await select("fixture/first");
		await select("fixture/skipped");
		await select("fixture/last");
		expect(request).toHaveBeenCalledTimes(1);
		expect(selection.feedback?.target).toBe("fixture/last");
		await act(async () => first.resolve({ ok: true, result: stats("first") }));
		expect(options.onApplied).not.toHaveBeenCalled();
		expect(request).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenLastCalledWith({
			type: "session.setModel",
			sessionId: "one",
			provider: "fixture",
			model: "last",
		});
		await act(async () => last.resolve({ ok: true, result: stats("last") }));
		expect(options.onApplied).toHaveBeenCalledExactlyOnceWith("fixture/last", stats("last"));
		expect(selection.feedback?.actual).toBe("fixture/last");
	});

	it("uses the intermediate host-confirmed model when the newest queued selection fails", async () => {
		const first = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: false, error: "last unavailable" });
		await render();
		await select("fixture/first");
		await select("fixture/last");
		await act(async () => first.resolve({ ok: true, result: stats("first") }));
		expect(options.onApplied).toHaveBeenCalledExactlyOnceWith("fixture/first", stats("first"));
		expect(selection.feedback).toMatchObject({ status: "error", target: "fixture/last", actual: "fixture/first" });
	});

	it.each([{ sessionId: "two" }, { profile: "account-two" }, { cwd: "D:/other" }, { viewRevision: 2 }])(
		"ignores a pending response after scope changes: %j",
		async (patch) => {
			const pending = Promise.withResolvers<Response>();
			request.mockReturnValueOnce(pending.promise);
			await render();
			await select();
			await render(patch);
			await act(async () => pending.resolve({ ok: true, result: stats("new") }));
			expect(options.onApplied).not.toHaveBeenCalled();
			expect(selection.feedback).toBeUndefined();
		},
	);

	it("invalidates a disconnected bridge even when reconnects are batched", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await select();
		await act(async () => {
			onStatus(false);
			onStatus(true);
		});
		await act(async () => pending.resolve({ ok: true, result: stats("new") }));
		expect(options.onApplied).not.toHaveBeenCalled();
		expect(selection.feedback).toBeUndefined();
		await select();
		expect(selection.feedback?.status).toBe("confirmed");
	});

	it("stages a new conversation preference without a host request or active-session claim", async () => {
		await render({ sessionId: undefined });
		await select();
		expect(request).not.toHaveBeenCalled();
		expect(options.onApplied).toHaveBeenCalledExactlyOnceWith("fixture/new");
		expect(selection.feedback?.status).toBe("selected");
		expect(container.textContent).toContain("创建会话时应用");
		expect(container.textContent).not.toContain("会话已确认");
	});

	it("describes in-flight requests accurately and updates feedback copy with the language", async () => {
		await render({ running: true });
		await select();
		expect(container.textContent).toContain("已发出的请求不会重启");
		await act(async () => setUiLanguage("en"));
		expect(container.textContent).toContain("Requests already sent are not restarted");
	});

	it("does not publish a result after unmounting its conversation", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await select();
		await act(async () => root.render(null));
		await act(async () => pending.resolve({ ok: true, result: stats("new") }));
		expect(options.onApplied).not.toHaveBeenCalled();
	});

	it("checks synchronous navigation ownership before a render has been committed", async () => {
		let current = true;
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render({ isCurrent: () => current });
		await select();
		current = false;
		await act(async () => pending.resolve({ ok: true, result: stats("new") }));
		expect(options.onApplied).not.toHaveBeenCalled();
	});

	it("does not send duplicate changes for repeated clicks on the same pending model", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await select();
		await select();
		await act(async () => pending.resolve({ ok: true, result: stats("new") }));
		expect(request).toHaveBeenCalledOnce();
		expect(options.onApplied).toHaveBeenCalledOnce();
	});

	it("ignores a response belonging to a replaced bridge object", async () => {
		const pending = Promise.withResolvers<Response>();
		request.mockReturnValueOnce(pending.promise);
		await render();
		await select();
		const replacement = { request: vi.fn(), onStatus: () => () => {} } as unknown as BridgeClient;
		await render({ client: replacement });
		await act(async () => pending.resolve({ ok: true, result: stats("new") }));
		expect(options.onApplied).not.toHaveBeenCalled();
		expect(selection.feedback).toBeUndefined();
	});
});
