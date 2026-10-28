import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { Composer } from "./Composer.tsx";

vi.mock("../bridge/native.ts", () => ({
	listenForOsFileDrop: async () => () => {},
	readLocalImage: async () => undefined,
}));

type Props = React.ComponentProps<typeof Composer>;
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
		client: {
			request: async () => ({ ok: true, result: { isFile: true, isDirectory: false } }),
		} as unknown as BridgeClient,
		connected: true,
		disabled: false,
		running: false,
		hideEnvironment: true,
		hideMascot: false,
		onSend: vi.fn(() => true),
		onAbort: vi.fn(),
		providers: [],
		model: "fixture/model",
		onModel: vi.fn(),
		thinkingLevel: "high",
		onThinkingLevel: vi.fn(),
		approvalMode: "confirm",
		onApprovalMode: vi.fn(),
		sessionInfo: undefined,
		workspaceDir: "D:/owl",
		projects: [],
		onSwitchProject: vi.fn(),
		commands: [],
		searchFiles: async () => [],
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

function owlOnRim(): { slot: Element; hidden: boolean } {
	const slot = container.querySelector(".owl-mascot-slot");
	if (!slot) throw new Error("沿口上没有渲染吉祥物");
	return { slot, hidden: slot.className.includes("is-hidden") };
}

/** 吉祥物收起后齿轮顶上，设置入口不能跟着一起消失。 */
function gearFallback(): Element | null {
	return container.querySelector(".owl-composer-settings-fallback");
}

describe("沿口吉祥物让位", () => {
	it("没有待办时吉祥物蹲在沿口上，也不出现齿轮", async () => {
		await render();
		expect(owlOnRim().hidden).toBe(false);
		expect(gearFallback()).toBeNull();
	});

	it("有待答题卡片时收起吉祥物并由齿轮顶上", async () => {
		await render({ questionPending: true });
		expect(owlOnRim().hidden).toBe(true);
		expect(gearFallback()).not.toBeNull();
	});

	it("hideMascot 的老路径仍然生效", async () => {
		await render({ hideMascot: true });
		expect(owlOnRim().hidden).toBe(true);
		expect(gearFallback()).not.toBeNull();
	});
});
