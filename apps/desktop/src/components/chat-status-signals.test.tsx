import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { windowTitle } from "../utils/window-title.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("./OwlMascot.tsx", () => ({ OwlMascot: () => null, useSessionOwlPose: () => "idle" }));

let container: HTMLElement;
let root: Root;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Element", dom.window.Element); vi.stubGlobal("Node", dom.window.Node); vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
	vi.stubGlobal("requestAnimationFrame", () => 0); vi.stubGlobal("cancelAnimationFrame", () => {});
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	setUiLanguage("zh");
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const rendered = (): HTMLElement => [...container.querySelectorAll<HTMLElement>(".owl-chat-error")].at(-1)!;

describe("window title by activity", () => {
	it("prefers waiting over working and counts parallel sessions", () => {
		expect(windowTitle(true, 3)).toBe(`${t("app.titleWaiting")} · owl`);
		expect(windowTitle(false, 1)).toBe(`${t("app.titleWorking")} · owl`);
		expect(windowTitle(false, 3)).toBe(`${t("app.titleWorkingMany", { n: 3 })} · owl`);
		expect(windowTitle(false, 0)).toBe("owl");
	});
	it("marks background outcomes and lets them ride along with the activity suffix", () => {
		expect(windowTitle(false, 0, "done")).toBe(`${t("app.titleDone")} · owl`);
		expect(windowTitle(false, 0, "error")).toBe(`${t("app.titleFailed")} · owl`);
		expect(windowTitle(false, 0, "waiting")).toBe(`${t("app.titleWaiting")} · owl`);
		// 后台完成 + 另一会话还在跑：前缀与后缀并存。
		expect(windowTitle(false, 1, "done")).toBe(`${t("app.titleDone")} · ${t("app.titleWorking")} · owl`);
	});
});

describe("assistant error row", () => {
	it("keeps the message readable and adds copy plus a relative time", async () => {
		const at = Date.now() - 5 * 60_000;
		const entries: ChatEntry[] = [
			{ kind: "user", text: "推进", entryId: "u1", timestamp: at - 1000 },
			{ kind: "assistant", text: "", thinking: "", tools: [], entryId: "a1", error: "额度或限流：429 too many requests（req-1234）", timestamp: at, endedAt: at + 500 },
		];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		const row = rendered();
		expect(row.querySelector(".owl-chat-error-text")?.textContent).toContain("req-1234");
		expect(row.getAttribute("role")).toBe("alert");
		// 相对时间与全文时间戳都在。
		expect(row.querySelector(".owl-chat-error-time")?.textContent).toBe(t("chat.minutesAgo", { n: 5 }));
		expect(row.querySelector(".owl-chat-error-time")?.getAttribute("title")).toContain(new Date(at).toLocaleString("zh-CN").slice(0, 4));
		// 复制按钮携带完整错误文本。
		const copy = row.querySelector<HTMLButtonElement>(".owl-message-copy button");
		expect(copy?.getAttribute("aria-label")).toBe(t("chat.errorCopy"));
	});

	it("stays plain for rows without a timestamp", async () => {
		const entries: ChatEntry[] = [{ kind: "assistant", text: "", thinking: "", tools: [], entryId: "a2", error: "旧错误" }];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		expect(rendered().querySelector(".owl-chat-error-time")).toBeNull();
	});
});

describe("user bubble time", () => {
	it("shows the sent time on hover like the answer footer does", async () => {
		const at = Date.now() - 2 * 3600_000;
		const entries: ChatEntry[] = [{ kind: "user", text: "看看进展", entryId: "u9", timestamp: at }];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		const bubble = container.querySelector<HTMLElement>(".owl-user-bubble")!;
		expect(bubble.getAttribute("title")).toBe(t("chat.hoursAgo", { n: 2 }));
	});
});
