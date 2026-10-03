import { describe, expect, it } from "vitest";
import { isRenderableProcess, processGenuiSpec } from "../client/guard.ts";
import { resolveFenceSpec } from "../client/shared/fence-resolve.ts";

const capturedFence = {
	gap: 10,
	items: [
		{
			content: "☉ 网页地址：单个播放页或一个栏目列表页都行",
			title: "开始前需要你提供",
			type: "list",
		},
	],
};

describe("list prose recovery", () => {
	it("renders the captured list content and preserves its heading", () => {
		const processed = processGenuiSpec(capturedFence);

		expect(processed.errors).toEqual([]);
		expect(isRenderableProcess(processed)).toBe(true);
		expect(processed.spec).toEqual({
			gap: 10,
			items: [
				{
					type: "card",
					title: "开始前需要你提供",
					items: [{ type: "list", items: ["☉ 网页地址：单个播放页或一个栏目列表页都行"] }],
				},
			],
		});
		expect(processed.declaredNativeCount).toBe(processed.renderedNativeCount);
	});

	it("recovers a text-only list without guessing new line boundaries", () => {
		const processed = processGenuiSpec({
			items: [{ type: "list", text: "第一行\n\n第二行\r\n  缩进" }],
		});

		expect(processed.errors).toEqual([]);
		expect(isRenderableProcess(processed)).toBe(true);
		expect(processed.spec?.items).toEqual([{ type: "list", items: ["第一行\n\n第二行\r\n  缩进"] }]);
	});

	it("renders the captured raw JSON through the completed fence entry point", () => {
		const spec = resolveFenceSpec(JSON.stringify(capturedFence), { settled: true });

		expect(spec).toEqual({
			gap: 10,
			items: [
				{
					type: "card",
					title: "开始前需要你提供",
					items: [{ type: "list", items: ["☉ 网页地址：单个播放页或一个栏目列表页都行"] }],
				},
			],
		});
	});

	it.each([
		{ label: "populated", items: ["已声明的条目"] },
		{ label: "empty", items: [] },
	])("keeps $label canonical items ahead of conflicting prose", ({ items }) => {
		const processed = processGenuiSpec({ items: [{ type: "list", items, content: "冲突正文", text: "冲突文本" }] });

		expect(isRenderableProcess(processed)).toBe(true);
		expect(processed.spec?.items).toEqual([{ type: "list", items }]);
	});

	it.each([null, "not an array", 42, {}])("does not replace malformed explicit items: %j", (items) => {
		const processed = processGenuiSpec({ items: [{ type: "list", items, content: "已有正文也不能覆盖 items" }] });

		expect(isRenderableProcess(processed)).toBe(false);
		expect(processed.errors).toContain("items[0]: type 'list' requires items (array)");
	});

	it.each([undefined, null, "", " \n\t", 42, {}, []])(
		"does not fabricate entries from unrecoverable prose: %j",
		(content) => {
			const processed = processGenuiSpec({ items: [{ type: "list", title: "只有标题", content }] });

			expect(isRenderableProcess(processed)).toBe(false);
			expect(processed.renderedNativeCount).toBe(0);
			expect(processed.errors).toContain("repair dropped 1 declared native node(s): declared 1, rendered 0");
		},
	);

	it("does not turn malformed titles into invented strings", () => {
		const processed = processGenuiSpec({ items: [{ type: "list", title: { text: "标题" }, content: "正文" }] });
		expect(isRenderableProcess(processed)).toBe(false);
	});

	it("preserves an ordinary valid list without adding a container", () => {
		const original = {
			items: [{ type: "list", filter: "query", items: ["第一项", { title: "第二项", desc: "说明" }] }],
		};
		const processed = processGenuiSpec(original);

		expect(processed.errors).toEqual([]);
		expect(isRenderableProcess(processed)).toBe(true);
		expect(processed.spec).toEqual(original);
	});

	it("keeps native validation and unsafe-node rejection after recovery", () => {
		const invalidFilter = processGenuiSpec({ items: [{ type: "list", content: "正文", filter: 42 }] });
		expect(isRenderableProcess(invalidFilter)).toBe(false);
		expect(invalidFilter.errors.some((error) => error.includes("filter"))).toBe(true);

		const unsafeNode = processGenuiSpec({
			items: [
				{ type: "list", content: "不能替换不安全的条目", items: [{ type: "image", src: "javascript:alert(1)" }] },
			],
		});
		expect(isRenderableProcess(unsafeNode)).toBe(false);
		expect(unsafeNode.errors.some((error) => error.startsWith("repair dropped "))).toBe(true);

		const unsafeLink = processGenuiSpec({
			items: [
				{
					type: "list",
					content: "不能替换已有条目",
					items: [{ type: "link", label: "链接", href: "javascript:alert(1)" }],
				},
			],
		});
		expect(unsafeLink.spec?.items).toEqual([{ type: "list", items: [{ type: "link", label: "链接" }] }]);
	});

	it("preserves bare-root routing and is stable through repeated processing", () => {
		const processed = processGenuiSpec({ type: "list", title: "标题", content: "正文", panel: true, append: true });

		expect(isRenderableProcess(processed)).toBe(true);
		expect(processed.spec).toEqual({
			panel: true,
			append: true,
			items: [{ type: "card", title: "标题", items: [{ type: "list", items: ["正文"] }] }],
		});
		expect(processGenuiSpec(processed.normalized).spec).toEqual(processed.spec);
		expect(processGenuiSpec(processed.spec).spec).toEqual(processed.spec);
	});
});
