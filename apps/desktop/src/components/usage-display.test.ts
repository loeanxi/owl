import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";
import { ContextRequestUsage } from "./ContextView.tsx";

vi.mock("../i18n/index.ts", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../i18n/index.ts");
	return { ...actual, useT: () => actual.t };
});

afterEach(() => {
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

describe("turn usage display", () => {
	it("shows one request's total input including cache separately from output", () => {
		const html = renderToStaticMarkup(createElement(ContextRequestUsage, {
			usage: { input: 20, output: 7, cacheRead: 70, cacheWrite: 10 },
		}));
		expect(html).toContain("本次输入 100");
		expect(html).toContain("未缓存 20");
		expect(html).toContain("缓存读 70");
		expect(html).toContain("缓存写 10");
		expect(html).toContain("本次输出 7");
	});

	it("counts every assistant call once, includes cache tokens, and resets on the next user turn", () => {
		vi.stubGlobal("document", { documentElement: { dataset: {} } });
		const assistant = (text: string): ChatEntry => ({
			kind: "assistant", text, thinking: "", tools: [],
			usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 5 },
		});
		const entries: ChatEntry[] = [
			{ kind: "user", text: "first" },
			assistant(""),
			assistant("answer"),
			{ kind: "user", text: "second" },
			assistant("next answer"),
		];
		const html = renderToStaticMarkup(createElement(ChatStream, { entries }));
		expect(html).toContain("本轮累计 200 tok（含缓存） · 2 次调用");
		expect(html).toContain("本轮累计 100 tok（含缓存） · 1 次调用");
		expect(html).toContain("未缓存输入 20");
		expect(html).toContain("缓存读 160");
		setUiLanguage("en");
		const english = renderToStaticMarkup(createElement(ChatStream, { entries }));
		expect(english).toContain("Turn total 200 tok (including cache) · 2 calls");
	});
});
