/**
 * Tool discovery: a BM25 ranker over tool metadata, shared by `searchTools()` in codemode scripts and
 * the optional `tool_search` tool.
 *
 * `tool_search` searches tools that are not declared to
 * the model (including inactive direct/model-only tools) and loads matches, so they are declared for the
 * next model call. Loading goes through the active tool set, so it is recorded in the transcript
 * like any other tool change and survives `/tree`, resume, and fork on that branch.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolLoadout,
	ToolNamespace,
} from "../../core/extensions/types.ts";
import {
	assessToolForIntent,
	deriveIntentSteps,
	derivePreloadSteps,
	intentSearchQuery,
	requestedBrowserBackend,
	type ToolIntentStep,
} from "./intent.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 4;
export const MAX_TOOL_SEARCH_LIMIT = 8;

/** A tool as the ranker sees it: its name and the text built by {@link createToolSearchDocument}. */
export interface ToolSearchDocument {
	name: string;
	text: string;
}

export interface ToolSearchMatch {
	name: string;
	score: number;
}

/** Ranks tools for a query. BM25 today; a hybrid ranker with embeddings can replace it. */
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Latin words and Han bigrams support mixed Chinese/English queries without a remote ranker. */
export function tokenize(text: string): string[] {
	const terms =
		text
			.normalize("NFKC")
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.toLowerCase()
			.match(/[a-z0-9]+|\p{Script=Han}+/gu) ?? [];
	return terms.flatMap((term) => {
		if (/\p{Script=Han}/u.test(term)) {
			const characters = [...term];
			return characters.length === 1
				? characters
				: characters.slice(1).map((_, index) => characters.slice(index, index + 2).join(""));
		}
		return STOP_WORDS.has(term) ? [] : [stem(term)];
	});
}

/** Capability aliases bridge Chinese requests and predominantly English third-party metadata. */
const CAPABILITY_ALIASES: ReadonlyArray<{ pattern: RegExp; terms: string }> = [
	{ pattern: /浏览器|瀏覽器|网页|網頁|网站|網站|browser|playwright/i, terms: "browser playwright web" },
	{ pattern: /截图|截圖|截屏|screenshot/i, terms: "screenshot capture" },
	{ pattern: /表格|电子表|電子表|excel|spreadsheet|xlsx/i, terms: "spreadsheet sheet excel xlsx univer" },
	{ pattern: /文档|文件编辑|文件編輯|文檔|word|docx/i, terms: "document doc word docx univer" },
	{ pattern: /演示|幻灯|幻燈|简报|簡報|pptx?|slides?/i, terms: "presentation slide pptx univer" },
	{ pattern: /音乐|音樂|播放|歌曲|music|media/i, terms: "music media player playback" },
	{ pattern: /画图|繪圖|绘图|生图|图片|圖片|image/i, terms: "image generate" },
	{ pattern: /地图|地圖|附近|地点|地點|map|nearby/i, terms: "map nearby location" },
	{ pattern: /新闻|新聞|资讯|資訊|news/i, terms: "news search" },
	{ pattern: /搜索|搜尋|搜寻|查找|查詢|查询|search|find/i, terms: "search find query" },
	{ pattern: /子代理|子智能体|委派|subagent|delegate/i, terms: "subagent delegate" },
	{ pattern: /记住|記住|记忆|記憶|偏好|memory|remember/i, terms: "memory remember preferences" },
	{ pattern: /后台|背景运行|背景執行|定时|排程|background|schedule/i, terms: "background task schedule" },
	{ pattern: /验收|驗收|检查完成|完成检查|验证结果|驗證結果/, terms: "task check verify" },
];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (typeof schema.const === "string") parts.push(schema.const);
	if (Array.isArray(schema.enum))
		parts.push(...schema.enum.filter((value): value is string => typeof value === "string"));
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/**
 * Search text of a tool: the name, the name with `_`
 * as spaces, the description, schema descriptions and property names, and the namespace with its
 * description and instructions.
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

/** Okapi BM25 with the usual parameters. Ties keep document order. */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const aliases = CAPABILITY_ALIASES.filter(({ pattern }) => pattern.test(query))
			.map(({ terms }) => terms)
			.join(" ");
		const queryTerms = [...new Set(tokenize(`${query} ${aliases}`))];
		if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
		const termCounts = documents.map((document) => {
			const counts = new Map<string, number>();
			for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
			return counts;
		});
		const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
		const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
		const idf = new Map(
			queryTerms.map((term) => {
				const frequency = termCounts.filter((counts) => counts.has(term)).length;
				return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const matches: ToolSearchMatch[] = [];
		documents.forEach((document, index) => {
			let score = 0;
			for (const term of queryTerms) {
				const count = termCounts[index].get(term);
				if (!count) continue;
				const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / averageLength);
				score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
			}
			// Exact tool names must remain deterministic even when aliases introduce broader matches.
			if (document.name.toLowerCase() === query.trim().toLowerCase()) score += 1000;
			if (score > 0) matches.push({ name: document.name, score });
		});
		return matches.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}

const intentStepSchema = Type.Object({
	capability: Type.String({
		minLength: 1,
		maxLength: 80,
		description: "Required capability, e.g. web, spreadsheet, image, code, media",
	}),
	action: Type.String({
		minLength: 1,
		maxLength: 120,
		description: "Specific operation, e.g. search, read, create, edit, references, pause",
	}),
	target: Type.Optional(Type.String({ maxLength: 240 })),
	constraints: Type.Optional(Type.Array(Type.String({ maxLength: 160 }), { maxItems: 4 })),
	query: Type.Optional(
		Type.String({ maxLength: 240, description: "Optional alternate search wording for this step" }),
	),
});

export const toolSearchSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 800,
			description: "Single task or exact tool name; use steps for a compound task",
		}),
	),
	steps: Type.Optional(
		Type.Array(intentStepSchema, {
			minItems: 1,
			maxItems: 4,
			description: "Separate required operations; all steps share the load budget",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_TOOL_SEARCH_LIMIT,
			description: `Maximum tools to load. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.`,
		}),
	),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

/** Whether the tool is this `tool_search`, not another extension's tool of the same name. */
export function isToolSearchTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === TOOL_SEARCH_TOOL_NAME && tool.parameters === toolSearchSchema;
}

export interface ToolSearchResultTool {
	name: string;
	description: string;
	evidence: string[];
	alreadyActive: boolean;
}

export interface ToolSearchStepResult {
	intent: ToolIntentStep;
	status: "metadata_match" | "refine" | "no_match" | "budget_limited";
	tools: ToolSearchResultTool[];
	candidates: Array<{ name: string; reason: string; missing: string[] }>;
	queries: string[];
	uncheckedConstraints: string[];
}

export interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	loaded: string[];
	steps: ToolSearchStepResult[];
}

export interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are not declared to the model and
	 * activates the matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** Whether `tool_search` can load a tool with this exposure. */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure !== "hidden";
}

function browserToolPrefix(name: string): string | undefined {
	return name.startsWith("browser_") ? "browser_" : name.match(/^mcp_.+_browser_/)?.[0];
}

/**
 * Rank the searchable tools that are not active yet and activate the matches, so the next model
 * call declares them. Activation is recorded in the transcript like any tool change.
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	input: ToolSearchInput,
	limit: number,
	messages: readonly AgentMessage[] = [],
): ToolSearchToolDetails {
	const active = new Set(tools.getActiveTools());
	let lastBrowserPrefix: string | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult") continue;
		const successfulNames = [
			...(message.nestedCalls?.calls ?? [])
				.slice()
				.reverse()
				.filter((call) => call.status === "ok")
				.map((call) => call.name),
			...(message.isError ? [] : [message.toolName]),
		];
		lastBrowserPrefix = successfulNames.map(browserToolPrefix).find((prefix) => prefix !== undefined);
		if (lastBrowserPrefix) break;
	}
	const candidates = tools
		.getAllTools()
		.filter((tool) => isSearchable(tool.exposure) && tool.name !== TOOL_SEARCH_TOOL_NAME);
	const exact =
		!input.steps && input.query
			? candidates.find((tool) => tool.name.toLowerCase() === input.query?.trim().toLowerCase())
			: undefined;
	const intents =
		input.steps ??
		(exact
			? [{ capability: "tool", action: "inspect", target: exact.name, query: exact.name }]
			: deriveIntentSteps(input.query ?? ""));
	if (intents.length > 4) throw new Error("Split this task into batches of at most 4 discovery steps.");
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const ranker = new Bm25Ranker();
	const pending = new Set<string>();
	const results: ToolSearchStepResult[] = [];
	for (const intent of intents) {
		const queries = [
			...new Set(
				[
					intent.query?.trim(),
					[intent.capability, intent.action, intent.target]
						.filter((value) => value && value !== "unknown")
						.join(" "),
					intentSearchQuery(intent),
				].filter((query): query is string => Boolean(query)),
			),
		];
		const scores = new Map<string, number>();
		for (const query of queries) {
			for (const match of ranker.rank(query, documents, documents.length)) {
				scores.set(match.name, Math.max(scores.get(match.name) ?? 0, match.score));
			}
		}
		// Refs belong to the backend that actually handled the latest successful browser call.
		// Active/pending declarations are only a fallback, not proof of execution; explicit backend requests narrow candidates.
		const requestedBackend =
			intent.capability === "browser"
				? requestedBrowserBackend([intent.query, intent.target].filter(Boolean).join(" "))
				: undefined;
		const preferredBrowserPrefix =
			intent.capability === "browser" && !requestedBackend
				? (lastBrowserPrefix ??
					([...active, ...pending].some((name) => name.startsWith("browser_")) ? "browser_" : undefined))
				: undefined;
		// Explicit backend requirements filter actual registered families; missing actions never fall back to native.
		const eligible = exact
			? [exact]
			: candidates.filter((tool) => {
					const prefix = browserToolPrefix(tool.name);
					if (!requestedBackend) return true;
					if (requestedBackend === "native") return prefix === "browser_";
					return (
						prefix !== undefined &&
						prefix !== "browser_" &&
						(requestedBackend !== "playwright" || /\bplaywright\b/i.test(prefix.replaceAll("_", " ")))
					);
				});
		const assessed = eligible
			.map((tool) => ({
				tool,
				score: scores.get(tool.name) ?? 0,
				assessment: exact
					? {
							status: "supported" as const,
							evidence: ["Exact registered tool name; inspect its schema before execution."],
							missing: [],
							reason: "Exact lookup",
						}
					: assessToolForIntent(intent, tool),
			}))
			.sort(
				(a, b) =>
					Number(
						preferredBrowserPrefix !== undefined && browserToolPrefix(b.tool.name) === preferredBrowserPrefix,
					) -
						Number(
							preferredBrowserPrefix !== undefined && browserToolPrefix(a.tool.name) === preferredBrowserPrefix,
						) ||
					b.score - a.score ||
					Number(active.has(b.tool.name)) - Number(active.has(a.tool.name)),
			);
		const supportedMatches = assessed.filter(({ assessment }) => assessment.status === "supported");
		const supported =
			pending.size >= limit
				? (supportedMatches.find(({ tool }) => active.has(tool.name) || pending.has(tool.name)) ??
					supportedMatches[0])
				: supportedMatches[0];
		const result: ToolSearchStepResult = {
			intent,
			status: "no_match",
			tools: [],
			candidates: [],
			queries,
			uncheckedConstraints: [...(intent.constraints ?? [])],
		};
		if (supported) {
			const { tool, assessment } = supported;
			if (active.has(tool.name) || pending.has(tool.name) || pending.size < limit) {
				if (!active.has(tool.name)) pending.add(tool.name);
				result.status = "metadata_match";
				result.tools.push({
					name: tool.name,
					description: tool.description.trim().split(/\r?\n/)[0].slice(0, 240),
					evidence: assessment.evidence.slice(0, 4),
					alreadyActive: active.has(tool.name),
				});
			} else {
				result.status = "budget_limited";
				result.candidates.push({
					name: tool.name,
					reason: "Shared new-tool budget exhausted; discover this step in the next batch.",
					missing: ["load_budget"],
				});
			}
		} else {
			result.candidates = assessed
				.filter(
					({ assessment, score }) =>
						assessment.status === "refine" && (score > 0 || assessment.evidence.length > 0),
				)
				.slice(0, 2)
				.map(({ tool, assessment }) => ({
					name: tool.name,
					reason: assessment.reason,
					missing: assessment.missing,
				}));
			if (result.candidates.length > 0 || requestedBackend) result.status = "refine";
		}
		results.push(result);
	}
	if (pending.size > 0) tools.setActiveTools([...active, ...pending]);
	const activated = new Set(tools.getActiveTools());
	for (const result of results) {
		for (const tool of result.tools.filter((tool) => !activated.has(tool.name))) {
			result.candidates.push({
				name: tool.name,
				reason: "The session did not activate this tool; check its availability and permissions.",
				missing: ["activation"],
			});
		}
		result.tools = result.tools.filter((tool) => activated.has(tool.name));
		if (result.status === "metadata_match" && result.tools.length === 0) result.status = "refine";
	}
	return { loaded: [...pending].filter((name) => activated.has(name)), steps: results };
}

/**
 * Activate tools whose metadata matches `text` before the model is asked to discover them.
 * Both a capability and an action outside that capability word are required. Greetings,
 * unrecognized text, and actions nested inside a capability word load nothing.
 */
export function preloadToolsForUserText(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	text: string,
	limit = DEFAULT_TOOL_SEARCH_LIMIT,
	messages: readonly AgentMessage[] = [],
): ToolSearchToolDetails | undefined {
	const active = new Set(tools.getActiveTools());
	const coreCodeActions: Readonly<Record<string, string>> = {
		read: "read",
		edit: "edit",
		create: "write",
		search: "grep",
	};
	const steps = derivePreloadSteps(text)
		.filter((step) => step.capability !== "unknown" && step.action !== "unknown")
		.filter(
			(step) =>
				step.capability !== "code" ||
				/\b(?:mcp|lsp)\b/i.test((step.query ?? "").replaceAll("_", " ")) ||
				!active.has(coreCodeActions[step.action] ?? ""),
		)
		.slice(0, 4);
	if (steps.length === 0) return undefined;
	return searchAndLoad(tools, { steps }, Math.min(Math.max(1, limit), MAX_TOOL_SEARCH_LIMIT), messages);
}

/** Base guidance; prepareLoadout adds a bounded directory of available capabilities. */
export const TOOL_SEARCH_DESCRIPTION = `Find tools by capability and specific action. For compound work, provide separate steps (e.g. web/search, web/read, spreadsheet/create). Candidate actions are checked against tool metadata; weak matches are not loaded. metadata_match is not execution success or verified credentials/constraints. On refine/no_match, narrow the action, reword the step, or use an exact tool name to inspect its schema. The new-tool budget is shared across steps; already active matches are returned without reloading. Call matched tools from the next turn, preserving native images. Do not search for greetings.`;

/** A bounded capability directory, without schemas or a full list of tool descriptions. */
function describeCapabilities(loadout: ToolLoadout): string {
	const active = new Set(loadout.declared.map((tool) => tool.name));
	const groups = new Map<string, string[]>();
	for (const tool of loadout.registered) {
		if (active.has(tool.name) || !isSearchable(loadout.getExposure(tool.name))) continue;
		const namespace = loadout.getNamespace(tool.name);
		const name =
			namespace?.name ??
			tool.name
				.split("_")
				.slice(0, tool.name.startsWith("mcp_") ? 2 : 1)
				.join("_");
		const examples = groups.get(name) ?? [];
		if (examples.length < 2) examples.push(tool.name);
		groups.set(name, examples);
	}
	if (groups.size === 0) return TOOL_SEARCH_DESCRIPTION;
	const entries = [...groups].sort(([a], [b]) => a.localeCompare(b));
	return `${TOOL_SEARCH_DESCRIPTION}\n\nAvailable capability groups (discover the exact tools before calling):\n${entries
		.slice(0, 16)
		.map(([name, examples]) => `- ${name}: ${examples.join(", ")}`)
		.join("\n")}${
		entries.length > 16
			? `\nOther groups: ${entries
					.slice(16)
					.map(([name]) => name)
					.join(", ")
					.slice(0, 800)}. Search by capability and action.`
			: ""
	}`;
}

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		prepareLoadout: (loadout) => ({ descriptions: { [TOOL_SEARCH_TOOL_NAME]: describeCapabilities(loadout) } }),
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
			if (!input.steps?.length && !input.query?.trim())
				throw new Error("Provide a non-empty query or 1–4 capability/action steps.");
			if (
				input.steps &&
				(input.steps.length < 1 ||
					input.steps.length > 4 ||
					input.steps.some((step) => !step.capability.trim() || !step.action.trim()))
			) {
				throw new Error("Provide 1–4 steps with a non-empty capability and action.");
			}
			const max = input.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0 || max > MAX_TOOL_SEARCH_LIMIT)
				throw new Error(`limit must be an integer from 1 to ${MAX_TOOL_SEARCH_LIMIT}`);
			const details = searchAndLoad(
				options.tools ?? { getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {} },
				input,
				max,
				ctx?.sessionManager?.buildSessionProjection().messages ?? [],
			);
			const text = JSON.stringify({
				...details,
				guidance:
					"metadata_match only checks declared capability/action evidence. Inspect parameter requirements, availability, permissions and uncheckedConstraints before execution. For refine/no_match, rephrase or inspect an exact candidate name; no_match does not prove the capability is absent. For budget_limited, discover the remaining steps in a later batch.",
			});
			return { content: [{ type: "text", text }], details };
		},
	};
}
