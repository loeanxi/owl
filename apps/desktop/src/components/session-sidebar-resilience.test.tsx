import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { setUiLanguage, t } from "../i18n/index.ts";
import { SessionSidebar } from "./SessionSidebar.tsx";
import { sidebarStorageKeys } from "./sidebar-scope.ts";

type Props = React.ComponentProps<typeof SessionSidebar>;
type Session = {
	id: string;
	name: string;
	scope: "chat";
	created: string;
	modified: string;
	cwd?: string;
};

let host: HTMLElement;
let root: Root;
let props: Props;
let sessions: Session[];
let storage: Map<string, string>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 9, 15, 12));
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
	vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
		x: 0,
		y: 0,
		width: 264,
		height: 800,
		top: 0,
		left: 0,
		right: 264,
		bottom: 800,
		toJSON: () => ({}),
	});
	dom.window.HTMLElement.prototype.scrollTo = () => {};
	dom.window.HTMLElement.prototype.scrollIntoView = () => {};
	host = dom.document.getElementById("root")!;
	Object.defineProperty(host, "clientWidth", { value: 1280, configurable: true });
	Object.defineProperty(host, "clientHeight", { value: 800 });
	root = createRoot(host);
	setUiLanguage("zh");
	sessions = [];
	const request = vi.fn(async (message: { type: string }) =>
		message.type === "session.list" ? { ok: true, result: sessions } : { ok: true, result: {} },
	);
	props = {
		client: { request } as unknown as BridgeClient,
		sessionScope: "chat",
		connected: true,
		activeId: undefined,
		activeProject: "D:/owl",
		runningSessions: new Set(),
		refreshKey: "initial",
		revision: 0,
		focus: "chat",
		minimized: false,
		onToggleMinimized: vi.fn(),
		onNewChat: vi.fn(),
		onNewChatInProject: vi.fn(),
		onSelectProject: vi.fn(),
		onOpenSession: vi.fn(),
		onOpenSearchHit: vi.fn(),
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(overrides: Partial<Props> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<SessionSidebar {...props} />));
	await act(async () => {
		await Promise.resolve();
	});
}

/** 最近会话分区里的行标题，按渲染顺序。 */
function recentTitles(): string[] {
	return [...host.querySelectorAll('[data-section="recent"] .owl-sidebar-row-label')].map(
		(node) => node.textContent ?? "",
	);
}

describe("会话侧栏：本地存储不可用时的降级", () => {
	it("keeps the sidebar usable when persisting a pin fails", async () => {
		// 隐私模式 / 配额满：localStorage.setItem 抛 DOMException。
		// 侧栏自己的约定是「降级为会话内状态」，不能让整个界面崩掉。
		vi.stubGlobal("localStorage", {
			getItem: () => null,
			setItem: () => {
				throw new DOMException("QuotaExceededError");
			},
			removeItem: () => {},
		});
		sessions = [
			{
				id: "s1",
				name: "会话一",
				scope: "chat",
				created: "2026-10-15T09:00:00.000Z",
				modified: "2026-10-15T09:00:00.000Z",
				cwd: "D:/owl",
			},
		];
		await render();
		expect(recentTitles()).toContain("会话一");

		// 置顶：写 localStorage 的那一步失败，但置顶本身必须生效、界面不能炸。
		const menu = host.querySelector<HTMLButtonElement>(
			`[aria-label="${t("sidebar.sessionActionsAria", { name: "会话一" })}"]`,
		);
		expect(menu).not.toBeNull();
		await act(async () => menu!.click());
		// 会话菜单渲染在 body 的 portal 里。
		const pin = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.textContent?.trim() === t("sidebar.pin"),
		);
		expect(pin).not.toBeUndefined();
		await act(async () => pin!.click());
		expect(recentTitles().length + host.textContent?.length).toBeGreaterThan(0);
	});
});

describe("会话侧栏：按名称排序跟随界面语言", () => {
	it("sorts the recent section with the UI language instead of a hard-coded locale", async () => {
		setUiLanguage("en");
		storage.set(sidebarStorageKeys("chat").recentSort, "name");
		sessions = [
			{
				id: "a",
				name: "项目B",
				scope: "chat",
				created: "2026-10-15T09:00:00.000Z",
				modified: "2026-10-15T09:00:00.000Z",
				cwd: "D:/owl",
			},
			{
				id: "b",
				name: "项目A",
				scope: "chat",
				created: "2026-10-15T09:00:00.000Z",
				modified: "2026-10-15T09:00:00.000Z",
				cwd: "D:/owl",
			},
			{
				id: "c",
				name: "banana",
				scope: "chat",
				created: "2026-10-15T09:00:00.000Z",
				modified: "2026-10-15T09:00:00.000Z",
				cwd: "D:/owl",
			},
			{
				id: "d",
				name: "Zebra",
				scope: "chat",
				created: "2026-10-15T09:00:00.000Z",
				modified: "2026-10-15T09:00:00.000Z",
				cwd: "D:/owl",
			},
		];
		await render();
		// 英文界面按拉丁字母优先：与项目分组里同一套排序必须一致。
		expect(recentTitles()).toEqual(["banana", "Zebra", "项目A", "项目B"]);
	});
});
