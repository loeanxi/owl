import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import { setUiLanguage } from "../../i18n/index.ts";
import type { SidebarApi, TabComponentProps } from "../registry.ts";
import type { SidebarStore } from "../store.ts";
import { FilesTab } from "./FilesTab.tsx";

let container: HTMLElement;
let root: Root;
let storage: Map<string, string>;

function entry(name: string, isDir: boolean, hidden = false) {
	return { name, path: name, isDir, hidden, isSymlink: false, broken: false };
}

function makeProps(): TabComponentProps {
	// useSyncExternalStore 要求快照引用稳定：state 必须是同一个对象。
	const state = { expanded: new Set<string>() };
	const store = {
		subscribe: () => () => {},
		getState: () => state,
		toggleExpanded: vi.fn(),
		expandTo: vi.fn(),
		remapPath: vi.fn(),
		onFsChanged: () => () => {},
	} as unknown as SidebarStore;
	const api = {
		fsTree: vi.fn(async () => ({
			entries: [entry(".pi", true, true), entry("owl-re-v1", true), entry("README.md", false)],
		})),
		fsSearch: vi.fn(async () => []),
		watchSet: vi.fn(async () => {}),
	} as unknown as SidebarApi;
	return {
		api,
		store,
		cwd: "D:/project",
		tab: { kind: "files", title: "文件" } as TabComponentProps["tab"],
		client: { onStatus: () => () => {} } as unknown as BridgeClient,
		onOpenFile: vi.fn(),
		gitStatus: undefined,
		onGitRefresh: vi.fn(),
	};
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// FileIcon 的图标包探测用 MutationObserver 观察挂载点，linkedom 没有，给空实现。
	vi.stubGlobal("MutationObserver", class {
		observe() {}
		disconnect() {}
		takeRecords() { return []; }
	});
	storage = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	await act(async () => root.render(<FilesTab {...makeProps()} />));
	// 首层 fsTree 异步落地后再断言
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("FilesTab hidden entries filter", () => {
	it("hides dot entries by default and reveals them through the eye toggle", async () => {
		await render();
		expect(container.textContent).not.toContain(".pi");
		expect(container.textContent).toContain("owl-re-v1");
		const toggle = container.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
		expect(toggle.getAttribute("title")).toBe("显示点开头的隐藏项");
		await act(async () => toggle.click());
		expect(container.textContent).toContain(".pi");
		expect(toggle.getAttribute("title")).toBe("隐藏点开头的隐藏项");
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(storage.get("owl.files.showHidden")).toBe("true");
	});

	it("restores the last choice from storage on the next mount", async () => {
		storage.set("owl.files.showHidden", "true");
		await render();
		expect(container.textContent).toContain(".pi");
		expect(container.querySelector<HTMLButtonElement>("button[aria-pressed]")?.getAttribute("aria-pressed")).toBe("true");
	});
});
