/**
 * 产物清单。
 *
 * Claude Desktop 的产物（artifact）是**内容**维度的一等公民：图表、文档、
 * 代码片段各自是一个产物，能被单独打开、分享、评论。owl 现有的成果卡只有
 * **文件**维度（`artifacts.ts`），而可视化产物（owl-genui 的图表与交互组件）
 * 只留在回答流里 —— 滚上去就找不回来了。
 *
 * 这里把两者收成一份清单，形态对齐 Claude 的 artifact 列表：
 *
 *   产物 (3)
 *   ▢ 费用明细.xlsx      表格 · 新建
 *   ▢ 月度趋势            图表
 *   ▢ src/report.ts      代码 · 修改
 *
 * - **文件产物**：复用 `collectArtifacts` 的路径判定与类型分类。
 * - **可视化产物**：`render_ui` 工具的结果（`output.genuiSpec`）。
 *   它在对话流里渲染成一张卡片，列表项点开就定位到那张卡。
 */

import { type ArtifactKind, artifactsOfTool, type FileArtifact } from "./artifacts.ts";
import type { ChatEntry, ToolCard } from "./transcript.ts";

/** 产物的种类。 */
export type ProductKind = "file" | "chart" | "table" | "code" | "view";

/** 一件产物。 */
export interface Product {
	/** 列表里的稳定键。 */
	id: string;
	kind: ProductKind;
	/** 标题：文件名，或可视化产物的标题。 */
	title: string;
	/** 副标题：文件是工作区路径，可视化是它的形态说明。 */
	subtitle?: string;
	/** 文件产物的工作区相对路径（可视化产物没有）。 */
	path?: string;
	/** 产出它的那次工具调用 —— 可视化产物用它定位到对话流里的卡片。 */
	toolId: string;
	/** 文件产物的类型分类。 */
	fileKind?: ArtifactKind;
	/** 文件产物是被新建还是被修改。 */
	action?: FileArtifact["action"];
	/**
	 * 可视化产物的 owl-ui spec（`render_ui` 工具的结果）。
	 *
	 * 产物页要靠它把图表/表格渲染成真正的组件，所以这里把 spec 一并带出来
	 * （只存在内存里，不进持久化）。
	 */
	spec?: unknown;
}

/** 可视化产物的形态分类。 */
const CHART_NODES = new Set(["chart", "echart", "mermaid", "diagram", "scene3d", "plot", "svg", "timeline"]);
const TABLE_NODES = new Set(["table", "keyvalue", "breadcrumb", "filetree"]);
const CODE_NODES = new Set(["code", "diff", "json"]);

/**
 * 从 genui spec 的根节点推出产物形态。
 *
 * 取第一个有形态的根节点：图表、表格、代码各成一类，其余归到「视图」。
 */
export function productKindOfSpec(spec: unknown): ProductKind {
	if (spec === null || typeof spec !== "object") return "view";
	const items = (spec as { items?: unknown }).items;
	if (!Array.isArray(items)) return "view";
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const type = (item as { type?: unknown }).type;
		if (typeof type !== "string") continue;
		if (CHART_NODES.has(type)) return "chart";
		if (TABLE_NODES.has(type)) return "table";
		if (CODE_NODES.has(type)) return "code";
	}
	return "view";
}

/** 可视化产物的标题：spec 的 title 优先，其次工具自己的摘要。 */
export function productTitleOfSpec(spec: unknown, tool: ToolCard): string {
	const title = (spec as { title?: unknown } | null)?.title;
	if (typeof title === "string" && title.trim() !== "") return title.trim();
	const summary = tool.summary?.trim();
	if (summary !== undefined && summary !== "") return summary;
	return "";
}

/** 工具结果里的可视化产物（`render_ui` 的 genuiSpec）。 */
export function visualProductOf(tool: ToolCard): Product | undefined {
	const spec = tool.output?.genuiSpec;
	if (spec === undefined || spec === null) return undefined;
	if (tool.status !== "ok") return undefined;
	const title = productTitleOfSpec(spec, tool);
	if (title === "") return undefined;
	return {
		id: `visual:${tool.id}`,
		kind: productKindOfSpec(spec),
		title,
		toolId: tool.id,
		spec,
	};
}

/** 文件产物 → 产物条目。 */
function fileProduct(artifact: FileArtifact): Product {
	return {
		id: `file:${artifact.path}`,
		kind: "file",
		title: artifact.title,
		subtitle: artifact.path,
		path: artifact.path,
		toolId: artifact.toolId,
		fileKind: artifact.kind,
		action: artifact.action,
	};
}

export interface ProductOptions {
	/** "turn"（默认）只看本轮，"session" 看整个会话。 */
	scope?: "turn" | "session";
	/** 代码文件算不算产物（默认不算，与现有成果卡一致）。 */
	includeCode?: boolean;
}

/**
 * 一批工具调用产出的产物。
 *
 * 文件产物需要工作区根（`cwd`）才能把绝对路径收成工作区相对路径；
 * 可视化产物不需要。
 */
export function productsOfTools(
	tools: readonly ToolCard[],
	cwd: string | undefined,
	options: ProductOptions = {},
): Product[] {
	const products: Product[] = [];
	const seenFiles = new Set<string>();
	const seenVisuals = new Set<string>();
	for (const tool of tools) {
		if (tool.status !== "ok") continue;
		if (cwd !== undefined) {
			for (const artifact of artifactsOfTool(tool, cwd)) {
				if (!options.includeCode && artifact.kind === "code") continue;
				const product = fileProduct(artifact);
				if (seenFiles.has(product.id)) continue;
				seenFiles.add(product.id);
				products.push(product);
			}
		}
		const visual = visualProductOf(tool);
		if (visual === undefined || seenVisuals.has(visual.id)) continue;
		seenVisuals.add(visual.id);
		products.push(visual);
	}
	return products;
}

/**
 * 收一份产物清单。
 *
 * 顺序按产出顺序（对话流里先出现的在前），文件与可视化混排 —— 这也是
 * Claude 的产物列表的样子：一张表，不分「文件」和「图表」。
 */
export function collectProducts(entries: readonly ChatEntry[], cwd: string, options: ProductOptions = {}): Product[] {
	const start =
		options.scope === "session"
			? 0
			: Math.max(
					0,
					entries.findLastIndex((entry) => entry.kind === "user"),
				);
	const products: Product[] = [];
	const seen = new Set<string>();
	for (const entry of entries.slice(start)) {
		if (entry.kind !== "assistant") continue;
		for (const product of productsOfTools(entry.tools, cwd, options)) {
			if (seen.has(product.id)) continue;
			seen.add(product.id);
			products.push(product);
		}
	}
	return products;
}

/** 完成的历史轮各自的产物（插在下一条用户消息之前）。 */
export function collectHistoricalProducts(
	entries: readonly ChatEntry[],
	cwd: string,
	options: ProductOptions = {},
): Map<number, Product[]> {
	const turns = new Map<number, Product[]>();
	let start = 0;
	entries.forEach((entry, index) => {
		if (entry.kind !== "user") return;
		const products = collectProducts(entries.slice(start, index), cwd, options);
		if (products.length > 0) turns.set(index, products);
		start = index;
	});
	return turns;
}
