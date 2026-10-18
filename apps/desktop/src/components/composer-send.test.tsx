import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { t } from "../i18n/index.ts";
import { Composer, type ComposerImage } from "./Composer.tsx";
import { composerMaterialsText } from "./composer-materials-copy.ts";
import { executionText } from "./execution-copy.ts";

vi.mock("../bridge/native.ts", () => ({
	listenForOsFileDrop: async () => () => {},
	readLocalImage: async () => undefined,
}));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null }));

type Props = React.ComponentProps<typeof Composer>;
const screenshot: ComposerImage = { type: "image", mimeType: "image/png", data: "first-image" };
const secondImage: ComposerImage = { type: "image", mimeType: "image/jpeg", data: "second-image" };
let container: HTMLElement;
let root: Root;
let props: Props;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll("\\", "\\\\") });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	dom.window.getSelection = () => null;
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	props = {
		client: { request: async () => ({ ok: true, result: { isFile: true, isDirectory: false } }) } as unknown as BridgeClient, connected: true, disabled: false, running: false,
		hideEnvironment: true, hideMascot: true, onSend: vi.fn(() => true), onAbort: vi.fn(),
		providers: [], model: "fixture/model", onModel: vi.fn(), thinkingLevel: "high", onThinkingLevel: vi.fn(),
		approvalMode: "confirm", onApprovalMode: vi.fn(), sessionInfo: undefined,
		workspaceDir: "D:/owl", projects: [], onSwitchProject: vi.fn(), commands: [], searchFiles: async () => [],
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(overrides: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<Composer {...props} />));
}

function button(label: string): HTMLButtonElement {
	const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
		.find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
	if (!found) throw new Error(`Missing button: ${label}`);
	return found;
}

function editor(): HTMLElement {
	return container.querySelector<HTMLElement>('[role="textbox"]')!;
}

function expectNoDeliveryControls(): void {
	expect(container.querySelector(".owl-composer-delivery")).toBeNull();
	const labels = [...container.querySelectorAll("button")].map((item) => item.getAttribute("aria-label") ?? item.textContent?.trim());
	expect(labels).not.toContain(t("composer.sendNextTurn"));
	expect(labels).not.toContain(t("composer.steerCurrent"));
}

async function click(label: string): Promise<void> {
	await act(async () => button(label).click());
}

async function enter(ctrlKey = false): Promise<void> {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: "Enter", code: "Enter", ctrlKey, isComposing: false });
		editor().dispatchEvent(event);
	});
}

async function type(text: string): Promise<void> {
	await act(async () => {
		editor().textContent = text;
		editor().dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

describe("Composer task control", () => {
	it("preserves the draft and blocks mouse and Enter sends until a model choice is confirmed", async () => {
		await render({ initialDraft: "保留这条需求", modelSelection: { status: "pending", target: "fixture/next", actual: "fixture/model", running: false } });
		expect(button(t("composer.send")).disabled).toBe(true);
		await enter(); expect(props.onSend).not.toHaveBeenCalled(); expect(editor().textContent).toBe("保留这条需求");
		await render({ modelSelection: { status: "error", target: "fixture/next", actual: "fixture/model", running: false, error: "No API key" }, onRetryModelSelection: vi.fn() });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("No API key");
		expect(button(t("composer.send")).disabled).toBe(false);
	});

	it("keeps pause available while a running task's model switch is pending", async () => {
		const onPause = vi.fn();
		await render({ running: true, initialDraft: "调整要求", onPause, modelSelection: { status: "pending", target: "fixture/next", actual: "fixture/model", running: true } });
		expectNoDeliveryControls();
		expect(button(t("composer.pause")).disabled).toBe(false);
		await click(t("composer.pause")); expect(onPause).toHaveBeenCalledOnce();
		await enter(); expect(props.onSend).not.toHaveBeenCalled();
		await enter(true); expect(props.onSend).not.toHaveBeenCalled();
	});
	it("keeps the pause button with a draft and steers at the next action boundary on Enter", async () => {
		const onSend = vi.fn(() => false);
		const onPause = vi.fn();
		await render({ running: true, initialDraft: "先检查实际报错", onSend, onPause });
		expectNoDeliveryControls();
		expect(button(t("composer.pause")).disabled).toBe(false);
		await click(t("composer.pause"));
		expect(onPause).toHaveBeenCalledOnce();
		expect(onSend).not.toHaveBeenCalled();
		expect(editor().textContent).toBe("先检查实际报错");
		await enter();
		expect(onSend).toHaveBeenLastCalledWith("先检查实际报错", undefined, undefined, "steer");
		await enter(true);
		expect(onSend).toHaveBeenLastCalledWith("先检查实际报错", undefined, undefined, "steer");
		expect(onSend).toHaveBeenCalledTimes(2);
	});
	it("keeps explicit next-turn queue delivery without aborting and preserves failed materials", async () => {
		const onSend = vi.fn(() => false);
		await render({ running: true, onSend, draftRequest: { id: 1, text: "下一轮再检查", images: [screenshot], attachedPaths: ["D:/owl/main.ts"], replace: true } });
		const delivery = container.querySelector<HTMLButtonElement>(`button[title="${executionText("delivery")}"]`)!;
		await act(async () => delivery.click());
		await click(executionText("queue"));
		expect(onSend).toHaveBeenCalledWith("下一轮再检查", [screenshot], ["D:/owl/main.ts"], "queue");
		expect(props.onAbort).not.toHaveBeenCalled();
		expect(editor().textContent).toBe("下一轮再检查");
		expect(container.querySelector('img[src="data:image/png;base64,first-image"]')).not.toBeNull();
	});

	it("sends a paused draft with both mouse and Enter; only an empty draft resumes the old task", async () => {
		const onSend = vi.fn(() => false);
		const onResume = vi.fn();
		await render({ paused: true, initialDraft: "只改当前文件", onSend, onResume });
		await click(t("composer.sendAndResume"));
		await enter();
		expect(onSend).toHaveBeenCalledTimes(2);
		expect(onSend).toHaveBeenLastCalledWith("只改当前文件", undefined, undefined, undefined);
		expect(onResume).not.toHaveBeenCalled();
		await type("");
		await click(t("composer.resume"));
		await enter();
		expect(onResume).toHaveBeenCalledTimes(2);
		expect(onSend).toHaveBeenCalledTimes(2);
	});
});

describe("Composer complete draft delivery", () => {
	it.each(["false", "rejected", "thrown"] as const)("retains text, screenshots and file references after %s then clears only on acceptance", async (failure) => {
		const onSend = vi.fn<Props["onSend"]>()
			.mockImplementationOnce(() => {
				if (failure === "thrown") throw new Error("bridge offline");
				return failure === "false" ? false : Promise.reject(new Error("bridge offline"));
			})
			.mockResolvedValueOnce(true);
		await render({ onSend, draftRequest: { id: 1, text: "按截图修复这个文件", images: [screenshot], attachedPaths: ["D:/owl/main.ts"], replace: true } });
		await click(t("composer.send"));
		expect(editor().textContent).toBe("按截图修复这个文件");
		expect(container.querySelector('img[src="data:image/png;base64,first-image"]')).not.toBeNull();
		expect(container.textContent).toContain("main.ts");
		await click(t("composer.send"));
		expect(onSend).toHaveBeenNthCalledWith(1, "按截图修复这个文件", [screenshot], ["D:/owl/main.ts"], undefined);
		expect(onSend).toHaveBeenNthCalledWith(2, "按截图修复这个文件", [screenshot], ["D:/owl/main.ts"], undefined);
		expect(editor().textContent).toBe("");
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).not.toContain("main.ts");
	});

	it("blocks duplicate sends during acknowledgement, leaves pause usable and preserves later typed input", async () => {
		const pending = Promise.withResolvers<boolean>();
		const onSend = vi.fn(() => pending.promise);
		const onPause = vi.fn();
		await render({ running: true, initialDraft: "原来的指令", onSend, onPause });
		await enter();
		expectNoDeliveryControls();
		expect(button(t("composer.pause")).disabled).toBe(false);
		await enter();
		await enter(true);
		await click(t("composer.pause"));
		expect(onSend).toHaveBeenCalledOnce();
		expect(onPause).toHaveBeenCalledOnce();
		await type("下一条新指令");
		await act(async () => pending.resolve(true));
		expect(editor().textContent).toBe("下一条新指令");
		await enter();
		expect(onSend).toHaveBeenCalledTimes(2);
		expect(onSend).toHaveBeenLastCalledWith("下一条新指令", undefined, undefined, "steer");
	});

	it("does not clear a draft when only its screenshot was removed during acknowledgement", async () => {
		const pending = Promise.withResolvers<boolean>();
		const onSend = vi.fn<Props["onSend"]>().mockReturnValueOnce(pending.promise).mockReturnValue(false);
		await render({ onSend, draftRequest: { id: 1, text: "保留这条要求", images: [screenshot], attachedPaths: ["D:/owl/main.ts"], replace: true } });
		await click(t("composer.send"));
		await click(composerMaterialsText("removeImage", { n: 1 }));
		await act(async () => pending.resolve(true));
		expect(editor().textContent).toBe("保留这条要求");
		await click(t("composer.send"));
		expect(onSend).toHaveBeenLastCalledWith("保留这条要求", undefined, ["D:/owl/main.ts"], undefined);
	});

	it("preserves attached materials added while an earlier submission is awaiting acknowledgement", async () => {
		const pending = Promise.withResolvers<boolean>();
		const onSend = vi.fn<Props["onSend"]>().mockReturnValueOnce(pending.promise).mockReturnValue(false);
		await render({ onSend, initialDraft: "检查实现" });
		await click(t("composer.send"));
		await render({ draftRequest: { id: 2, text: "参考这张截图", images: [secondImage], attachedPaths: ["D:/owl/new.ts"] } });
		await act(async () => pending.resolve(true));
		await click(t("composer.send"));
		expect(onSend).toHaveBeenLastCalledWith("检查实现\n\n参考这张截图", [secondImage], ["D:/owl/new.ts"], undefined);
	});

	it("does not clear a caller-owned draft after the composer has been replaced", async () => {
		const pending = Promise.withResolvers<boolean>();
		const onDraftChange = vi.fn();
		await render({ initialDraft: "切换页面前的草稿", onSend: () => pending.promise, onDraftChange });
		await click(t("composer.send"));
		await act(async () => root.render(null));
		await act(async () => pending.resolve(true));
		expect(onDraftChange).not.toHaveBeenCalled();
	});

	it("appends complete recovered drafts without dropping existing materials, and replace removes omitted materials", async () => {
		const onSend = vi.fn(() => false);
		await render({ onSend, draftRequest: { id: 1, text: "原要求", images: [screenshot], attachedPaths: ["D:/owl/main.ts"], replace: true } });
		await render({ draftRequest: { id: 2, text: "补充要求", images: [secondImage], attachedPaths: ["D:/owl/main.ts", "D:/owl/extra.ts"] } });
		await click(t("composer.send"));
		expect(onSend).toHaveBeenLastCalledWith("原要求\n\n补充要求", [screenshot, secondImage], ["D:/owl/main.ts", "D:/owl/extra.ts"], undefined);
		await render({ draftRequest: { id: 3, text: "替换要求", replace: true } });
		await click(t("composer.send"));
		expect(onSend).toHaveBeenLastCalledWith("替换要求", undefined, undefined, undefined);
	});

	it.each([false, true])("keeps void callback compatibility (asynchronous: %s)", async (asynchronous) => {
		await render({ initialDraft: "正常提交", onSend: () => asynchronous ? Promise.resolve() : undefined });
		await click(t("composer.send"));
		expect(editor().textContent).toBe("");
	});
});
