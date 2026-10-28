import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { Composer } from "./Composer.tsx";

vi.mock("../bridge/native.ts", () => ({
	listenForOsFileDrop: async () => () => {},
	readLocalImage: async () => undefined,
}));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null }));

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
	Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
	setUiLanguage("zh");
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
		hideMascot: true,
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
		searchFiles: async () => [],
		commands: [
			{ name: "help", kind: "builtin", description: "Show help" },
			{ name: "skill:commit", kind: "skill", description: "Commit scoped changes" },
		],
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

function command(name: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
		button.textContent?.includes(`/${name}`),
	);
}

function editor(): HTMLElement {
	return container.querySelector<HTMLElement>('[role="textbox"]')!;
}

async function key(name: string): Promise<Event> {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: name, code: name, isComposing: false });
	await act(async () => editor().dispatchEvent(event));
	return event;
}

async function type(text: string): Promise<void> {
	await act(async () => {
		editor().textContent = text;
		editor().dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

describe("Composer slash command completion", () => {
	it("offers commands after the existing Chinese request in the reported screenshot", async () => {
		await render({ initialDraft: "直接帮我提交吧 /" });
		expect(command("help")).toBeDefined();
		expect(command("skill:commit")).toBeDefined();
	});

	it.each(["click", "Tab", "Enter"])(
		"selects a trailing skill with %s, preserves the request and sends on the next Enter",
		async (action) => {
			await render({ initialDraft: "直接帮我提交吧 /skill:c" });
			expect(command("help")).toBeUndefined();
			expect(command("skill:commit")).toBeDefined();
			if (action === "click") await act(async () => command("skill:commit")!.click());
			else expect((await key(action)).defaultPrevented).toBe(true);
			expect(editor().textContent).toBe("/skill:commit 直接帮我提交吧 ");
			expect(props.onSend).not.toHaveBeenCalled();
			expect(command("skill:commit")).toBeUndefined();
			await key("Enter");
			expect(props.onSend).toHaveBeenCalledExactlyOnceWith(
				"/skill:commit 直接帮我提交吧",
				undefined,
				undefined,
				undefined,
			);
		},
	);

	it.each([
		["直接帮我提交吧 ", "/skill:commit 直接帮我提交吧 "],
		["先检查改动\n确认后提交\n", "/skill:commit 先检查改动\n确认后提交\n"],
	])("retains the text and whitespace preceding a trailing command: %j", async (prefix, expected) => {
		await render({ initialDraft: `${prefix}/skill:c` });
		expect(command("skill:commit")).toBeDefined();
		await key("Tab");
		expect(editor().textContent).toBe(expected);
	});

	it("requires another Enter after selecting a complete trailing builtin command", async () => {
		await render({ initialDraft: "核对提交方式 /help" });
		await key("Enter");
		expect(editor().textContent).toBe("/help 核对提交方式 ");
		expect(props.onSend).not.toHaveBeenCalled();
		await key("Enter");
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("/help 核对提交方式", undefined, undefined, undefined);
	});

	it("keeps leading-command completion and exact-command Enter behavior", async () => {
		await render({ initialDraft: "/he" });
		await key("Tab");
		expect(editor().textContent).toBe("/help ");
		expect(props.onSend).not.toHaveBeenCalled();
		await type("/help");
		await key("Enter");
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("/help", undefined, undefined, undefined);
	});

	it.each([
		"https://example.com/",
		"https://example.com/skill:c",
		"D:/owl/",
		"D:/owl/skill:c",
		"/usr/local/",
		"参考 /usr/local/",
		"正文/skill:c",
	])("does not open a command menu for a URL, path or slash inside a word: %s", async (text) => {
		await render({ initialDraft: text });
		expect(command("help")).toBeUndefined();
		expect(command("skill:commit")).toBeUndefined();
	});

	it("preserves inline attachment chips and sends their references after selecting a trailing skill", async () => {
		const path = "D:/owl/changed-file.ts";
		await render({ draftRequest: { id: 1, text: "核对改动", attachedPaths: [path], replace: true } });
		const chip = document.createElement("span");
		chip.className = "owl-mention-chip";
		chip.contentEditable = "false";
		chip.dataset.mentionPath = path;
		chip.textContent = "changed-file.ts";
		await act(async () => {
			editor().appendChild(chip);
			editor().appendChild(document.createTextNode(" /skill:c"));
			editor().dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(command("skill:commit")).toBeDefined();
		await key("Tab");
		expect(editor().querySelector(".owl-mention-chip")).toBe(chip);
		expect(chip.dataset.mentionPath).toBe(path);
		await key("Enter");
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("/skill:commit 核对改动", undefined, [path], undefined);
	});

	it("removes a command split across text nodes without changing the preceding file chip", async () => {
		const path = "D:/owl/changed-file.ts";
		await render({ draftRequest: { id: 1, text: "核对改动", attachedPaths: [path], replace: true } });
		const chip = document.createElement("span");
		chip.className = "owl-mention-chip";
		chip.contentEditable = "false";
		chip.dataset.mentionPath = path;
		chip.textContent = "changed-file.ts";
		const queryStart = document.createElement("span");
		queryStart.textContent = "/skill:";
		const queryEnd = document.createElement("span");
		queryEnd.textContent = "c";
		await act(async () => {
			editor().append(chip, document.createTextNode(" "), queryStart, queryEnd);
			editor().dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(command("skill:commit")).toBeDefined();
		await key("Tab");
		expect(editor().querySelector(".owl-mention-chip")).toBe(chip);
		expect(queryStart.textContent).toBe("");
		expect(queryEnd.textContent).toBe("");
		expect(editor().textContent).toBe("/skill:commit 核对改动changed-file.ts ");
		await key("Enter");
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("/skill:commit 核对改动", undefined, [path], undefined);
	});

	it.each(["BR", "DIV"])("retains a %s newline boundary while completing a trailing command", async (kind) => {
		await render();
		const prefix = document.createTextNode("先检查改动");
		const boundary = document.createElement(kind);
		const query = document.createElement("span");
		query.textContent = "/skill:c";
		await act(async () => {
			if (kind === "BR") editor().append(prefix, boundary, query);
			else {
				boundary.appendChild(prefix);
				editor().append(boundary, query);
			}
			editor().dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		expect(command("skill:commit")).toBeDefined();
		await key("Tab");
		expect(prefix.textContent).toBe("先检查改动");
		expect(editor().querySelector(kind)).toBe(boundary);
		expect(query.textContent).toBe("");
		expect(editor().textContent).toBe("/skill:commit 先检查改动");
		await key("Enter");
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith("/skill:commit 先检查改动", undefined, undefined, undefined);
	});

	it("keeps Escape dismissed until the draft changes, then offers the updated command", async () => {
		await render({ initialDraft: "直接帮我提交吧 /" });
		expect((await key("Escape")).defaultPrevented).toBe(true);
		expect(command("help")).toBeUndefined();
		expect(command("skill:commit")).toBeUndefined();
		expect(editor().textContent).toBe("直接帮我提交吧 /");
		await render();
		expect(command("help")).toBeUndefined();
		await type("直接帮我提交吧 /skill:c");
		expect(command("skill:commit")).toBeDefined();
		await key("Tab");
		expect(editor().textContent).toBe("/skill:commit 直接帮我提交吧 ");
		expect(props.onSend).not.toHaveBeenCalled();
	});
});
