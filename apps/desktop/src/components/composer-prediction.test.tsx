import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { Composer, type ComposerImage } from "./Composer.tsx";
import { composerPredictionText } from "./composer-prediction-copy.ts";

const useSuggestion = vi.hoisted(() => vi.fn());
vi.mock("../hooks/use-prompt-suggestion.ts", () => ({ usePromptSuggestion: useSuggestion }));
vi.mock("../bridge/native.ts", () => ({ listenForOsFileDrop: async () => () => {}, readLocalImage: async () => undefined }));
vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null }));

type Props = React.ComponentProps<typeof Composer>;
const nextPrompt = "把这几处改动一起构建，我看看实际效果";
const image: ComposerImage = { type: "image", mimeType: "image/png", data: "fixture-image" };
let container: HTMLElement;
let root: Root;
let props: Props;
let suggestion: string | undefined;
let enabled: boolean;
let accept: ReturnType<typeof vi.fn<() => string | undefined>>;
let dismiss: ReturnType<typeof vi.fn<() => void>>;
let setEnabled: ReturnType<typeof vi.fn<(value: boolean) => void>>;

beforeEach(() => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
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
	suggestion = nextPrompt;
	enabled = true;
	accept = vi.fn(() => { const text = suggestion; suggestion = undefined; return text; });
	dismiss = vi.fn(() => { suggestion = undefined; });
	setEnabled = vi.fn((value: boolean) => { enabled = value; if (!value) suggestion = undefined; });
	useSuggestion.mockReset().mockImplementation(() => ({ suggestion, enabled, accept, dismiss, setEnabled }));
	props = {
		client: { request: async () => ({ ok: true, result: { receipts: [] } }) } as unknown as BridgeClient,
		connected: true, disabled: false, running: false, hideEnvironment: true, hideMascot: true,
		onSend: vi.fn(() => true), onAbort: vi.fn(), onDraftChange: vi.fn(),
		providers: [], model: "fixture/model", onModel: vi.fn(), thinkingLevel: "high", onThinkingLevel: vi.fn(),
		approvalMode: "confirm", onApprovalMode: vi.fn(), sessionInfo: undefined,
		workspaceDir: "D:/owl", projects: [], onSwitchProject: vi.fn(), commands: [], searchFiles: async () => [],
		queueSessionId: "session-a", queueProfile: "profile-a", queueOwnerRevision: 1,
	};
});

afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function render(overrides: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<Composer {...props} />));
}

function editor(): HTMLElement { return container.querySelector<HTMLElement>('[role="textbox"]')!; }
function acceptButton(): HTMLButtonElement | null { return container.querySelector<HTMLButtonElement>(".owl-composer-prediction-accept"); }
async function key(name: string, modifiers: Record<string, boolean | number> = {}): Promise<Event> {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: name, code: name, isComposing: false, ...modifiers });
	await act(async () => editor().dispatchEvent(event));
	return event;
}
async function type(text: string): Promise<void> {
	await act(async () => { editor().textContent = text; editor().dispatchEvent(new window.Event("input", { bubbles: true })); });
}

describe("Composer next prompt suggestion", () => {
	it("renders a ghost suggestion without treating it as the draft, and Tab accepts without sending", async () => {
		await render();
		expect(editor().getAttribute("data-placeholder")).toBe(nextPrompt);
		expect(container.querySelector(".owl-composer-prediction-ghost")?.textContent).toBe(nextPrompt);
		expect(editor().textContent).toBe("");
		expect(container.querySelector<HTMLButtonElement>('[aria-label="' + t("composer.send") + '"]')?.disabled).toBe(true);
		expect((await key("Tab")).defaultPrevented).toBe(true);
		expect(editor().textContent).toBe(nextPrompt);
		expect(props.onDraftChange).toHaveBeenCalledExactlyOnceWith(nextPrompt);
		expect(props.onSend).not.toHaveBeenCalled();
		expect(acceptButton()).toBeNull();
	});

	it("first Enter only fills the draft; the next Enter sends the accepted text", async () => {
		await render();
		expect((await key("Enter")).defaultPrevented).toBe(true);
		expect(editor().textContent).toBe(nextPrompt);
		expect(props.onSend).not.toHaveBeenCalled();
		await key("Enter");
		expect(props.onSend).toHaveBeenCalledExactlyOnceWith(nextPrompt, undefined, undefined, undefined);
	});

	it.each(["ArrowRight", "button"])("accepts with %s without submitting", async (action) => {
		await render();
		if (action === "button") await act(async () => acceptButton()!.click());
		else expect((await key(action)).defaultPrevented).toBe(true);
		expect(editor().textContent).toBe(nextPrompt);
		expect(accept).toHaveBeenCalledOnce();
		expect(props.onSend).not.toHaveBeenCalled();
	});

	it("Escape dismisses the suggestion and restores the normal placeholder", async () => {
		await render();
		expect((await key("Escape")).defaultPrevented).toBe(true);
		expect(dismiss).toHaveBeenCalledOnce();
		await render();
		expect(editor().getAttribute("data-placeholder")).toBe(t("composer.inputPlaceholder"));
		expect(editor().textContent).toBe("");
		expect(props.onDraftChange).not.toHaveBeenCalled();
	});

	it("typing hides the suggestion immediately and later results never replace the user's draft", async () => {
		await render();
		await type("我自己补充要求");
		expect(acceptButton()).toBeNull();
		suggestion = "新的延迟建议";
		await render();
		expect((await key("Tab")).defaultPrevented).toBe(false);
		expect(editor().textContent).toBe("我自己补充要求");
		expect(accept).not.toHaveBeenCalled();
		expect(useSuggestion).toHaveBeenLastCalledWith(expect.objectContaining({ eligible: false }));
	});

	it("protects text typed in the DOM before its input event reaches React", async () => {
		await render();
		editor().textContent = "尚未提交的输入";
		expect((await key("Tab")).defaultPrevented).toBe(false);
		expect(editor().textContent).toBe("尚未提交的输入");
		expect(accept).not.toHaveBeenCalled();
	});

	it("dismisses an already visible suggestion even when the user only types a space", async () => {
		useSuggestion.mockImplementation(function useVisibleFixtureSuggestion() {
			const [visible, setVisible] = React.useState(true);
			return { suggestion: visible ? suggestion : undefined, enabled, accept, setEnabled, dismiss: () => { dismiss(); setVisible(false); } };
		});
		await render();
		await type(" ");
		expect(dismiss).toHaveBeenCalledOnce();
		expect(acceptButton()).toBeNull();
		expect(editor().textContent).toBe(" ");
		expect(accept).not.toHaveBeenCalled();
	});

	it("cancels pending prediction work on whitespace input before a suggestion is ready", async () => {
		suggestion = undefined;
		await render();
		await type(" ");
		expect(dismiss).toHaveBeenCalledOnce();
		expect(acceptButton()).toBeNull();
		expect(editor().textContent).toBe(" ");
		expect(props.onSend).not.toHaveBeenCalled();
	});

	it.each([
		{ initialDraft: "已有草稿" },
		{ initialDraft: " " },
		{ draftRequest: { id: 1, text: "", images: [image], replace: true } },
		{ draftRequest: { id: 1, text: "", attachedPaths: ["D:/owl/notes.md"], replace: true } },
	])("does not offer or accept a suggestion over existing input or materials: %j", async (draft) => {
		await render(draft);
		expect(acceptButton()).toBeNull();
		expect((await key("Tab")).defaultPrevented).toBe(false);
		expect(accept).not.toHaveBeenCalled();
		expect(useSuggestion).toHaveBeenLastCalledWith(expect.objectContaining({ eligible: false }));
	});

	it.each([
		{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true },
	])("leaves modified or composing Tab untouched: %j", async (modifiers) => {
		await render();
		expect((await key("Tab", modifiers)).defaultPrevented).toBe(false);
		expect(accept).not.toHaveBeenCalled();
		expect(props.onSend).not.toHaveBeenCalled();
	});

	it("ignores candidate-selection keys while an IME composition is active", async () => {
		await render();
		// Linkedom has no CompositionEvent; React uses the platform's keyCode 229 fallback.
		await key("Process", { keyCode: 229 });
		expect((await key("Tab", { keyCode: 229 })).defaultPrevented).toBe(false);
		expect((await key("ArrowRight", { keyCode: 229 })).defaultPrevented).toBe(false);
		expect((await key("Enter", { keyCode: 229 })).defaultPrevented).toBe(false);
		expect(accept).not.toHaveBeenCalled();
		expect(props.onSend).not.toHaveBeenCalled();
	});

	it("checks ownership again before adoption when navigation starts ahead of React", async () => {
		let current = true;
		await render({ queueIsCurrent: () => current });
		current = false;
		expect((await key("Tab")).defaultPrevented).toBe(false);
		expect(accept).not.toHaveBeenCalled();
		expect(editor().textContent).toBe("");
	});

	it.each([
		{ disabled: true }, { connected: false }, { running: true }, { paused: true },
		{ modelSelection: { status: "pending" as const, target: "fixture/next", actual: "fixture/model", running: false } },
	])("hides suggestions when the composer cannot safely adopt one: %j", async (state) => {
		await render(state);
		expect(acceptButton()).toBeNull();
		expect((await key("Tab")).defaultPrevented).toBe(false);
		expect(accept).not.toHaveBeenCalled();
	});

	it("keeps slash selection ahead of prompt suggestions", async () => {
		await render({ commands: [{ name: "help", kind: "builtin", description: "Show help" }], initialDraft: "/he" });
		await key("Tab");
		expect(editor().textContent).toBe("/help ");
		expect(accept).not.toHaveBeenCalled();
	});

	it("exposes the preference in existing settings and uses translated controls", async () => {
		await render();
		const settings = container.querySelector<HTMLButtonElement>(".owl-composer-settings-fallback")!;
		await act(async () => settings.click());
		const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
		expect(toggle.getAttribute("aria-label")).toBe("下一句建议");
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		await act(async () => toggle.click());
		expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
		await render();
		expect(acceptButton()).toBeNull();
		await act(async () => setUiLanguage("en"));
		expect(container.querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("Suggested next prompt");
		expect(composerPredictionText("accept")).toBe("Accept suggested prompt");
	});
});
