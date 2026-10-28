import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { Composer } from "./Composer.tsx";

vi.mock("../bridge/native.ts", () => ({
	listenForOsFileDrop: async () => () => {},
	readLocalImage: async () => undefined,
}));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

type Props = React.ComponentProps<typeof Composer>;
let root: Root;
let container: HTMLElement;
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
	HTMLElement.prototype.scrollIntoView = () => {};
	dom.window.getSelection = () => null;
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	props = {
		client: { request: () => Promise.resolve({ ok: true, result: { receipts: [] } }) } as unknown as BridgeClient,
		connected: true,
		disabled: false,
		running: false,
		hideEnvironment: true,
		hideMascot: true,
		onSend: vi.fn(() => false),
		onAbort: vi.fn(),
		providers: [],
		model: "fixture/model",
		onModel: vi.fn(),
		thinkingLevel: "high",
		onThinkingLevel: vi.fn(),
		approvalMode: "confirm",
		onApprovalMode: vi.fn(),
		workspaceDir: "D:/project",
		queueProfile: "profile-a",
		queueSessionId: "session-a",
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
async function render(patch: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...patch };
	await act(async () => root.render(<Composer {...props} />));
}
const editor = (): HTMLElement => container.querySelector<HTMLElement>('[role="textbox"]')!;
async function key(keyValue: string, shiftKey = false): Promise<void> {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperties(event, { key: { value: keyValue }, shiftKey: { value: shiftKey } });
		editor().dispatchEvent(event);
	});
}

describe("sent-input recall", () => {
	it("recalls the newest send on ArrowUp from an empty editor and walks back with ArrowDown", async () => {
		// 约定最新在前（App 侧已倒序）；连续重复只留一条。
		await render({ sentHistory: ["第二条\n多行", "第一条", "第一条"] });
		expect(editor().textContent).toBe("");
		await key("ArrowUp");
		expect(editor().textContent).toBe("第二条\n多行");
		await key("ArrowUp");
		expect(editor().textContent).toBe("第一条");
		// 到头再按保持不动。
		await key("ArrowUp");
		expect(editor().textContent).toBe("第一条");
		await key("ArrowDown");
		expect(editor().textContent).toBe("第二条\n多行");
		await key("ArrowDown");
		// 走过最新一条：编辑器清空、退出召回。
		expect(editor().textContent).toBe("");
	});

	it("exits recall on any other key so typed text survives", async () => {
		await render({ sentHistory: ["旧输入"] });
		await key("ArrowUp");
		expect(editor().textContent).toBe("旧输入");
		// 有内容时 ↑ 不再接管（光标行为交还编辑器）。
		await key("ArrowUp");
		expect(editor().textContent).toBe("旧输入");
	});

	it("does not take over when the mention or slash menu is open", async () => {
		await render({ sentHistory: ["旧输入"], commands: [{ name: "model", description: "切换模型" }] });
		await act(async () => {
			editor().textContent = "";
			editor().dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		// 斜杠菜单开着时 ↑ 归菜单导航，不召回。
		await act(async () => {
			editor().textContent = "/";
			editor().dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await key("ArrowUp");
		expect(editor().textContent).toContain("/");
	});
});

describe("context tank readability", () => {
	it("exposes tiered value text instead of an anonymous gauge", async () => {
		const stats = (percent: number) =>
			({ contextUsage: { percent }, availableThinkingLevels: ["high"] }) as unknown as Props["sessionInfo"];
		// 未上报时无表。
		await render();
		expect(container.querySelector(".owl-context-tank")).toBeNull();
		// 正常档：可读文案只报数字。
		await render({ sessionInfo: stats(40) });
		const tank = container.querySelector<HTMLElement>(".owl-context-tank")!;
		expect(tank.getAttribute("role")).toBe("meter");
		expect(tank.getAttribute("aria-valuenow")).toBe("40");
		expect(tank.getAttribute("aria-valuetext")).toBe(t("context.level", { n: 40 }));
		expect(tank.getAttribute("title")).toContain(t("context.levelHint"));
		// 偏满档（≥60）与临限档（≥85）换更严重的结论句。
		await render({ sessionInfo: stats(72) });
		expect(container.querySelector(".owl-context-tank")?.getAttribute("aria-valuetext")).toBe(
			t("context.levelWarn", { n: 72 }),
		);
		await render({ sessionInfo: stats(90) });
		expect(container.querySelector(".owl-context-tank")?.getAttribute("aria-valuetext")).toBe(
			t("context.levelDanger", { n: 90 }),
		);
	});
});
