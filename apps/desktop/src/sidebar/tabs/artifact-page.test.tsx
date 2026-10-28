import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import type { Product } from "../../hooks/products.ts";
import { setUiLanguage } from "../../i18n/index.ts";
import type { SidebarApi } from "../api.ts";
import { SidebarStore } from "../store.ts";
import { ArtifactTab } from "./ArtifactTab.tsx";

vi.mock("../../components/OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let root: Root;
let host: HTMLElement;
let store: SidebarStore;
let requests: Array<Record<string, unknown>>;
let listeners: Array<(message: unknown) => void>;

const fileProduct: Product = {
	id: "file:docs/report.md",
	kind: "file",
	title: "report.md",
	subtitle: "docs/report.md",
	path: "docs/report.md",
	toolId: "w1",
	fileKind: "document",
	action: "written",
};

const chartProduct: Product = {
	id: "visual:v1",
	kind: "chart",
	title: "月度趋势",
	toolId: "v1",
	spec: { title: "月度趋势", items: [{ type: "chart", data: [{ label: "一月", value: 12 }] }] },
};

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
			observe(): void {}
			disconnect(): void {}
		},
	);
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	// React 在这个 DOM 之前加载，textarea 的变更走它的 input polyfill。
	Object.assign(dom.window.HTMLTextAreaElement.prototype, {
		attachEvent(this: HTMLElement, name: string, listener: EventListener): void {
			this.addEventListener(name.replace(/^on/, ""), listener);
		},
		detachEvent(this: HTMLElement, name: string, listener: EventListener): void {
			this.removeEventListener(name.replace(/^on/, ""), listener);
		},
	});
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
	requests = [];
	listeners = [];
	store = new SidebarStore("D:/owl", "owl.test.artifact");
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

function fakeClient(): BridgeClient {
	return {
		request: vi.fn(async (request: Record<string, unknown>) => {
			requests.push(request);
			if (request.type === "session.create") return { ok: true, result: { sessionId: "s1" } };
			if (request.type === "session.resume") return { ok: false, error: "no session" };
			return { ok: true, result: undefined };
		}),
		onSessionEvent: (listener: (message: unknown) => void) => {
			listeners.push(listener);
			return () => {
				listeners = listeners.filter((item) => item !== listener);
			};
		},
		watchSessionEvents: () => () => {},
	} as unknown as BridgeClient;
}

function fakeApi(): SidebarApi {
	return {
		fsRead: vi.fn(async () => ({ kind: "text", content: "# 报告\n\n这是正文。", truncated: false })),
		fsReadBin: vi.fn(async () => ({ mediaType: "image/png", base64: "" })),
		openExternal: vi.fn(async () => undefined),
	} as unknown as SidebarApi;
}

async function render(product: Product, extra: { onToChat?: (text: string) => void } = {}): Promise<void> {
	await act(async () => {
		root.render(
			<ArtifactTab
				api={fakeApi()}
				store={store}
				cwd="D:/owl"
				client={fakeClient()}
				tab={{ id: `artifact:${product.id}`, kind: "artifact", title: product.title, productId: product.id }}
				onOpenFile={() => undefined}
				gitStatus={undefined}
				onGitRefresh={() => undefined}
				products={[product]}
				{...extra}
			/>,
		);
	});
}

/** 往 composer 里打字（React 的 input polyfill 走 focusin/keyup/focusout）。 */
async function type(text: string): Promise<void> {
	const input = host.querySelector(".owl-artifact-input") as HTMLTextAreaElement;
	await act(async () => {
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
		input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
}

async function click(selector: string): Promise<void> {
	await act(async () => {
		(host.querySelector(selector) as HTMLButtonElement).click();
	});
}

/** 模拟服务端把一句回答推过来（message_start + message_end）。 */
async function emitReply(text: string): Promise<void> {
	await act(async () => {
		for (const listener of listeners) {
			listener({
				sessionId: "s1",
				event: { type: "message_start", message: { role: "assistant", timestamp: 1000 } },
			});
			listener({
				sessionId: "s1",
				event: {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1000 },
				},
			});
		}
	});
}

describe("the artifact page", () => {
	it("shows the artifact itself: title, kind badge and content", async () => {
		await render(fileProduct);
		expect(host.querySelector(".owl-artifact-title")?.textContent).toBe("report.md");
		expect(host.querySelector(".owl-artifact-kind")?.textContent).toBe("文档");
		expect(host.querySelector(".owl-artifact-text, .owl-artifact-file")?.textContent).toContain("这是正文");
		// 页底永远有 composer：这是产物页与普通文件预览的区别。
		expect(host.querySelector(".owl-artifact-composer")).not.toBeNull();
	});

	it("switches between the artifact and its thread", async () => {
		await render(fileProduct);
		const modes = [...host.querySelectorAll(".owl-artifact-mode")];
		expect(modes.map((node) => node.textContent)).toEqual(["产物", "对话"]);
		await click(".owl-artifact-mode:nth-of-type(2)");
		expect(host.textContent).toContain("关于这个产物问点什么");
	});

	it("asks about the artifact with it attached, on its own thread", async () => {
		await render(fileProduct);
		await type("这个报告讲了什么");
		await click(".owl-artifact-send");
		const prompt = requests.find((request) => request.type === "session.prompt");
		expect(prompt).toBeDefined();
		// 文件产物作为只读附件随这一轮走；正文里带上产物上下文。
		expect(prompt?.attachedPaths).toEqual(["docs/report.md"]);
		expect(String(prompt?.message)).toContain("[Artifact context]");
		expect(String(prompt?.message)).toContain("这个报告讲了什么");
		// 独立线程：不碰主对话。
		expect(requests.some((request) => request.type === "session.create")).toBe(true);
		// 问的那句回到线程里（上下文不进气泡）。
		await click(".owl-artifact-mode:nth-of-type(2)");
		expect(host.querySelector(".owl-artifact-bubble")?.textContent).toBe("这个报告讲了什么");
	});

	it("echoes the reply inline and can carry it back to the main chat", async () => {
		const carried: string[] = [];
		await render(fileProduct, { onToChat: (text) => carried.push(text) });
		await type("这个报告讲了什么");
		await click(".owl-artifact-send");
		await emitReply("报告讲的是这个月的费用明细。");
		const reply = host.querySelector(".owl-artifact-reply");
		expect(reply).not.toBeNull();
		expect(reply?.textContent).toContain("Owl 的回复");
		expect(reply?.textContent).toContain("报告讲的是这个月的费用明细");
		await click(".owl-artifact-reply-action");
		expect(carried).toHaveLength(1);
		expect(carried[0]).toContain("report.md");
	});

	it("renders a visualization product with its spec", async () => {
		await render(chartProduct);
		expect(host.querySelector(".owl-artifact-title")?.textContent).toBe("月度趋势");
		expect(host.querySelector(".owl-artifact-kind")?.textContent).toBe("图表");
	});
});
