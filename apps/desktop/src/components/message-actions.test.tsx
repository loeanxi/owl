import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import { MessageCopyButton, MessageMoreMenu } from "./MessageActions.tsx";
import { messageActionsText as copy } from "./message-actions-copy.ts";
import { messageElement, messageMatchRanges } from "./chat-message-navigation.ts";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let root: Root;
let host: HTMLElement;
let active: Element | null;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

class MessageRange {
	startContainer?: Node;
	startOffset = 0;
	endOffset = 0;
	setStart(node: Node, offset: number): void { this.startContainer = node; this.startOffset = offset; }
	setEnd(_node: Node, offset: number): void { this.endOffset = offset; }
	toString(): string { return this.startContainer?.textContent?.slice(this.startOffset, this.endOffset) ?? ""; }
}

beforeEach(() => {
	vi.useFakeTimers();
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
	vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	active = null;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
	dom.window.HTMLElement.prototype.focus = function (): void { active = this; };
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 32, top: 0, left: 0, right: 800, bottom: 32, toJSON: () => ({}) });
	dom.window.HTMLElement.prototype.getClientRects = function (): DOMRectList { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
	dom.window.HTMLElement.prototype.scrollIntoView = () => {};
	dom.window.getSelection = () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 0, toString: () => "" }) as unknown as Selection;
	vi.spyOn(document, "createRange").mockImplementation(() => new MessageRange() as unknown as Range);
	// The Node React renderer uses its input polyfill because it loaded before the DOM.
	Object.assign(dom.window.HTMLTextAreaElement.prototype, {
		attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
		detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
	});
	setUiLanguage("zh");
	host = dom.document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(content: React.ReactNode): Promise<void> {
	await act(async () => root.render(content));
}

async function click(button: HTMLElement): Promise<void> {
	await act(async () => button.click());
}

async function key(target: HTMLElement, value: string, shiftKey = false, isComposing = false): Promise<Event> {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value }, shiftKey: { value: shiftKey }, isComposing: { value: isComposing } });
	await act(async () => {
		if (target.tagName === "TEXTAREA") {
			target.focus();
			target.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		}
		target.dispatchEvent(event);
	});
	return event;
}

function buttonWithin(element: ParentNode, label: string): HTMLButtonElement {
	const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label);
	if (!button) throw new Error(`Missing button: ${label}`);
	return button;
}

const copyButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".owl-message-copy button")!;
const status = (): HTMLElement => host.querySelector<HTMLElement>(".owl-message-copy-status")!;
const moreTrigger = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;

describe("Acknowledged message copy", () => {
	it("copies the exact message, blocks duplicate pending clicks, and announces success only after acknowledgement", async () => {
		const pending = Promise.withResolvers<void>();
		writeText.mockReturnValueOnce(pending.promise);
		const text = '  **中文**\n\n`src/main.ts` <tag attr="value">\n\t原样保留\n';
		await render(<MessageCopyButton text={text} label="复制消息" identity="message-one" />);
		await act(async () => { copyButton().click(); copyButton().click(); });
		expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
		expect(copyButton().getAttribute("aria-busy")).toBe("true");
		expect(copyButton().disabled).toBe(true);
		expect(status().textContent).not.toBe(copy("copied"));
		await act(async () => pending.resolve());
		expect(status().textContent).toBe(copy("copied"));
		expect(status().getAttribute("role")).toBe("status");
		expect(status().getAttribute("aria-live")).toBe("polite");
		await act(async () => vi.advanceTimersByTimeAsync(2500));
		expect(status().textContent).toBe("");
	});

	it("shows a persistent failure and permits retry, including an unavailable clipboard", async () => {
		writeText.mockRejectedValueOnce(new Error("clipboard denied"));
		await render(<MessageCopyButton text="重试正文" label="复制消息" identity="message-one" />);
		await click(copyButton());
		expect(status().textContent).toBe(copy("copyFailed"));
		await act(async () => vi.advanceTimersByTimeAsync(3000));
		expect(status().textContent).toBe(copy("copyFailed"));
		await click(copyButton());
		expect(status().textContent).toBe(copy("copied"));
		expect(writeText).toHaveBeenCalledTimes(2);
		vi.stubGlobal("navigator", {});
		await render(<MessageCopyButton text="另一条正文" label="复制消息" identity="message-two" />);
		await click(copyButton());
		expect(status().textContent).toBe(copy("copyFailed"));
	});

	it("does not let an old async result overwrite another message with identical text", async () => {
		const old = Promise.withResolvers<void>();
		writeText.mockReturnValueOnce(old.promise);
		await render(<MessageCopyButton text="相同文本" label="复制消息" identity="message-one" />);
		await click(copyButton());
		await render(<MessageCopyButton text="相同文本" label="复制消息" identity="message-two" />);
		expect(status().textContent).toBe("");
		await click(copyButton());
		expect(status().textContent).toBe(copy("copied"));
		await act(async () => old.reject(new Error("late failure from old message")));
		expect(status().textContent).toBe(copy("copied"));
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	it("clears prior timers when the text changes so old feedback cannot clear a newer success", async () => {
		await render(<MessageCopyButton text="旧正文" label="复制消息" identity="same-entry" />);
		await click(copyButton());
		await act(async () => vi.advanceTimersByTimeAsync(1000));
		await render(<MessageCopyButton text="新正文" label="复制消息" identity="same-entry" />);
		expect(status().textContent).toBe("");
		await click(copyButton());
		await act(async () => vi.advanceTimersByTimeAsync(1501));
		expect(status().textContent).toBe(copy("copied"));
		await act(async () => vi.advanceTimersByTimeAsync(999));
		expect(status().textContent).toBe("");
		expect(writeText.mock.calls.map(([text]) => text)).toEqual(["旧正文", "新正文"]);
	});

	it("does not publish a detached result or retain feedback timers after unmount", async () => {
		const pending = Promise.withResolvers<void>();
		writeText.mockReturnValueOnce(pending.promise);
		await render(<MessageCopyButton text="已离开的会话" label="复制消息" identity="old-entry" />);
		await click(copyButton());
		await act(async () => root.unmount());
		root = createRoot(host);
		await render(<MessageCopyButton text="当前会话" label="复制消息" identity="new-entry" />);
		await act(async () => pending.resolve());
		expect(status().textContent).toBe("");
		expect(vi.getTimerCount()).toBe(0);
		await click(copyButton());
		expect(status().textContent).toBe(copy("copied"));
		await act(async () => root.unmount());
		expect(vi.getTimerCount()).toBe(0);
		root = createRoot(host);
	});
});

describe("Message action menu keyboard and dismissal", () => {
	it("skips disabled items with arrows, supports Home/End and restores trigger focus on Escape", async () => {
		const branch = vi.fn();
		const blocked = vi.fn();
		await render(<MessageMoreMenu label="更多消息操作" items={[
			{ id: "branch", label: "分支", onSelect: branch },
			{ id: "blocked", label: "不可用", onSelect: blocked, disabled: true },
			{ id: "another", label: "另一项", onSelect: vi.fn() },
		]} />);
		const trigger = moreTrigger();
		trigger.focus();
		await key(trigger, "ArrowDown");
		const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		expect(active).toBe(items[0]);
		await key(items[0]!, "ArrowDown");
		expect(active).toBe(items[2]);
		await key(items[2]!, "Home");
		expect(active).toBe(items[0]);
		await key(items[0]!, "End");
		expect(active).toBe(items[2]);
		await key(items[2]!, "Escape");
		expect(host.querySelector('[role="menu"]')).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(active).toBe(trigger);
		expect(branch).not.toHaveBeenCalled();
		expect(blocked).not.toHaveBeenCalled();
	});

	it("selects exactly one action with Enter or Space and closes back to the trigger", async () => {
		const branch = vi.fn();
		const regenerate = vi.fn();
		await render(<MessageMoreMenu label="更多消息操作" items={[{ id: "branch", label: "分支", onSelect: branch }, { id: "regen", label: "重新生成", onSelect: regenerate }]} />);
		const trigger = moreTrigger();
		await click(trigger);
		await key(buttonWithin(host, "分支"), "Enter");
		expect(branch).toHaveBeenCalledOnce();
		expect(regenerate).not.toHaveBeenCalled();
		expect(host.querySelector('[role="menu"]')).toBeNull();
		expect(active).toBe(trigger);
		await key(trigger, "ArrowUp");
		expect(active).toBe(buttonWithin(host, "重新生成"));
		await key(buttonWithin(host, "重新生成"), " ");
		expect(regenerate).toHaveBeenCalledOnce();
		expect(branch).toHaveBeenCalledOnce();
		expect(active).toBe(trigger);
	});

	it("dismisses on an outside pointer action without stealing focus from the clicked control", async () => {
		const branch = vi.fn();
		await render(<MessageMoreMenu label="更多消息操作" items={[{ id: "branch", label: "分支", onSelect: branch }]} />);
		const trigger = moreTrigger();
		await click(trigger);
		expect(host.querySelector('[role="menu"]')).not.toBeNull();
		const outside = document.createElement("button");
		document.body.append(outside);
		outside.focus();
		await act(async () => outside.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
		expect(host.querySelector('[role="menu"]')).toBeNull();
		expect(active).toBe(outside);
		expect(branch).not.toHaveBeenCalled();
	});

	it("lets Tab leave the menu and Shift+Tab return to its trigger using real focus transitions", async () => {
		const branch = vi.fn();
		await render(<MessageMoreMenu label="更多消息操作" items={[{ id: "branch", label: "分支", onSelect: branch }]} />);
		const trigger = moreTrigger();
		const outside = document.createElement("button");
		document.body.append(outside);
		await key(trigger, "ArrowDown");
		let item = buttonWithin(host, "分支");
		expect(item.tabIndex).toBe(-1);
		await key(item, "Tab");
		await act(async () => {
			const blur = new window.Event("focusout", { bubbles: true });
			Object.defineProperty(blur, "relatedTarget", { value: outside });
			item.dispatchEvent(blur);
			outside.focus();
			outside.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		});
		expect(host.querySelector('[role="menu"]')).toBeNull();
		expect(active).toBe(outside);
		await key(trigger, "ArrowDown");
		item = buttonWithin(host, "分支");
		await key(item, "Tab", true);
		await act(async () => {
			const blur = new window.Event("focusout", { bubbles: true });
			Object.defineProperty(blur, "relatedTarget", { value: trigger });
			item.dispatchEvent(blur);
			trigger.focus();
			trigger.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		});
		expect(host.querySelector('[role="menu"]')).toBeNull();
		expect(active).toBe(trigger);
		expect(branch).not.toHaveBeenCalled();
	});

	it("does not retain an open menu across message identity changes", async () => {
		const branch = vi.fn();
		const items = [{ id: "branch", label: "分支", onSelect: branch }];
		await render(<MessageMoreMenu label="更多消息操作" identity="message-one" items={items} />);
		await click(moreTrigger());
		expect(host.querySelector('[role="menu"]')).not.toBeNull();
		await render(<MessageMoreMenu label="更多消息操作" identity="message-two" items={items} />);
		expect(host.querySelector('[role="menu"]')).toBeNull();
		expect(moreTrigger().getAttribute("aria-expanded")).toBe("false");
		expect(branch).not.toHaveBeenCalled();
	});
});

type ChatProps = React.ComponentProps<typeof ChatStream>;
function entries(): ChatEntry[] {
	return [
		{ kind: "user", entryId: "user-entry", text: "查看 D:/project/source.ts 与原始材料", attachedPaths: ["D:/project/material.md"], images: [{ mimeType: "image/png", data: "original-image" }] },
		{ kind: "assistant", entryId: "answer-entry", text: "**原始答案**\n\n下一行", thinking: "", tools: [] },
	];
}

async function changeDraft(input: HTMLTextAreaElement, value: string): Promise<void> {
	await act(async () => {
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
		input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
}

describe("Message actions in the real chat timeline", () => {
	it("keeps copy and regenerate direct while selecting a branch only through More", async () => {
		const messages = entries();
		messages[1]!.timestamp = Date.now();
		const props: ChatProps = { entries: messages, sessionId: "session", onRegenerate: vi.fn(), onBranch: vi.fn() };
		await render(<ChatStream {...props} />);
		const footer = host.querySelector<HTMLElement>(".owl-msg-actions")!;
		const actions = [...footer.querySelectorAll<HTMLButtonElement>("button")];
		expect(actions).toHaveLength(3);
		for (const action of actions) {
			expect(action.textContent).toBe("");
			expect(action.querySelector("svg")).not.toBeNull();
			expect(action.getAttribute("title")).toBe(action.getAttribute("aria-label"));
			expect(action.getAttribute("aria-label")).toBeTruthy();
		}
		expect(footer.textContent).toBe("");
		expect(footer.title).toBe(t("chat.justNow"));
		expect(buttonWithin(footer, t("chat.msgCopy"))).toBeDefined();
		expect(buttonWithin(footer, t("chat.msgRegenerate"))).toBeDefined();
		expect([...footer.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === t("chat.msgBranch"))).toBe(false);
		await click(buttonWithin(footer, t("chat.msgCopy")));
		expect(writeText).toHaveBeenCalledExactlyOnceWith("**原始答案**\n\n下一行");
		await click(footer.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!);
		await click(buttonWithin(host, t("chat.msgBranch")));
		expect(props.onBranch).toHaveBeenCalledExactlyOnceWith("answer-entry");
		expect(props.onRegenerate).not.toHaveBeenCalled();
		await click(buttonWithin(footer, t("chat.msgRegenerate")));
		expect(props.onRegenerate).toHaveBeenCalledOnce();
	});

	it("associates edit impact with the textarea and preserves Shift+Enter, Enter submission with images, and Escape cancellation", async () => {
		const props: ChatProps = { entries: entries(), sessionId: "session", onEditMessage: vi.fn() };
		await render(<ChatStream {...props} />);
		await click(buttonWithin(host, t("chat.msgEdit")));
		let input = host.querySelector<HTMLTextAreaElement>(".owl-user-editor-input")!;
		const descriptionId = input.getAttribute("aria-describedby");
		expect(descriptionId).toBeTruthy();
		expect(document.getElementById(descriptionId!)?.textContent).toBe(copy("editImpact"));
		const shiftEnter = await key(input, "Enter", true);
		expect(shiftEnter.defaultPrevented).toBe(false);
		expect(props.onEditMessage).not.toHaveBeenCalled();
		await changeDraft(input, "修改后的任务\n保留第二行");
		const enter = await key(input, "Enter");
		expect(enter.defaultPrevented).toBe(true);
		expect(props.onEditMessage).toHaveBeenCalledExactlyOnceWith("user-entry", "修改后的任务\n保留第二行", [{ mimeType: "image/png", data: "original-image" }]);
		expect(host.querySelector("textarea")).toBeNull();
		await click(buttonWithin(host, t("chat.msgEdit")));
		input = host.querySelector<HTMLTextAreaElement>("textarea")!;
		await changeDraft(input, "这次取消");
		await key(input, "Escape");
		expect(props.onEditMessage).toHaveBeenCalledOnce();
		expect(host.querySelector("textarea")).toBeNull();
		const rejected: ChatProps = { entries: entries(), sessionId: "session", onEditMessage: vi.fn(async () => false) };
		await render(<ChatStream {...rejected} />);
		await click(buttonWithin(host, t("chat.msgEdit")));
		input = host.querySelector<HTMLTextAreaElement>("textarea")!;
		await changeDraft(input, "回退没有完成");
		await key(input, "Enter");
		expect(rejected.onEditMessage).toHaveBeenCalledOnce();
		expect(host.querySelector("textarea")).not.toBeNull();
	});

	it("keeps busy restrictions and places user actions after an intact body with attachment controls", async () => {
		const props: ChatProps = { entries: entries(), sessionId: "session", cwd: "D:/project", activity: "working", onEditMessage: vi.fn(), onRegenerate: vi.fn(), onRewind: vi.fn() };
		await render(<ChatStream {...props} />);
		expect([...host.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === t("chat.msgEdit") && !button.disabled)).toBe(false);
		expect([...host.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === t("chat.msgRegenerate") && !button.disabled)).toBe(false);
		const user = host.querySelector<HTMLElement>(".owl-user-row")!;
		const bubble = user.querySelector<HTMLElement>(".owl-user-bubble")!;
		const toolbar = user.querySelector<HTMLElement>(".owl-user-actions")!;
		expect(toolbar.getAttribute("role")).toBe("group");
		expect(toolbar.getAttribute("aria-label")).toBe(copy("userActions"));
		expect(bubble.contains(toolbar)).toBe(false);
		expect([...user.children].indexOf(bubble)).toBeLessThan([...user.children].indexOf(toolbar));
		expect(bubble.textContent).toContain("查看 D:/project/source.ts 与原始材料");
		expect(bubble.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,original-image");
		const attachment = bubble.querySelector<HTMLButtonElement>(".owl-user-file")!;
		expect(attachment.textContent).toContain("material.md");
		await click(attachment);
		expect(attachment.getAttribute("aria-expanded")).toBe("true");
		expect(props.onEditMessage).not.toHaveBeenCalled();
		expect(props.onRewind).not.toHaveBeenCalled();
		await click(buttonWithin(toolbar, t("chat.msgCopy")));
		expect(writeText).toHaveBeenCalledExactlyOnceWith("查看 D:/project/source.ts 与原始材料");
	});

	it("does not submit a composing Enter or an already-open edit after the session becomes busy", async () => {
		const props: ChatProps = { entries: entries(), sessionId: "session", onEditMessage: vi.fn() };
		await render(<ChatStream {...props} />);
		await click(buttonWithin(host, t("chat.msgEdit")));
		const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
		await changeDraft(input, "保留这份编辑草稿");
		const composing = await key(input, "Enter", false, true);
		expect(composing.defaultPrevented).toBe(false);
		expect(props.onEditMessage).not.toHaveBeenCalled();
		expect(host.querySelector("textarea")).not.toBeNull();
		await render(<ChatStream {...props} activity="working" />);
		expect(buttonWithin(host, t("chat.msgEditSend")).disabled).toBe(true);
		await key(input, "Enter");
		expect(props.onEditMessage).not.toHaveBeenCalled();
		expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留这份编辑草稿");
		await render(<ChatStream {...props} activity="idle" />);
		await key(host.querySelector<HTMLTextAreaElement>("textarea")!, "Enter");
		expect(props.onEditMessage).toHaveBeenCalledExactlyOnceWith("user-entry", "保留这份编辑草稿", [{ mimeType: "image/png", data: "original-image" }]);
	});

	it("keeps copy feedback and edit impact out of literal message search without losing body matches", async () => {
		const props: ChatProps = { entries: entries(), sessionId: "session", onEditMessage: vi.fn() };
		await render(<ChatStream {...props} />);
		const footer = host.querySelector<HTMLElement>(".owl-msg-actions")!;
		await click(buttonWithin(footer, t("chat.msgCopy")));
		expect(footer.textContent).toContain(copy("copied"));
		expect(messageMatchRanges(host, copy("copied"))).toHaveLength(0);
		expect(messageMatchRanges(host, "原始答案").map(String)).toEqual(["原始答案"]);
		const answer = messageElement(host, "answer-entry", "原始答案")!;
		expect(answer.textContent).toContain("原始答案");
		expect(answer.textContent).not.toContain(copy("copied"));
		await click(buttonWithin(host, t("chat.msgEdit")));
		expect(host.querySelector(".owl-user-edit-impact")?.textContent).toBe(copy("editImpact"));
		expect(messageMatchRanges(host, copy("editImpact"))).toHaveLength(0);
		expect(messageMatchRanges(host, "原始答案").map(String)).toEqual(["原始答案"]);
	});
});
