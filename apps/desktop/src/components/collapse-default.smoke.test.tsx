import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolCard } from "../hooks/transcript.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ChatStream } from "./ChatStream.tsx";

vi.mock("../i18n/index.ts", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../i18n/index.ts");
	return { ...actual, useT: () => actual.t };
});

afterEach(() => {
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

const failedTool = (id: string): ToolCard => ({
	id,
	name: "bash",
	args: "{}",
	summary: "会失败的命令",
	detail: "secret-detail-text",
	status: "error",
	output: { text: "secret-output-text", totalLines: 1 },
});

describe("work process stays collapsed by default", () => {
	it("keeps the work row and every failed tool inside it collapsed until clicked", () => {
		vi.stubGlobal("document", { documentElement: { dataset: {} } });
		const entries: ChatEntry[] = [
			{ kind: "user", text: "q" },
			{
				kind: "assistant",
				text: "",
				thinking: "",
				tools: [failedTool("t1"), failedTool("t2")],
				segments: [
					{ kind: "tool", toolId: "t1" },
					{ kind: "tool", toolId: "t2" },
				],
			},
			{ kind: "assistant", text: "", thinking: "", tools: [], segments: [{ kind: "text", text: "最终回答" }] },
		];
		const html = renderToStaticMarkup(createElement(ChatStream, { entries }));
		// 工作过程行默认收起：摘要可见 + 失败计数标红，但内容不可见
		expect(html).toContain("工作过程 · 2 步");
		expect(html).toContain("2 个失败");
		expect(html).not.toContain("secret-detail-text");
		expect(html).not.toContain("secret-output-text");
		// 折叠区内容是条件渲染：内部工具组根本不挂载，全页只有工作过程行自己的收起按钮
		expect(html.match(/aria-expanded="false"/g)?.length).toBe(1);
		expect(html).not.toContain('aria-expanded="true"');
		expect(html).toContain("最终回答");
	});
});
