import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import { setUiLanguage, t } from "../../i18n/index.ts";
import { createSidebarApi } from "../api.ts";
import { HistoryView } from "./HistoryView.tsx";

let root: Root;
let container: HTMLElement;

const NOW = Math.floor(Date.now() / 1000);

function entry(hash: string, subject: string, author: string, minutesAgo: number) {
	return {
		hash,
		short: hash.slice(0, 7),
		subject,
		author,
		email: `${author}@example.com`,
		time: NOW - minutesAgo * 60,
		parents: [hash.slice(0, 7)],
		refs: [],
	};
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setUiLanguage("zh");
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderHistory(entries: ReturnType<typeof entry>[]): Promise<void> {
	const client = {
		request: vi.fn(async (request: { type: string }) => {
			if (request.type === "git.history") {
				return { ok: true, result: { entries, hasMore: false, ahead: 0, behind: 0, canPublish: false } };
			}
			if (request.type === "git.checks") return { ok: true, result: [] };
			return { ok: true, result: {} };
		}),
		onStatus: vi.fn(() => () => {}),
	} as unknown as BridgeClient;
	await act(async () =>
		root.render(
			<HistoryView
				api={createSidebarApi(client)}
				cwd="D:/project"
				repos={[]}
				modeSwitch={null}
				statusVersion={undefined}
				onGitRefresh={vi.fn()}
			/>,
		),
	);
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("变更历史列表", () => {
	it("提交行直接显示作者名，不只留一个字母圆点", async () => {
		await renderHistory([
			entry("a1b2c3d4e5f6a1b2", "feat: 加个分组与说明", "张伟", 10),
			entry("b2c3d4e5f6a1b2c3", "fix: 修一下", "李娜", 40),
		]);
		const text = container.textContent ?? "";
		expect(text).toContain("张伟");
		expect(text).toContain("李娜");
		// 作者名带完整姓名的悬停提示（邮箱也在里面）。
		const named = [...container.querySelectorAll<HTMLElement>("[title]")].filter(
			(el) => el.getAttribute("title") === "张伟",
		);
		expect(named.length).toBeGreaterThan(0);
	});

	it("范围下拉的无障碍名说的是范围本身，不是第一个选项", async () => {
		await renderHistory([entry("a1b2c3d4e5f6a1b2", "feat: 加个分组与说明", "张伟", 10)]);
		const select = container.querySelector<HTMLSelectElement>("select")!;
		expect(select.getAttribute("aria-label")).toBe(t("history.scopeLabel"));
		expect(select.getAttribute("aria-label")).not.toBe(t("history.scopeCurrent"));
	});
});
