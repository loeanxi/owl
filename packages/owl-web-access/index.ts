import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@owl/owl-coding-agent";
import { Type } from "typebox";
import pLimit from "p-limit";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { normalizeFetchContentParams } from "./fetch-params.ts";
import { findContent, type FindMode } from "./content-find.ts";
import { answerFromPage } from "./page-query.ts";
import { clearCloneCache } from "./github-extract.ts";
import { assertSearchProviderSelectionAllowed, getAllowedSearchProviders, normalizeSearchProviderSelection, providerLabel, RESOLVED_SEARCH_PROVIDERS, ALL_SEARCH_PROVIDERS, search, type ProviderAvailability, type SearchProvider, type SearchProviderSelection, type ResolvedSearchProvider } from "./gemini-search.ts";
export type { ProviderAvailability } from "./gemini-search.ts";
import type { SearchResult } from "./perplexity.ts";
import { getWebSearchConfigDir, getWebSearchConfigPath, runWithProxy } from "./utils.ts";
import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	getResult,
	restoreFromSession,
	storeFetchedContentResult,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.ts";
import { activityMonitor } from "./activity.ts";
import {
	buildDeterministicSummary,
	generateSummaryDraft,
	SUMMARY_GENERATION_DEADLINE_MS,
	type SummaryGenerationContext,
	type SummaryMeta,
} from "./summary-review.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildSearchErrorPlan, type SearchErrorDetails, type SearchErrorPlan } from "./render-search-error.ts";
import { findModelWithProviderRouting, isModelInScope, splitThinkingSuffix } from "./summary-model-scope.ts";
import {
	buildResearchArtifact,
	withClaimAssessment,
	storeResearchArtifact,
	getResearchArtifact,
	type RecencyFilter,
	type ResearchArtifact,
} from "./source-check.ts";
import { registerWebToolActivation } from "./tool-activation.ts";

// Match pi-ai's StringEnum without loading its compat barrel during registration.
function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;
async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const extractModule = await (extractModulePromise ??= import("./extract.ts"));
	return extractModule.fetchAllContent(urls, signal, options);
}

function withRegisteredFetchOptions(
	options: ExtractOptions | undefined,
	toolNames: ExtractOptions["toolNames"],
	proxy?: string,
): ExtractOptions {
	return {
		...(options ?? {}),
		toolNames,
		...(proxy !== undefined ? { proxy } : {}),
	};
}

function isAbortError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

/** Shared collapsed/expanded renderer for an error/cancel plan produced by
 * buildSearchErrorPlan(). Used by every tool renderResult's error branch so
 * the expanded view reveals diagnostics instead of a dead-end single line. */
function renderSearchErrorPlan(plan: SearchErrorPlan, expanded: boolean): string {
	if (expanded) {
		return plan.expanded.join("\n");
	}
	const lines = [plan.expanded[0], ...plan.collapsed];
	if (plan.expandHint) {
		lines.push(plan.expandHint);
	}
	return lines.join("\n");
}

interface WebSearchConfig {
	anysearchApiKey?: unknown;
	xcrawlApiKey?: unknown;
	brightdataApiKey?: unknown;
	brightdataSerpZone?: unknown;
	kagiApiKey?: unknown;
	ollamaApiKey?: unknown;
	serpbaseApiKey?: unknown;
	serpapiApiKey?: unknown;
	serperApiKey?: unknown;
	serplyApiKey?: unknown;
	youApiKey?: unknown;
	baizhiApiKey?: unknown;
	zaiApiKey?: unknown;
	tinyfishApiKey?: unknown;
	valyuApiKey?: unknown;
	xaiApiKey?: unknown;
	provider?: unknown;
	searchProvider?: unknown;
	workflow?: string;
	summaryModel?: string;
	summaryGenerationDeadlineMs?: unknown;
	summaryInstructions?: unknown;
	maxInlineContentChars?: unknown;
	fetch?: {
		defaultMode?: unknown;
		allowedModes?: unknown;
	};
	webSearch?: {
		enabled?: boolean;
		allowedProviders?: unknown;
	};
	tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
	toolActivation?: unknown;
	commands?: Partial<Record<"websearch" | "search", { enabled?: boolean }>>;
	toolNames?: Partial<ToolNames>;
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
		/** Skip local hostname DNS preflight when an HTTP(S)_PROXY env var applies. */
		trustEnvProxy?: boolean;
	};
}

type SummaryWorkflow = "auto-summary";

function parseConfigRoot(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${WEB_SEARCH_CONFIG_PATH}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	return parseConfigRoot(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8")) as WebSearchConfig;
}

function saveConfig(updates: Partial<WebSearchConfig>): void {
	let config: Record<string, unknown> = {};
	if (existsSync(WEB_SEARCH_CONFIG_PATH)) {
		config = parseConfigRoot(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"));
	}

	Object.assign(config, updates);
	const dir = getWebSearchConfigDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(WEB_SEARCH_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

type ToolNames = {
	webSearch: string;
	sourceCheck: string;
	fetchContent: string;
	getSearchContent: string;
};

const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	sourceCheck: "source_check",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
};
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_SUMMARY_GENERATION_DEADLINE_MS = 600_000;
const SEARCH_QUERY_CONCURRENCY = 3;
const FETCH_MODES = ["readable", "raw", "answer"] as const;
type FetchMode = typeof FETCH_MODES[number];
const FETCH_MODE_DESCRIPTIONS: Record<FetchMode, string> = {
	readable: "extract readable content as markdown",
	raw: "return the exact textual body using direct HTTP only",
	answer: "answer a prompt using only fetched content",
};

function resolveFetchModeConfig(config: WebSearchConfig): { defaultMode: FetchMode; allowedModes: FetchMode[] } {
	const configuredModes = config.fetch?.allowedModes ?? FETCH_MODES;
	if (!Array.isArray(configuredModes) || configuredModes.length === 0 || configuredModes.some(mode => !FETCH_MODES.includes(mode as FetchMode))) {
		throw new Error(`fetch.allowedModes in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array containing only "readable", "raw", or "answer"`);
	}
	const allowedModes = configuredModes as FetchMode[];
	const duplicateMode = allowedModes.find((mode, index) => allowedModes.indexOf(mode) !== index);
	if (duplicateMode) {
		throw new Error(`fetch.allowedModes in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: "${duplicateMode}"`);
	}
	const defaultMode = config.fetch?.defaultMode ?? "readable";
	if (!allowedModes.includes(defaultMode as FetchMode)) {
		throw new Error(`fetch.defaultMode in ${WEB_SEARCH_CONFIG_PATH} must be one of fetch.allowedModes`);
	}
	return { defaultMode: defaultMode as FetchMode, allowedModes };
}

// Limit each batch independently so separate tool calls can still run in parallel.
function runSearchQueries<T>(queries: string[], run: (query: string, index: number) => Promise<T>): Promise<T[]> {
	const limit = pLimit(SEARCH_QUERY_CONCURRENCY);
	return Promise.all(queries.map((query, index) => limit(() => run(query, index))));
}

function searchProviderSchema(description: string, allowedProviders: readonly ResolvedSearchProvider[]) {
	return Type.Union([
		StringEnum(["auto", "all", ...allowedProviders]),
		Type.Array(StringEnum([...allowedProviders]), { minItems: 1 }),
	], { description });
}

function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
	const override = config.tools?.[key]?.enabled;
	if (typeof override === "boolean") return override;
	return key !== "webSearch" && key !== "sourceCheck" || config.webSearch?.enabled !== false;
}

function isCommandEnabled(config: WebSearchConfig, name: "websearch" | "search"): boolean {
	return config.commands?.[name]?.enabled !== false;
}

function joinToolNames(names: string[]): string {
	if (names.length === 0) return "stored content";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

function resolveToolNames(config: WebSearchConfig): ToolNames {
	if (config.toolNames !== undefined && (!config.toolNames || typeof config.toolNames !== "object" || Array.isArray(config.toolNames))) {
		throw new Error(`toolNames in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const names = { ...DEFAULT_TOOL_NAMES };
	for (const key of Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>) {
		const value = config.toolNames?.[key];
		if (value === undefined) continue;
		if (typeof value !== "string") throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must be a string`);
		const trimmed = value.trim();
		if (!TOOL_NAME_PATTERN.test(trimmed)) {
			throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
		}
		names[key] = trimmed;
	}
	const registeredKeys = (Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>)
		.filter(key => isToolEnabled(config, key));
	const seen = new Map<string, keyof ToolNames>();
	for (const key of registeredKeys) {
		const name = names[key];
		if (name === "web_enable") throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} uses reserved loader name web_enable`);
		const previous = seen.get(name);
		if (previous) throw new Error(`toolNames.${key} duplicates toolNames.${previous} in ${WEB_SEARCH_CONFIG_PATH}`);
		seen.set(name, key);
	}
	return names;
}

function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[owl-web-access] ${message}`);
		return {};
	}
}

function normalizeProviderInput(value: unknown, label = "provider"): SearchProviderSelection | undefined {
	if (value === undefined) return undefined;
	return normalizeSearchProviderSelection(value, label);
}

function resolveRequestedProvider(requested: unknown): SearchProviderSelection {
	const normalizedRequested = normalizeProviderInput(requested);
	if (normalizedRequested && normalizedRequested !== "auto") {
		assertSearchProviderSelectionAllowed(normalizedRequested, "Requested provider");
		return normalizedRequested;
	}
	const config = loadConfig();
	const provider = normalizeProviderInput(config.searchProvider ?? config.provider, `provider in ${WEB_SEARCH_CONFIG_PATH}`) ?? "auto";
	assertSearchProviderSelectionAllowed(provider, `configured provider in ${WEB_SEARCH_CONFIG_PATH}`);
	return provider;
}

function toFailureProvider(provider: SearchProviderSelection): SearchProvider | undefined {
	if (Array.isArray(provider)) return "all";
	return provider === "auto" ? undefined : provider;
}

function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

// Workflows the search tool supports. "summary-review" (the retired browser
// curator) normalizes to "auto-summary" so old configs keep generating summaries.
const SEARCH_WORKFLOWS = ["none", "auto-summary"] as const;
type SearchWorkflow = typeof SEARCH_WORKFLOWS[number];

function normalizeSearchWorkflow(value: unknown): SearchWorkflow {
	return value === "auto-summary" || value === "summary-review" ? "auto-summary" : "none";
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

// Some local models serialize a multi-query list into the single-string `query`
// field as a JSON array (query: "[\"a\", \"b\"]") instead of using the
// `queries` parameter. Forwarding that raw string verbatim makes every backend
// search for the literal array text and return zero results, with no signal to
// the model that its argument shape was wrong. Expand a string that parses as a
// JSON array of strings so each element is searched independently.
function expandQueryString(query: unknown): string[] {
	if (typeof query !== "string") return [];
	const trimmed = query.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			// Only expand an unambiguously string-only array. Mixed or non-string
			// arrays are kept as the literal query so we never silently drop
			// members or collapse them into an empty search.
			if (Array.isArray(parsed) && parsed.every((entry): entry is string => typeof entry === "string")) {
				return parsed
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0);
			}
		} catch {
			// Not JSON — treat as a literal query string.
		}
	}
	return [query];
}

export function getSummaryGenerationDeadlineMs(): number {
	const value = loadConfig().summaryGenerationDeadlineMs;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		return SUMMARY_GENERATION_DEADLINE_MS;
	}
	return Math.min(value, MAX_SUMMARY_GENERATION_DEADLINE_MS);
}

export function getSummaryInstructions(): string | undefined {
	const value = loadConfig().summaryInstructions;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;


const DEFAULT_MAX_INLINE_CONTENT_CHARS = 30_000;
const MIN_INLINE_CONTENT_CHARS = 1_000;
const MAX_INLINE_CONTENT_CHARS = 200_000;

function getMaxInlineContentChars(config = loadConfig()): number {
	const value = config.maxInlineContentChars;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < MIN_INLINE_CONTENT_CHARS) {
		return DEFAULT_MAX_INLINE_CONTENT_CHARS;
	}
	return Math.min(value, MAX_INLINE_CONTENT_CHARS);
}

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, ...rest }) => rest);
}

function storeFetchResult(pi: { appendEntry(type: string, data: unknown): void }, responseId: string, data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] }): boolean {
	pi.appendEntry("web-search-results", storeFetchedContentResult(responseId, data));
	return true;
}

function initialContentSlice(content: string, maxChars: number): {
	text: string;
	endOffset: number;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
} {
	let endOffset = Math.min(content.length, maxChars);
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.length === 0 ? 0 : content.split("\n").length,
		shownBytes: Buffer.byteLength(text),
		shownLines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

function normalizeFindQueries(value: string | string[]): string[] {
	const queries = (Array.isArray(value) ? value : [value]).map(query => query.trim()).filter(Boolean);
	if (queries.length === 0) throw new Error("findText must contain at least one non-empty string");
	return queries;
}

interface GetSearchContentParams {
	responseId: string;
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
	offset?: number;
	limit?: number;
	findText?: string | string[];
	findMode?: FindMode;
}

type RawGetSearchContentParams = Omit<GetSearchContentParams, "findMode"> & { findMode?: unknown };

function normalizeFindMode(value: unknown): FindMode | undefined {
	if (value === undefined) return undefined;
	if (value === "exact" || value === "case-insensitive" || value === "fuzzy") return value;
	throw new Error('findMode must be "exact", "case-insensitive", or "fuzzy"');
}

function normalizeGetSearchContentParams(params: RawGetSearchContentParams): GetSearchContentParams {
	const normalized: GetSearchContentParams = { ...params, findMode: normalizeFindMode(params.findMode) };

	if (normalized.query?.trim() === "") delete normalized.query;
	if (normalized.url?.trim() === "") delete normalized.url;

	if (normalized.findText !== undefined) {
		delete normalized.offset;
		delete normalized.limit;
	}

	return normalized;
}

function formatInputValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatSourceCheckResult(artifact: ResearchArtifact, getSearchContentTool: string | null = DEFAULT_TOOL_NAMES.getSearchContent): string {
	const assessment = artifact.claims?.[0];
	const lines = [`# Source check: ${artifact.query}`, ""];
	if (assessment) {
		lines.push(`**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`);
		lines.push(`**Rationale:** ${assessment.rationale}`);
		if (assessment.supporting_passages.length > 0) lines.push(`**Supporting passages:** ${assessment.supporting_passages.join(", ")}`);
		if (assessment.contradicting_passages.length > 0) lines.push(`**Contradicting passages:** ${assessment.contradicting_passages.join(", ")}`);
		lines.push("");
	}
	if (artifact.sources.length > 0) {
		lines.push("## Sources");
		for (const source of artifact.sources) lines.push(`${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`);
		lines.push("");
	}
	if (artifact.errors?.length) lines.push(`Search errors: ${artifact.errors.map((entry) => `${entry.query}: ${entry.error}`).join("; ")}`);
	lines.push(getSearchContentTool
		? `Artifact responseId: ${artifact.id} (retrievable via ${getSearchContentTool}).`
		: `Artifact responseId: ${artifact.id}. Content retrieval is not registered.`);
	return lines.join("\n");
}

function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	const providers = queryData.providers ?? (queryData.provider ? [queryData.provider] : []);
	if (providers.length > 0) output += `**Provider${providers.length === 1 ? "" : "s"}:** ${providers.join(", ")}\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}${r.snippet ? `\n\n${r.snippet}` : ""}\n\n`;
	}
	return output;
}

function boundSearchPresentation(
	text: string,
	guidance: string,
	truncationGuidance: string,
	maxChars: number,
): { text: string; truncated: boolean; originalChars: number; returnedChars: number; omittedChars: number } {
	const fullText = `${text}${guidance}`;
	if (fullText.length <= maxChars) {
		return { text: fullText, truncated: false, originalChars: text.length, returnedChars: text.length, omittedChars: 0 };
	}
	const marker = `\n\n---\n[Output truncated.]${truncationGuidance}`;
	// Reserve marker space so the complete model-visible response never exceeds the configured ceiling.
	const prefixLength = maxChars - marker.length;
	const bounded = `${text.slice(0, prefixLength)}${marker}`;
	return {
		text: bounded,
		truncated: true,
		originalChars: text.length,
		returnedChars: prefixLength,
		omittedChars: text.length - prefixLength,
	};
}

function abortPendingFetches(): void {
	for (const controller of pendingFetches.values()) {
		controller.abort();
	}
	pendingFetches.clear();
}

function handleSessionChange(ctx: ExtensionContext): void {
	abortPendingFetches();
	clearCloneCache();
	sessionActive = true;
	restoreFromSession(ctx);
	activityMonitor.clear();
}

export default function (pi: ExtensionAPI) {
	const initConfig = loadConfigForExtensionInit();
	const fetchModeConfig = resolveFetchModeConfig(initConfig);
	const toolActivation = initConfig.toolActivation ?? "auto";
	if (toolActivation !== "auto" && toolActivation !== "dynamic" && toolActivation !== "eager") {
		throw new Error(`toolActivation in ${WEB_SEARCH_CONFIG_PATH} must be "auto", "dynamic", or "eager"`);
	}
	const allowedSearchProviders = initConfig.webSearch?.allowedProviders === undefined ? RESOLVED_SEARCH_PROVIDERS : getAllowedSearchProviders();
	const allEligibleProviders = allowedSearchProviders.filter(provider => ALL_SEARCH_PROVIDERS.includes(provider));
	const allExcludedProviders = allowedSearchProviders.filter(provider => !ALL_SEARCH_PROVIDERS.includes(provider));
	const allPolicyDescription = allEligibleProviders.length === 0
		? `all has no eligible allowed providers; explicit-only allowed providers (${allExcludedProviders.map(providerLabel).join(", ")}) remain excluded`
		: allExcludedProviders.length > 0
		? `all searches eligible allowed providers (${allEligibleProviders.map(providerLabel).join(", ")}); explicit-only allowed providers (${allExcludedProviders.map(providerLabel).join(", ")}) remain excluded`
		: `all searches every eligible allowed provider (${allEligibleProviders.map(providerLabel).join(", ")})`;
	const toolNames = resolveToolNames(initConfig);
	const webSearchEnabled = isToolEnabled(initConfig, "webSearch");
	const sourceCheckEnabled = isToolEnabled(initConfig, "sourceCheck");
	const fetchContentEnabled = isToolEnabled(initConfig, "fetchContent");
	const getSearchContentEnabled = isToolEnabled(initConfig, "getSearchContent");
	// Names as registered this session, so fetch failure guidance never points
	// at tools that are disabled or were renamed after init.
	const registeredToolNames = {
		...(webSearchEnabled ? { webSearch: toolNames.webSearch } : {}),
		...(fetchContentEnabled ? { fetchContent: toolNames.fetchContent } : {}),
	};
	const storedContentSources = joinToolNames([
		...(webSearchEnabled ? [toolNames.webSearch] : []),
		...(sourceCheckEnabled ? [toolNames.sourceCheck] : []),
		...(fetchContentEnabled ? [toolNames.fetchContent] : []),
	]);
	const searchQueryDescription = webSearchEnabled
		? `Get content for this query (${toolNames.webSearch})`
		: "Get content for a stored search query";
	const fetchContentStorageNote = getSearchContentEnabled
		? `Full original content is stored for retrieval with ${toolNames.getSearchContent}.`
		: "Full original content is stored internally, but the retrieval tool is not registered.";
	const fetchModeDescription = fetchModeConfig.allowedModes
		.map(mode => `${mode}${mode === fetchModeConfig.defaultMode ? " (default)" : ""}: ${FETCH_MODE_DESCRIPTIONS[mode]}`)
		.join("; ");

	function startBackgroundFetch(urls: string[], proxy?: string): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		Promise.resolve()
			.then(() => runWithProxy(proxy, () => fetchAllContent(urls, controller.signal, withRegisteredFetchOptions(undefined, registeredToolNames, proxy))))
			.then((fetched) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const data = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
				const ok = fetched.filter(f => !f.error).length;
				const availability = ok === fetched.length
					? "Full page content now available."
					: ok > 0
						? "Partial page content now available."
						: "No page content was fetched. Stored fetch diagnostics are available.";
				pi.sendMessage(
					{
						customType: "web-search-content-ready",
						content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. ${availability}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			})
			.catch((err) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					pi.sendMessage(
						{
							customType: "web-search-error",
							content: `Content fetch failed [${fetchId}]: ${message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			})
			.finally(() => { pendingFetches.delete(fetchId); });
		return fetchId;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	interface SearchReturnOptions {
		queryList: string[];
		results: QueryResultData[];
		urls: string[];
		includeContent: boolean;
		inlineContent?: ExtractedContent[];
		workflow?: SummaryWorkflow;
		approvedSummary?: string;
		summaryMeta?: SummaryMeta;
		proxy?: string;
	}

	async function loadSummaryModelChoices(
		summaryContext: SummaryGenerationContext,
	): Promise<{ summaryModels: Array<{ value: string; label: string }>; defaultSummaryModel: string | null }> {
		const summaryModels: Array<{ value: string; label: string }> = [];
		const seen = new Set<string>();
		const availableValues = new Set<string>();

		const addModel = (provider: string, id: string) => {
			const value = `${provider}/${id}`;
			if (seen.has(value)) return;
			seen.add(value);
			summaryModels.push({ value, label: value });
		};

		for (const model of summaryContext.modelRegistry.getAvailable()) {
			if (!isModelInScope(model, summaryContext.scopedModels)) continue;
			availableValues.add(`${model.provider}/${model.id}`);
			addModel(model.provider, model.id);
		}

		const currentModelValue = summaryContext.model
			? `${summaryContext.model.provider}/${summaryContext.model.id}`
			: null;
		if (summaryContext.model && currentModelValue && !seen.has(currentModelValue) && isModelInScope(summaryContext.model, summaryContext.scopedModels)) {
			addModel(summaryContext.model.provider, summaryContext.model.id);
		}

		const config = loadConfig();
		const configuredSummaryModel = typeof config.summaryModel === "string" ? config.summaryModel.trim() : "";
		const preferredDefaults = [
			{ provider: "anthropic", id: "claude-haiku-4-5" },
			{ provider: "openai-codex", id: "gpt-5.6-luna" },
			{ provider: "openai-codex", id: "gpt-5.6-terra" },
			{ provider: "google", id: "gemini-3.6-flash" },
			{ provider: "openai", id: "gpt-5-mini" },
			{ provider: "deepseek", id: "deepseek-v4-flash" },
		];

		const resolveAvailableModelValue = (selector: string): string | null => {
			const parsed = splitThinkingSuffix(selector);
			const slashIndex = parsed.value.indexOf("/");
			if (slashIndex <= 0 || slashIndex >= parsed.value.length - 1) return null;
			const model = findModelWithProviderRouting(
				summaryContext.modelRegistry,
				parsed.value.slice(0, slashIndex),
				parsed.value.slice(slashIndex + 1),
			);
			if (!model) return null;
			const value = `${model.provider}/${model.id}`;
			if (!availableValues.has(value)) return null;
			if (selector !== value && !seen.has(selector)) {
				seen.add(selector);
				summaryModels.push({ value: selector, label: selector });
			}
			return selector;
		};

		let defaultSummaryModel: string | null = null;
		if (configuredSummaryModel.length > 0) {
			defaultSummaryModel = availableValues.has(configuredSummaryModel)
				? configuredSummaryModel
				: resolveAvailableModelValue(configuredSummaryModel);
		}
		if (!defaultSummaryModel) {
			for (const preferred of preferredDefaults) {
				const model = findModelWithProviderRouting(summaryContext.modelRegistry, preferred.provider, preferred.id);
				const value = model ? `${model.provider}/${model.id}` : null;
				if (value && availableValues.has(value)) {
					defaultSummaryModel = value;
					break;
				}
			}
		}
		return { summaryModels, defaultSummaryModel };
	}

	function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<Record<string, unknown>> {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		const hasApprovedSummary = typeof opts.approvedSummary === "string" && opts.approvedSummary.trim().length > 0;
		const maxInlineContentChars = getMaxInlineContentChars(initConfig);
		let output = "";
		if (hasApprovedSummary) {
			output = opts.approvedSummary!.trim();
		} else {
			const providerNames = opts.results.map(result => {
				const providers = result.providers ?? (result.provider ? [result.provider] : []);
				return providers.join(", ") || "unknown";
			});
			output += opts.results.length === 1
				? `**Provider:** ${providerNames[0]}\n\n`
				: `**Providers used:** ${providerNames.map((name, index) => `Query ${index + 1}: ${name}`).join("; ")}\n\n`;
			for (const { query, answer, results, error } of opts.results) {
				if (opts.queryList.length > 1) {
					output += `## Query: "${query}"\n\n`;
				}
				if (error) output += `Error: ${error}\n\n`;
				else output += formatSearchSummary(results, answer) + "\n\n";
			}
		}

		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		let fetchId: string | null = null;
		if (hasInlineReady && opts.inlineContent) {
			fetchId = generateId();
			const data = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
			pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
		} else if (opts.includeContent) {
			fetchId = startBackgroundFetch(opts.urls, opts.proxy);
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !hasInlineReady;
		const unboundedPresentation = output.trim();
		const buildGuidance = (forTruncation: boolean): string => {
			let value = "";
			if (hasInlineReady && opts.inlineContent && fetchId) {
				value += `\n---\nFull content for ${opts.inlineContent.length} sources is ready as responseId "${fetchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${fetchId}", urlIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page.`
					: forTruncation ? `Enable ${toolNames.getSearchContent} to retrieve the full stored content.` : "";
			} else if (isBackgroundFetch && fetchId) {
				value += `\n---\nContent fetching in background as responseId "${fetchId}". Will notify when ready.`;
			}
			if (getSearchContentEnabled || forTruncation) {
				value += `\n---\nFull search results are stored as responseId "${searchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${searchId}", queryIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page${opts.results.length > 1 ? `; repeat with queryIndex 1 through ${opts.results.length - 1}` : ""}.`
					: `Enable ${toolNames.getSearchContent} to retrieve the full stored results.`;
			}
			return value;
		};
		const presentation = hasApprovedSummary
			? { text: unboundedPresentation, truncated: false, originalChars: unboundedPresentation.length, returnedChars: unboundedPresentation.length, omittedChars: 0 }
			: boundSearchPresentation(unboundedPresentation, buildGuidance(false), buildGuidance(true), maxInlineContentChars);

		return {
			content: [{ type: "text", text: presentation.text }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
				queryProviders: opts.results.map(result => ({
					query: result.query,
					providers: result.providers ?? (result.provider ? [result.provider] : []),
				})),
				truncated: presentation.truncated,
				originalChars: presentation.originalChars,
				returnedChars: presentation.returnedChars,
				omittedChars: presentation.omittedChars,
				...((opts.workflow && hasApprovedSummary)
					? {
						summary: {
							text: opts.approvedSummary!.trim(),
							workflow: opts.workflow,
							model: opts.summaryMeta?.model ?? null,
							durationMs: opts.summaryMeta?.durationMs ?? 0,
							tokenEstimate: opts.summaryMeta?.tokenEstimate ?? 0,
							fallbackUsed: opts.summaryMeta?.fallbackUsed === true,
							fallbackReason: opts.summaryMeta?.fallbackReason,
							phase: opts.summaryMeta?.phase,
							edited: opts.summaryMeta?.edited === true,
						},
					}
					: {}),
			},
		};
	}

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		sessionActive = false;
		abortPendingFetches();
		clearCloneCache();
		clearResults();
		activityMonitor.clear();
	});

	if (webSearchEnabled) pi.registerTool({
		name: toolNames.webSearch,
		label: "Web Search",
		description:
			`Search the web with ${allowedSearchProviders.map(providerLabel).join(", ")}. Provider arrays run simultaneously; ${allPolicyDescription}. The default workflow is none: it returns bounded source-linked search results or provider answers without a generated summary, identifies the providers used, and stores full results for retrieval by responseId. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query. When includeContent is true, full page content is fetched in the background. Set workflow to "auto-summary" to generate a grounded summary of the results with a separate model call. The configured provider is used when provider is omitted or set to auto; omit provider unless explicitly overriding it.`,
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage. Omit provider unless explicitly overriding the configured default.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched concurrently (up to three at a time), each returning source-linked search results or a provider answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			provider: Type.Optional(searchProviderSchema(`Search provider or non-empty list of allowed providers to search simultaneously; ${allPolicyDescription}; omit this field to use the configured provider, or use auto when none is configured`, allowedSearchProviders)),
			workflow: Type.Optional(
				StringEnum([...SEARCH_WORKFLOWS], {
					description: "Search workflow mode: none = return raw results (default), auto-summary = generate a grounded summary of the search results",
				}),
			),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for every outbound request in this call (search APIs and content fetches). Node fetch ignores HTTP(S)_PROXY env vars, so set this (or `proxy` in web-search.json) when direct access is blocked; empty string forces direct access.",
			})),
		}),

		async execute(_callId, params, signal, onUpdate, ctx) {
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const rawQueryList: unknown[] = Array.isArray(params.queries)
					? params.queries
					: (params.query !== undefined ? expandQueryString(params.query) : []);
				const queryList = normalizeQueryList(rawQueryList);
				const configWorkflow = loadConfigForExtensionInit().workflow;
				const workflow = params.workflow !== undefined
					? normalizeSearchWorkflow(params.workflow)
					: normalizeSearchWorkflow(configWorkflow);
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

				if (queryList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
						details: { error: "No query provided" },
					};
				}

				let completedSearches = 0;
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = resolveRequestedProvider(params.provider);

			const queryResponses = await runSearchQueries(queryList, async (query) => {
				signal?.throwIfAborted();
				onUpdate?.({
					content: [{ type: "text", text: `Searching "${query}" (${completedSearches}/${queryList.length} complete)...` }],
					details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider, providerResponses } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
						extensionContext: ctx,
					});

					const providers = providerResponses?.map(response => response.provider) ?? [provider];
					return { result: { query, answer, results, error: null, provider, providers } satisfies QueryResultData, inlineContent };
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const failedProvider = toFailureProvider(resolvedProvider);
					return {
						result: { query, answer: "", results: [], error: message, provider: failedProvider } satisfies QueryResultData,
						inlineContent: undefined,
					};
				} finally {
					completedSearches++;
					if (!signal?.aborted) {
						onUpdate?.({
							content: [{ type: "text", text: `Completed ${completedSearches}/${queryList.length} searches.` }],
							details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
						});
					}
				}
			});
			const searchResults = queryResponses.map(response => response.result);
			for (const response of queryResponses) {
				for (const result of response.result.results) {
					if (!allUrls.includes(result.url)) allUrls.push(result.url);
				}
				if (response.inlineContent) allInlineContent.push(...response.inlineContent);
			}

			let approvedSummary: string | undefined;
			let summaryMeta: SummaryMeta | undefined;
			if (workflow === "auto-summary") {
				if (!ctx) {
					return {
						content: [{ type: "text", text: "Error: Auto-summary requires an active extension context." }],
						details: { error: "Missing extension context" },
					};
				}
				onUpdate?.({
					content: [{ type: "text", text: "Generating summary..." }],
					details: { phase: "generating-summary", progress: 1 },
				});
				const summaryContext: SummaryGenerationContext = {
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					sessionManager: ctx.sessionManager,
					scopedModels: ctx.scopedModels,
				};
				const summaryModelChoices = await loadSummaryModelChoices(summaryContext);
				try {
					const generated = await generateSummaryDraft(
						searchResults,
						summaryContext,
						signal,
						summaryModelChoices.defaultSummaryModel ?? undefined,
						undefined,
						undefined,
						getSummaryGenerationDeadlineMs(),
						getSummaryInstructions(),
					);
					approvedSummary = generated.summary;
					summaryMeta = generated.meta;
				} catch (err) {
					const isEmptyResponse = err instanceof Error && err.message.includes("Summary model returned empty response");
					if (!isEmptyResponse) throw err;
					const deterministic = buildDeterministicSummary(searchResults);
					approvedSummary = deterministic.summary;
					summaryMeta = { ...deterministic.meta, fallbackReason: "summary-model-empty-response" };
				}
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
				workflow: workflow === "auto-summary" ? "auto-summary" : undefined,
				approvedSummary,
				summaryMeta,
				proxy: typeof params.proxy === "string" ? params.proxy : undefined,
			});
			});
		},

		renderCall(args) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? expandQueryString(input.query) : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return "search (no query)";
			}
			if (queryList.length === 1) {
				return `search "${queryList[0]}"`;
			}
			const lines = [`search ${queryList.length} queries`];
			for (const q of queryList.slice(0, 5)) {
				lines.push(`  "${q}"`);
			}
			if (queryList.length > 5) {
				lines.push(`  ... and ${queryList.length - 5} more`);
			}
			return lines.join("\n");
		},

		renderResult(result, { expanded, isPartial }) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
				currentQuery?: string;
				summary?: {
					text: string;
					workflow: string;
					model: string | null;
					durationMs: number;
					tokenEstimate: number;
					fallbackUsed: boolean;
					fallbackReason?: string;
					phase?: string;
					edited?: boolean;
				};
			};

			if (isPartial) {
				if (details?.phase === "generating-summary") {
					return "generating summary draft...";
				}
				if (details?.phase === "searching") {
					const progress = details?.progress ?? 0;
					const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
					const query = details?.currentQuery || "";
					const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
					return `[${bar}] ${display}`;
				}
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return `[${bar}] ${details?.phase || "searching"}`;
			}

			if (details?.error) {
				// Expandable diagnostics: which queries completed, per-query errors.
				// See render-search-error.ts.
				const plan = buildSearchErrorPlan(details as SearchErrorDetails);
				if (plan) return renderSearchErrorPlan(plan, expanded);
				return `Error: ${details.error}`;
			}

			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			let statusLine = `${queryInfo}${details?.totalResults ?? 0} sources`;
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += ` (fetching ${details.fetchUrls.length} URLs)`;
			} else if (details?.fetchId) {
				statusLine += " (content ready)";
			}

			// Build expanded lines first so collapsed view can reference total count
			const lines = [statusLine];
			if (details?.summary?.text) {
				lines.push("");
				lines.push(`── Summary (${details.summary.workflow}) ` + "─".repeat(32));
				lines.push("");
				for (const line of details.summary.text.split("\n")) {
					lines.push(`  ${line}`);
				}
				lines.push("");
				const metaParts = [
					details.summary.model ? `model=${details.summary.model}` : "model=deterministic",
					`duration=${details.summary.durationMs}ms`,
					`tokens~${details.summary.tokenEstimate}`,
					details.summary.fallbackUsed ? "fallback=true" : "fallback=false",
					details.summary.phase ? `phase=${details.summary.phase}` : "",
					details.summary.edited ? "edited=true" : "edited=false",
				];
				if (details.summary.fallbackReason) {
					metaParts.push(`reason=${details.summary.fallbackReason}`);
				}
				lines.push("  " + metaParts.filter(Boolean).join(" · "));
			}

			{
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				for (const line of preview.split("\n")) {
					lines.push(line);
				}
			}

			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				lines.push(`Fetching ${details.fetchUrls.length} URLs in background:`);
				for (const u of details.fetchUrls.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push("  " + display);
				}
				if (details.fetchUrls.length > 5) {
					lines.push(`  ... and ${details.fetchUrls.length - 5} more`);
				}
			}

			const totalLines = lines.length;

			if (!expanded) {
				const collapsedLines: string[] = [statusLine];
				const summaryPreview = details?.summary?.text?.trim() || "";
				if (summaryPreview) {
					collapsedLines.push(summaryPreview.length > 120 ? summaryPreview.slice(0, 117) + "..." : summaryPreview);
				} else {
					const textContent = result.content.find((c) => c.type === "text")?.text || "";
					const firstContentLine = textContent.split("\n").find(l => {
						const t = l.trim();
						return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
					});
					const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
					if (fallbackLine) {
						collapsedLines.push(fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine);
					}
				}
				const moreLines = Math.max(0, totalLines - collapsedLines.length);
				if (moreLines > 0) {
					collapsedLines.push(`... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`);
				}
				return collapsedLines.join("\n");
			}

			return lines.join("\n");
		},
	});

	if (sourceCheckEnabled) pi.registerTool({
		name: toolNames.sourceCheck,
		label: "Source Check",
		description: "Gather web sources for a claim and return a bounded machine-readable research artifact with exact passage citations for manual review.",
		promptSnippet: "Gather structured source evidence and passage-level citations for manual semantic review of a claim.",
		parameters: Type.Object({
			claim: Type.String({ description: "The assertion to gather web sources for." }),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Search queries (default: the claim)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)." })),
			fetchContent: Type.Optional(Type.Boolean({ description: "Fetch up to 5 result pages for exact passage extraction." })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency." })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude." })),
			provider: Type.Optional(searchProviderSchema(`Search provider or non-empty list of allowed providers to search simultaneously; ${allPolicyDescription}`, allowedSearchProviders)),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for every outbound request in this call (search APIs and result-page fetches). Empty string forces direct access.",
			})),
		}),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const claim = typeof params.claim === "string" ? params.claim.trim() : "";
				if (!claim) {
					return { content: [{ type: "text", text: "Error: 'claim' is required." }], details: { error: "Missing claim" } };
				}

				const requestedQueries = Array.isArray(params.queries)
					? params.queries.filter((query): query is string => typeof query === "string").map((query) => query.trim()).filter(Boolean)
					: [];
				const queries = (requestedQueries.length > 0 ? requestedQueries : [claim]).slice(0, 8);
				const numResults = typeof params.numResults === "number" && Number.isFinite(params.numResults)
					? Math.min(20, Math.max(1, Math.floor(params.numResults)))
					: 5;
				const domainFilter = Array.isArray(params.domainFilter)
					? params.domainFilter.filter((domain): domain is string => typeof domain === "string")
					: undefined;
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
				const resultsByUrl = new Map<string, SearchResult>();
				const summaries: string[] = [];
				const errors: Array<{ query: string; error: string }> = [];
				let provider: string | undefined;

				for (const query of queries) {
					if (signal?.aborted) break;
					try {
						const response = await search(query, {
							provider: resolveRequestedProvider(params.provider),
							numResults,
							recencyFilter,
							domainFilter,
							signal,
							extensionContext: ctx,
						});
						if (signal?.aborted) break;
						provider ??= response.provider;
						if (response.answer) summaries.push(`${query}: ${response.answer}`);
						for (const result of response.results) {
							if (!resultsByUrl.has(result.url)) resultsByUrl.set(result.url, result);
						}
					} catch (err) {
						if (signal?.aborted || isAbortError(err)) break;
						errors.push({ query, error: err instanceof Error ? err.message : String(err) });
					}
				}

				const results = [...resultsByUrl.values()].slice(0, 20).map((result, index) => ({ ...result, rank: index + 1 }));
				let fetched: ExtractedContent[] = [];
				if (params.fetchContent && results.length > 0) {
					const urls = results.slice(0, 5).map((result) => result.url);
					try {
						fetched = await fetchAllContent(urls, signal, withRegisteredFetchOptions(undefined, registeredToolNames, typeof params.proxy === "string" ? params.proxy : undefined));
					} catch (err) {
						if (signal?.aborted || isAbortError(err)) throw err;
						fetched = urls.map((url) => ({ url, title: "", content: "", error: err instanceof Error ? err.message : String(err) }));
					}
				}
				const artifact = withClaimAssessment(buildResearchArtifact({
					query: claim,
					provider,
					summary: summaries.length > 0 ? summaries.join("\n\n") : undefined,
					results,
					fetched,
					recency: recencyFilter,
					domainFilter,
				}), [claim]);
				if (errors.length > 0) artifact.errors = errors;
				storeResearchArtifact(artifact);
				pi.appendEntry("web-search-results", {
					id: artifact.id,
					type: "research",
					timestamp: artifact.timestamp,
					artifact,
				});
				return {
					content: [{ type: "text", text: formatSourceCheckResult(artifact, getSearchContentEnabled ? toolNames.getSearchContent : null) }],
					details: { responseId: artifact.id, artifact, sourceCount: artifact.sources.length, passageCount: artifact.passages.length },
				};
			});
		},
	});

	if (fetchContentEnabled) pi.registerTool({
		name: toolNames.fetchContent,
		label: "Fetch Content",
		description: `Fetch URL(s). Available modes: ${fetchModeDescription}. Direct image URLs return resized image content when supported by the selected mode. Supports GitHub repositories and PDFs. ${fetchContentStorageNote}`,
		promptSnippet:
			"Use to fetch URL content, direct images, and GitHub repos.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			prompt: Type.Optional(Type.String({
				description: "Question or instruction required by answer mode.",
			})),
			mode: Type.Optional(StringEnum(fetchModeConfig.allowedModes, {
				description: `Fetch mode. ${fetchModeDescription}.`,
			})),
			...(fetchModeConfig.allowedModes.includes("answer") ? {
				answerModel: Type.Optional(Type.String({
					description: "Optional provider/model-id override for answer mode. Defaults to fetch.answerProvider + fetch.answerModel when configured, otherwise the current model.",
				})),
			} : {}),
			proxy: Type.Optional(Type.String({
				description: "http(s) or socks proxy URL (e.g. http://host:port or socks5h://host:port) used for this fetch. Needed when the target is unreachable directly; localhost and NO_PROXY hosts always bypass the proxy. Empty string forces direct access.",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			let normalized: ReturnType<typeof normalizeFetchContentParams>;
			try {
				normalized = normalizeFetchContentParams(params);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
			const { urlList, options } = normalized;
			const mode = options.mode ?? fetchModeConfig.defaultMode;
			if (!fetchModeConfig.allowedModes.includes(mode)) {
				const error = `Fetch mode "${mode}" is disabled by fetch.allowedModes.`;
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
			return runWithProxy(options.proxy, async () => {
				if (mode === "answer" && !options.prompt) {
					return { content: [{ type: "text", text: "Error: mode answer requires prompt." }], details: { error: "mode answer requires prompt" } };
				}
				if (mode === "raw" && (options.forceClone === true || options.prompt || options.answerModel)) {
					return { content: [{ type: "text", text: "Error: mode raw cannot be combined with forceClone, prompt, or answerModel." }], details: { error: "Incompatible raw mode options" } };
				}
				if (mode !== "answer" && options.answerModel) {
					return { content: [{ type: "text", text: "Error: answerModel requires mode answer." }], details: { error: "answerModel requires mode answer" } };
				}
				if (urlList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No URL provided." }],
						details: { error: "No URL provided" },
					};
				}

				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
					details: { phase: "fetch", progress: 0 },
				});

				const { answerModel: _answerModel, ...extractionOptions } = { ...options, mode };
				const { prompt: _prompt, ...answerExtractionOptions } = extractionOptions;
				const fetchOptions = mode === "answer" ? answerExtractionOptions : extractionOptions;
				const fetchResults = await fetchAllContent(urlList, signal, withRegisteredFetchOptions(fetchOptions, registeredToolNames, options.proxy));
				const presentedResults = mode === "answer"
					? await Promise.all(fetchResults.map(async result => {
						if (result.error) return result;
						if (result.thumbnail || result.mimeType?.startsWith("image/")) {
							return { ...result, error: "Page answer requires textual fetched content" };
						}
						try {
							const answer = await answerFromPage({
								question: options.prompt!,
								pageText: result.content,
								sourceUrl: result.url,
								...(options.answerModel ? { model: options.answerModel } : {}),
							}, ctx, signal);
							return { ...result, content: answer.text };
						} catch (err) {
							return { ...result, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
						}
					}))
					: fetchResults;
				const successful = presentedResults.filter((r) => !r.error).length;
				const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);

				const responseId = generateId();
				const data = {
					id: responseId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetchResults),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				storeFetchResult(pi, responseId, data);

				if (urlList.length === 1) {
					const result = presentedResults[0];
					if (result.error) {
						return {
							content: [{ type: "text", text: `Error: ${result.error}` }],
							details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, responseId, prompt: params.prompt },
						};
					}

					const fullLength = result.content.length;
					const slice = initialContentSlice(result.content, getMaxInlineContentChars());
					const truncated = slice.endOffset < fullLength;
					let output = slice.text;

					if (truncated) {
						output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. `;
						output += getSearchContentEnabled
							? `Use ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`
							: "Content retrieval is not registered.";
					}

					const content: Array<TextContent | ImageContent> = [];
					if (result.thumbnail) {
						content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
					}
					content.push({ type: "text", text: output });

					const imageCount = result.thumbnail ? 1 : 0;
					return {
						content,
						details: {
							urls: urlList,
							urlCount: 1,
							successful: 1,
							totalChars: fullLength,
							title: result.title,
							responseId,
							truncated,
							hasImage: imageCount > 0,
							imageCount,
							prompt: params.prompt,
							mode,
							mimeType: result.mimeType,
							status: result.status,
							totalBytes: slice.totalBytes,
							totalLines: slice.totalLines,
							shownBytes: slice.shownBytes,
							shownLines: slice.shownLines,
						},
					};
				}

				let output = "## Fetched URLs\n\n";
				for (const { url, title, content, error } of presentedResults) {
					if (error) {
						output += `- ${url}: Error - ${error}\n`;
					} else {
						output += `- ${title || url} (${content.length} chars)\n`;
					}
				}
				output += getSearchContentEnabled
					? `\n---\nUse ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`
					: "\n---\nContent retrieval is not registered.";

				return {
					content: [{ type: "text", text: output }],
					details: { urls: urlList, urlCount: urlList.length, successful, totalChars, responseId },
				};
			});
		},

		renderCall(args, theme) {
			let normalized: ReturnType<typeof normalizeFetchContentParams>;
			try {
				normalized = normalizeFetchContentParams(args);
			} catch {
				return "fetch (invalid parameters)";
			}
			const { urlList, options } = normalized;
			const { prompt, mode, answerModel } = options;
			if (urlList.length === 0) {
				return "fetch (no URL)";
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				lines.push(`fetch ${urlList[0]}`);
			} else {
				lines.push(`fetch ${urlList.length} URLs`);
				for (const u of urlList.slice(0, 5)) {
					lines.push("  " + u);
				}
				if (urlList.length > 5) {
					lines.push(`  ... and ${urlList.length - 5} more`);
				}
			}
			if (mode && mode !== "readable") {
				lines.push(`  mode: ${mode}`);
			}
			if (prompt) {
				const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
				lines.push(`  prompt: "${display}"`);
			}
			if (answerModel) {
				lines.push(`  answer model: ${answerModel}`);
			}
			return lines.join("\n");
		},

		renderResult(result, { expanded, isPartial }) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
				hasImage?: boolean;
				imageCount?: number;
				prompt?: string;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return `[${bar}] ${details?.phase || "fetching"}`;
			}

			if (details?.error) {
				const fd = details as typeof details & { urls?: string[] };
				const extras: string[] = [];
				if (typeof fd.urlCount === "number" || typeof fd.successful === "number") {
					extras.push(`urls: ${fd.successful ?? 0}/${fd.urlCount ?? 0} succeeded`);
				}
				if (fd.responseId) extras.push(`response id: ${fd.responseId}`);
				if (fd.urls && fd.urls.length > 0) {
					for (const u of fd.urls.slice(0, 8)) extras.push(`  \u25b8 ${u}`);
					if (fd.urls.length > 8) extras.push(`  ... and ${fd.urls.length - 8} more`);
				}
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded);
				return `Error: ${details.error}`;
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
				const imageBadge = imgCount > 1
					? ` [${imgCount} images]`
					: imgCount === 1
						? " [image]"
						: "";
				let statusLine = `${title} (${details?.totalChars ?? 0} chars)${imageBadge}`;
				if (details?.truncated) {
					statusLine += " [truncated]";
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return statusLine + "\n" + brief;
				}
				const lines = [statusLine];
				if (details?.prompt) {
					const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
					lines.push(`  prompt: "${display}"`);
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				lines.push(preview);
				return lines.join("\n");
			}

			const statusLine = `${details?.successful}/${details?.urlCount} URLs${getSearchContentEnabled ? " (content stored)" : " (content fetched)"}`;
			if (!expanded) {
				return statusLine;
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return statusLine + "\n" + preview;
		},
	});

	if (getSearchContentEnabled) {
		const maxInlineContentChars = getMaxInlineContentChars(initConfig);
		pi.registerTool({
		name: toolNames.getSearchContent,
		label: "Get Search Content",
		description: `Retrieve bounded pages of full stored search results or fetched content, or find matching passages, from a previous ${storedContentSources} call.`,
		promptSnippet:
			`Use after ${storedContentSources} to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.`,
		parameters: Type.Object({
			responseId: Type.String({ description: `The responseId from ${storedContentSources}` }),
			query: Type.Optional(Type.String({ description: searchQueryDescription })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset in stored search or fetched URL content (default 0). Ignored when findText is supplied." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxInlineContentChars, description: "Requested maximum stored-content characters (default and max use maxInlineContentChars). Search-page continuation guidance shares the global output cap and may reduce returnedChars. Ignored when findText is supplied." })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Text or texts to find in the selected stored content. When supplied, offset and limit are ignored." })),
			findMode: Type.Optional(StringEnum(["exact", "case-insensitive", "fuzzy"], { description: "Matching mode for findText (default: case-insensitive). Requires findText." })),
		}),

		async execute(_toolCallId, rawParams): Promise<AgentToolResult<Record<string, unknown>>> {
			const params = normalizeGetSearchContentParams(rawParams);
			if (params.findMode !== undefined && params.findText === undefined) {
				return {
					content: [{ type: "text", text: `findMode ${formatInputValue(params.findMode)} requires findText; provide findText or omit findMode.` }],
					details: { error: "findMode requires findText" },
				};
			}
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for responseId ${formatInputValue(params.responseId)}. Use a responseId returned by ${storedContentSources}.` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "research") {
				const artifact = getResearchArtifact(params.responseId);
				if (!artifact) {
					return {
						content: [{ type: "text", text: `Error: stored research artifact for responseId ${formatInputValue(params.responseId)} was not found. Use a responseId returned by ${storedContentSources}.` }],
						details: { error: "Artifact not found", responseId: params.responseId },
					};
				}
				const serialized = JSON.stringify(artifact, null, 2);
				if (params.findText !== undefined) {
					try {
						const found = findContent(serialized, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text }],
							details: { responseId: artifact.id, type: "research", contentLength: serialized.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in research artifact for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, responseId: params.responseId, type: "research" },
						};
					}
				}
				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for responseId ${formatInputValue(params.responseId)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for responseId ${formatInputValue(params.responseId)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > serialized.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${serialized.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: serialized.length },
					};
				}
				const endOffset = Math.min(offset + limit, serialized.length);
				const artifactSlice = serialized.slice(offset, endOffset);
				const hasMore = endOffset < serialized.length;
				return {
					content: [{ type: "text", text: artifactSlice }],
					details: { responseId: artifact.id, type: "research", contentLength: serialized.length, offset, limit, returnedChars: artifactSlice.length, nextOffset: hasMore ? endOffset : null, truncated: hasMore },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query ${formatInputValue(params.query)} was not found for responseId ${formatInputValue(params.responseId)}. Received query=${formatInputValue(params.query)}. Available queries: ${available || "none"}. Use one of the available queries or queryIndex.` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query index ${formatInputValue(params.queryIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received queryIndex=${formatInputValue(params.queryIndex)}; valid indexes are 0-${data.queries.length - 1}. Available queries: ${available || "none"}. Use one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex for responseId ${formatInputValue(params.responseId)}. Available queries: ${available || "none"}.` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving query ${formatInputValue(queryData.query)} from responseId ${formatInputValue(params.responseId)}: ${queryData.error}. Check the stored search result and retry with another query or queryIndex if needed.` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				const fullResults = formatFullResults(queryData);
				if (params.findText !== undefined) {
					try {
						const found = findContent(fullResults, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text }],
							details: { responseId: params.responseId, query: queryData.query, resultCount: queryData.results.length, contentLength: fullResults.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in query ${formatInputValue(queryData.query)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, query: queryData.query },
						};
					}
				}

				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for query ${formatInputValue(queryData.query)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for query ${formatInputValue(queryData.query)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > fullResults.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for query ${formatInputValue(queryData.query)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${fullResults.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: fullResults.length },
					};
				}
				const queryIndex = data.queries.indexOf(queryData);
				let returnedChars = Math.min(limit, fullResults.length - offset);
				let endOffset = offset + returnedChars;
				let continuation = "";
				while (endOffset < fullResults.length) {
					continuation = `\n\n---\nShowing chars ${offset}-${endOffset} of ${fullResults.length}. Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", queryIndex: ${queryIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
					const overflow = returnedChars + continuation.length - maxInlineContentChars;
					if (overflow <= 0) break;
					returnedChars -= overflow;
					endOffset = offset + returnedChars;
				}
				const resultSlice = fullResults.slice(offset, endOffset);
				const hasMore = endOffset < fullResults.length;
				const text = `${resultSlice}${hasMore ? continuation : ""}`;
				return {
					content: [{ type: "text", text }],
					details: {
						responseId: params.responseId,
						query: queryData.query,
						resultCount: queryData.results.length,
						contentLength: fullResults.length,
						offset,
						limit,
						returnedChars,
						nextOffset: hasMore ? endOffset : null,
						truncated: hasMore,
					},
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;
				let selectedUrlIndex = -1;

				if (params.url !== undefined) {
					selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url);
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL ${formatInputValue(params.url)} was not found for responseId ${formatInputValue(params.responseId)}. Received url=${formatInputValue(params.url)}. Available URLs:\n  ${available || "  none"}\nUse one of the available URLs or urlIndex.` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					selectedUrlIndex = params.urlIndex;
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
						return {
							content: [{ type: "text", text: `URL index ${formatInputValue(params.urlIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received urlIndex=${formatInputValue(params.urlIndex)}; valid indexes are 0-${data.urls.length - 1}. Available URLs:\n  ${available || "  none"}\nUse one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex for responseId ${formatInputValue(params.responseId)}. Available URLs:\n  ${available || "  none"}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving URL ${formatInputValue(urlData.url)} from responseId ${formatInputValue(params.responseId)}: ${urlData.error}. Check the stored fetch result and retry with another URL or urlIndex if needed.` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				if (params.findText !== undefined) {
					try {
						const found = findContent(urlData.content, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text: `# ${urlData.title || urlData.url}\n\n${text}` }],
							details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in URL ${formatInputValue(urlData.url)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, url: urlData.url },
						};
					}
				}

				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for URL ${formatInputValue(urlData.url)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for URL ${formatInputValue(urlData.url)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > urlData.content.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for URL ${formatInputValue(urlData.url)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${urlData.content.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: urlData.content.length },
					};
				}

				const endOffset = Math.min(offset + limit, urlData.content.length);
				const contentSlice = urlData.content.slice(offset, endOffset);
				const hasMore = endOffset < urlData.content.length;
				let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`;
				if (hasMore || offset > 0) {
					text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`;
					if (hasMore) {
						text += ` Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
					}
				}

				return {
					content: [{ type: "text", text }],
					details: {
						url: urlData.url,
						title: urlData.title,
						contentLength: urlData.content.length,
						offset,
						limit,
						returnedChars: contentSlice.length,
						nextOffset: hasMore ? endOffset : null,
						truncated: hasMore,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Invalid stored data for responseId ${formatInputValue(params.responseId)}: received type ${formatInputValue(data.type)}. Use a responseId returned by ${storedContentSources}.` }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex, offset, findText } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
				offset?: number;
				findText?: string | string[];
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			if (offset !== undefined) target += target ? ` @ ${offset}` : `offset=${offset}`;
			if (findText !== undefined) {
				const queries = Array.isArray(findText) ? findText : [findText];
				target += `${target ? " · " : ""}find ${queries.length}`;
			}
			return `get_content ${target || responseId.slice(0, 8)}`;
		},

		renderResult(result, { expanded }) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
				offset?: number;
				returnedChars?: number;
				nextOffset?: number | null;
				matchCount?: number;
				returnedMatches?: number;
			};

			if (details?.error) {
				const extras: string[] = [];
				if (details.query) extras.push(`query: ${details.query}`);
				if (details.url) extras.push(`url: ${details.url}`);
				else if (details.title) extras.push(`resource: ${details.title}`);
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded);
				return `Error: ${details.error}`;
			}

			let statusLine: string;
			if (typeof details?.matchCount === "number") {
				statusLine = `${details?.title || details?.query || "Content"} (${details.matchCount} matches, ${details.returnedMatches ?? 0} shown)`;
			} else if (details?.query) {
				statusLine = `"${details.query}" (${details.resultCount} results)`;
			} else {
				const start = details?.offset ?? 0;
				const returned = details?.returnedChars ?? details?.contentLength ?? 0;
				const end = start + returned;
				const slice = details?.nextOffset !== undefined || start > 0
					? `, showing ${start}-${end}`
					: "";
				statusLine = `${details?.title || "Content"} (${details?.contentLength ?? 0} chars${slice})`;
			}

			if (!expanded) {
				return statusLine;
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return statusLine + "\n" + preview;
		},
	});
	}

	if (toolActivation !== "eager") registerWebToolActivation(pi, [
		...(webSearchEnabled ? [{ name: toolNames.webSearch, capability: "search" as const }] : []),
		...(sourceCheckEnabled ? [{ name: toolNames.sourceCheck, capability: "source-check" as const }] : []),
		...(fetchContentEnabled ? [{ name: toolNames.fetchContent, capability: "fetch" as const }] : []),
		...(getSearchContentEnabled ? [{ name: toolNames.getSearchContent, capability: "stored-content" as const }] : []),
	], toolActivation);

	if (isCommandEnabled(initConfig, "websearch")) pi.registerCommand("websearch", {
		description: "Search the web and send the results into the session",
		handler: async (args, ctx) => {
			const raw = args.trim();
			const queries = raw.length > 0
				? normalizeQueryList(raw.split(","))
				: [];
			if (queries.length === 0) {
				ctx.ui.notify("Usage: /websearch <query> [, <query>...] — results are sent as a follow-up message", "info");
				return;
			}

			let resolvedProvider: SearchProviderSelection;
			try {
				resolvedProvider = resolveRequestedProvider(undefined);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to load web search config: ${message}`, "error");
				return;
			}

			ctx.ui.notify(`Searching (${queries.length} ${queries.length === 1 ? "query" : "queries"})...`, "info");
			const results: QueryResultData[] = [];
			const urls: string[] = [];
			const inlineContent: ExtractedContent[] = [];
			await runSearchQueries(queries, async (query) => {
				try {
					const response = await search(query, { provider: resolvedProvider });
					for (const result of response.results) {
						if (!urls.includes(result.url)) urls.push(result.url);
					}
					if (response.inlineContent) inlineContent.push(...response.inlineContent);
					const providers = response.providerResponses?.map(entry => entry.provider) ?? [response.provider];
					results.push({ query, answer: response.answer, results: response.results, error: null, provider: response.provider, providers });
				} catch (err) {
					if (isAbortError(err)) return;
					const message = err instanceof Error ? err.message : String(err);
					results.push({ query, answer: "", results: [], error: message, provider: toFailureProvider(resolvedProvider) });
				}
			});

			const payload = buildSearchReturn({
				queryList: queries,
				results,
				urls,
				includeContent: false,
				inlineContent: inlineContent.length > 0 ? inlineContent : undefined,
			});
			pi.sendMessage({
				customType: "web-search-results",
				content: payload.content,
				display: true,
				details: payload.details,
			}, { triggerTurn: true, deliverAs: "followUp" });
		},
	});

	if (isCommandEnabled(initConfig, "search")) pi.registerCommand("search", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && (r.urls || r.urlMetadata)) {
					return `[${r.id.slice(0, 6)}] ${(r.urls ?? r.urlMetadata ?? []).length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && (selected.urls || selected.urlMetadata)) {
					info += "URLs:\n";
					const urlItems = selected.urls ?? selected.urlMetadata ?? [];
					const urls = urlItems.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						const contentLength = "content" in u ? u.content.length : u.contentLength;
						info += `- ${urlDisplay} (${u.error || `${contentLength} chars`})\n`;
					}
					if (urlItems.length > 10) {
						info += `... and ${urlItems.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}
