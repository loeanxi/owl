import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let container: HTMLElement;
let root: Root;

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
	setUiLanguage("zh");
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

const promptQueueText = (key: "promote" | "remove"): string => (key === "promote" ? "提前处理" : "取消排队");

describe("queued bubble actions", () => {
	it("matches queue snapshot items by text and offers promote (followUp) and remove", async () => {
		const onQueuedRemove = vi.fn();
		const onQueuedPromote = vi.fn();
		const entries: ChatEntry[] = [
			{ kind: "user", text: "在跑的这一轮", entryId: "u0" },
			{ kind: "assistant", text: "工作中", thinking: "", tools: [], entryId: "a0" },
			{ kind: "user", text: "跟进一", queued: true },
			{ kind: "user", text: "跟进二（要立即发送）", queued: true },
		];
		const queuedItems = [
			{ messageId: "m-steer", lane: "steering" as const, text: "跟进一" },
			{ messageId: "m-follow", lane: "followUp" as const, text: "跟进二（要立即发送）" },
		];
		await act(async () =>
			root.render(
				<ChatStream
					entries={entries}
					sessionId="session"
					cwd="D:/project"
					onQueuedRemove={onQueuedRemove}
					onQueuedPromote={onQueuedPromote}
					queuedItems={queuedItems}
				/>,
			),
		);
		const actions = [...container.querySelectorAll<HTMLButtonElement>(".owl-user-queued-action")];
		// 每个排队气泡两个动作（followUp 有 promote，steering 只有 remove）。
		expect(actions).toHaveLength(3);
		const promote = actions.find((item) => item.textContent === promptQueueText("promote"));
		expect(promote).not.toBeUndefined();
		await act(async () => promote!.click());
		expect(onQueuedPromote).toHaveBeenCalledWith("m-follow");
		// 「跟进二」是第二个排队气泡：取它的 remove 按钮。
		const remove = [...container.querySelectorAll<HTMLButtonElement>(".owl-user-queued-action")]
			.filter((item) => item.textContent === promptQueueText("remove"))
			.at(-1)!;
		expect(remove).not.toBeUndefined();
		await act(async () => remove!.click());
		expect(onQueuedRemove).toHaveBeenCalledWith("m-follow", "followUp");
	});

	it("renders no actions without callbacks or matching snapshot items", async () => {
		const entries: ChatEntry[] = [{ kind: "user", text: "排队中", queued: true }];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		expect(container.querySelectorAll(".owl-user-queued-action")).toHaveLength(0);
		expect(container.querySelector(".owl-user-queued-hint")?.textContent).toBe(t("composer.queuedHint"));
	});
});

describe("latest error inline retry", () => {
	it("offers retry only on the newest error while idle and routes through the regenerate confirm", async () => {
		const onRegenerate = vi.fn();
		const entries: ChatEntry[] = [
			{ kind: "user", text: "推进", entryId: "u1", timestamp: 1 },
			{
				kind: "assistant",
				text: "",
				thinking: "",
				tools: [],
				entryId: "a1",
				error: "HTTP 429",
				timestamp: 2,
				endedAt: 3,
			},
		];
		await act(async () =>
			root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" onRegenerate={onRegenerate} />),
		);
		const retry = container.querySelector<HTMLButtonElement>(".owl-chat-error-retry");
		expect(retry?.textContent).toBe(t("recovery.retry"));
		await act(async () => retry!.click());
		// 走的是确认流：请求再生成本身只是开确认框（App 内 requestRegenerate），这里确认回调直接注入。
		expect(onRegenerate).toHaveBeenCalledOnce();
	});

	it("stays copy-only for older errors without regenerate affordance", async () => {
		const entries: ChatEntry[] = [
			{ kind: "user", text: "第一轮", entryId: "u1" },
			{ kind: "assistant", text: "", thinking: "", tools: [], entryId: "a1", error: "旧错误" },
			{ kind: "user", text: "第二轮", entryId: "u2" },
			{ kind: "assistant", text: "完成", thinking: "", tools: [], entryId: "a2" },
		];
		await act(async () =>
			root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" onRegenerate={() => {}} />),
		);
		expect(container.querySelector(".owl-chat-error-retry")).toBeNull();
		expect(container.querySelector(".owl-chat-error")?.textContent).toContain("旧错误");
	});
});
