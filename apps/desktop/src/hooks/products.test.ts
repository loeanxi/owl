import assert from "node:assert/strict";
import { test } from "node:test";
import {
	collectHistoricalProducts,
	collectProducts,
	productKindOfSpec,
	productsOfTools,
	productTitleOfSpec,
	visualProductOf,
} from "./products.ts";
import type { ChatEntry, ToolCard, ToolStatus } from "./transcript.ts";

function tool(id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolCard> = {}): ToolCard {
	return { id, name, args: JSON.stringify(args), summary: `${name} ${id}`, status: "ok" as ToolStatus, ...extra };
}

function assistant(tools: ToolCard[]): ChatEntry {
	return {
		kind: "assistant",
		entryId: "a",
		text: "",
		thinking: "",
		tools,
		timestamp: 1000,
		endedAt: 2000,
		segments: [],
	};
}

function visual(id: string, spec: unknown): ToolCard {
	return tool(id, "render_ui", {}, { output: { text: "", totalLines: 0, genuiSpec: spec as never } });
}

test("a written file is a product, an edited file is a change", () => {
	const products = productsOfTools(
		[tool("w", "write", { path: "report.md" }), tool("e", "edit", { path: "notes.md" })],
		"D:/owl",
	);
	assert.deepEqual(
		products.map((product) => [product.kind, product.title, product.action]),
		[
			["file", "report.md", "written"],
			["file", "notes.md", "edited"],
		],
	);
});

test("a visualization is a product with its own kind", () => {
	const product = visualProductOf(visual("v", { title: "月度趋势", items: [{ type: "echart" }] }));
	assert.equal(product?.kind, "chart");
	assert.equal(product?.title, "月度趋势");
	assert.equal(product?.toolId, "v");
});

test("the product kind follows the first meaningful genui node", () => {
	assert.equal(productKindOfSpec({ items: [{ type: "card" }, { type: "mermaid" }] }), "chart");
	assert.equal(productKindOfSpec({ items: [{ type: "card" }, { type: "table" }] }), "table");
	assert.equal(productKindOfSpec({ items: [{ type: "card" }, { type: "code" }] }), "code");
	assert.equal(productKindOfSpec({ items: [{ type: "text" }] }), "view");
	assert.equal(productKindOfSpec({ items: [] }), "view");
	assert.equal(productKindOfSpec(undefined), "view");
});

test("the visualization title falls back to the tool summary", () => {
	const card = visual("v", { items: [{ type: "chart" }] });
	assert.equal(productTitleOfSpec({ items: [{ type: "chart" }] }, card), "render_ui v");
	assert.equal(productTitleOfSpec({ title: "  标题  ", items: [] }, card), "标题");
});

test("a failed tool produces no product", () => {
	const failed = visual("v", { title: "x", items: [] });
	failed.status = "error";
	assert.equal(visualProductOf(failed), undefined);
});

test("the turn scope only counts the current turn", () => {
	const entries: ChatEntry[] = [
		assistant([tool("old", "write", { path: "old.md" })]),
		{ kind: "user", text: "新的问题" },
		assistant([tool("new", "write", { path: "new.md" })]),
	];
	assert.deepEqual(
		collectProducts(entries, "D:/owl").map((product) => product.title),
		["new.md"],
	);
	assert.deepEqual(
		collectProducts(entries, "D:/owl", { scope: "session" }).map((product) => product.title),
		["old.md", "new.md"],
	);
});

test("the same file twice is one product", () => {
	const entries: ChatEntry[] = [
		assistant([tool("a", "write", { path: "report.md" }), tool("b", "edit", { path: "report.md" })]),
	];
	assert.equal(collectProducts(entries, "D:/owl").length, 1);
});

test("files and visualizations share one list", () => {
	const entries: ChatEntry[] = [
		assistant([
			tool("w", "write", { path: "report.md" }),
			visual("v", { title: "月度趋势", items: [{ type: "echart" }] }),
		]),
	];
	assert.deepEqual(
		collectProducts(entries, "D:/owl").map((product) => product.kind),
		["file", "chart"],
	);
});

test("historical turns keep their own products", () => {
	const entries: ChatEntry[] = [
		assistant([tool("a", "write", { path: "first.md" })]),
		{ kind: "user", text: "再来" },
		assistant([tool("b", "write", { path: "second.md" })]),
	];
	// 历史轮按「下一条用户消息」的位置归档（与成果卡同一口径）；
	// 最新一轮没有后继用户消息，它自己走尾部那张卡。
	assert.deepEqual(
		[...collectHistoricalProducts(entries, "D:/owl")].map(([index, products]) => ({
			index,
			paths: products.map((product) => product.path),
		})),
		[{ index: 1, paths: ["first.md"] }],
	);
});

test("code files are excluded unless asked for", () => {
	const entries: ChatEntry[] = [assistant([tool("c", "write", { path: "src/app.ts" })])];
	assert.equal(collectProducts(entries, "D:/owl").length, 0);
	assert.equal(collectProducts(entries, "D:/owl", { includeCode: true }).length, 1);
});
