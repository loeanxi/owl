import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GenuiToolCardView } from "../../../../apps/desktop/src/components/Genui.tsx";
import { renderGenuiFence } from "../fence-render.tsx";
import { GenuiBlock } from "../GenuiBlock.tsx";
import { setLocale } from "../i18n/index.ts";

describe("unrenderable owl-ui recovery presentation", () => {
	it("keeps an oversized grid span within its declared columns", () => {
		const markup = renderToStaticMarkup(
			createElement(GenuiBlock, {
				spec: {
					items: [{ type: "grid", cols: 2, items: [{ type: "text", content: "Wide content", span: 6 }] }],
				},
			}),
		);
		expect(markup).toContain("grid-column:span 2");
		expect(markup).not.toContain("grid-column:span 6");
	});

	it("guards persisted tool UI content through the same recovery path", () => {
		setLocale("zh");
		const markup = renderToStaticMarkup(
			createElement(GenuiToolCardView, {
				card: {
					id: "invalid-saved-tool",
					name: "render_ui",
					args: "{}",
					summary: "界面",
					status: "ok",
					output: { text: "", totalLines: 0, genuiSpec: { items: [{ type: "list", items: 42 }] } },
				},
			}),
		);
		expect(markup).toContain("data-genui-fallback");
		expect(markup).toContain("这部分交互内容暂时无法显示");
	});

	it("keeps invalid content behind collapsed details instead of a raw JSON slab", () => {
		setLocale("zh");
		const raw = JSON.stringify({ items: [{ type: "list", items: 42 }] });
		const markup = renderToStaticMarkup(renderGenuiFence(raw, "broken-list"));
		expect(markup).toContain("data-genui-fallback");
		expect(markup).toContain("这部分交互内容暂时无法显示");
		expect(markup).toMatch(/<details(?:\s[^>]*)?>/);
		expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
		expect(markup.indexOf("requires items")).toBeGreaterThan(markup.indexOf("<details"));
		expect(markup).toContain("\n  &quot;items&quot;");
	});

	it("retains malformed source in the expandable fallback and localizes its summary", () => {
		setLocale("en");
		const raw = 'broken <script>alert("x")</script>';
		const markup = renderToStaticMarkup(renderGenuiFence(raw, "broken-json"));
		expect(markup).toContain("This interactive content could not be displayed");
		expect(markup).toContain("View details and original content");
		expect(markup).toContain("broken &lt;script&gt;");
		expect(markup).not.toContain("<script>alert");
		setLocale("zh");
	});
});
