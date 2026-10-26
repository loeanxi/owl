import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
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

const clock = (at: number): string => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const gaps = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(".owl-chat-time-gap")];

function turn(userAt: number, assistantEnd: number): ChatEntry[] {
	return [
		{ kind: "user", text: "推进", entryId: `u-${userAt}`, timestamp: userAt },
		{ kind: "assistant", text: "完成", thinking: "", tools: [], entryId: `a-${userAt}`, timestamp: userAt + 1000, endedAt: assistantEnd },
	];
}

describe("turn time-gap dividers", () => {
	it("marks only turns separated by ten minutes or more", async () => {
		const now = Date.now();
		const base = now - 60 * 60_000;
		const entries: ChatEntry[] = [
			...turn(base, base + 20_000),
			// 紧跟着的下一轮（间隔 10 秒）：不打扰。
			...turn(base + 30_000, base + 40_000),
			// 隔了 40 分钟的新一轮：插分隔线。
			...turn(base + 40 * 60_000, base + 40 * 60_000 + 5_000),
		];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		expect(gaps()).toHaveLength(1);
		expect(gaps()[0]!.textContent).toBe(clock(base + 40 * 60_000));
		// 悬停给完整本地时间。
		expect(gaps()[0]!.getAttribute("title")).toBe(new Date(base + 40 * 60_000).toLocaleString("zh-CN"));
	});

	it("prefixes yesterday and full dates beyond that, and stays quiet without timestamps", async () => {
		const now = Date.now();
		const today = new Date(now); today.setHours(0, 0, 0, 0);
		const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
		const entries: ChatEntry[] = [
			...turn(yesterday.getTime() + 3600_000, yesterday.getTime() + 3600_000 + 5_000),
			// 同在昨天但只隔 1 分钟：不插线。
			{ kind: "user", text: "追问", entryId: "u2", timestamp: yesterday.getTime() + 3660_000 },
		];
		await act(async () => root.render(<ChatStream entries={entries} sessionId="session" cwd="D:/project" />));
		expect(gaps()).toHaveLength(0);
		const older: ChatEntry[] = [
			...turn(yesterday.getTime() + 3600_000, yesterday.getTime() + 3600_000 + 5_000),
			{ kind: "user", text: "隔天再问", entryId: "u3", timestamp: today.getTime() + 7200_000 },
		];
		await act(async () => root.render(<ChatStream entries={older} sessionId="session" cwd="D:/project" />));
		expect(gaps()).toHaveLength(1);
		// 新一轮落在今天（刚过午夜）：只写时刻，不加前缀。
		expect(gaps()[0]!.textContent).toBe(clock(today.getTime() + 7200_000));
		// 新一轮落在昨天：带「昨天」前缀。
		const dayBefore = new Date(yesterday); dayBefore.setDate(dayBefore.getDate() - 1);
		const dayBeforeTurn: ChatEntry[] = [
			...turn(dayBefore.getTime() + 3600_000, dayBefore.getTime() + 3600_000 + 5_000),
			{ kind: "user", text: "次日再问", entryId: "u4", timestamp: yesterday.getTime() + 7200_000 },
		];
		await act(async () => root.render(<ChatStream entries={dayBeforeTurn} sessionId="session" cwd="D:/project" />));
		expect(gaps()).toHaveLength(1);
		expect(gaps()[0]!.textContent).toBe(`${t("sidebar.yesterday")} ${clock(yesterday.getTime() + 7200_000)}`);
		// 没有时间戳的旧会话：宁缺毋假，一条线都不出。
		const blind: ChatEntry[] = [
			{ kind: "user", text: "旧会话一", entryId: "b1" },
			{ kind: "assistant", text: "旧回复", thinking: "", tools: [], entryId: "b2" },
			{ kind: "user", text: "旧会话二", entryId: "b3" },
		];
		await act(async () => root.render(<ChatStream entries={blind} sessionId="session" cwd="D:/project" />));
		expect(gaps()).toHaveLength(0);
	});
});
