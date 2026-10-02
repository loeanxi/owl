import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@owl/owl-coding-agent";
import { activityMonitor } from "./activity.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isBraveAvailable, searchWithBrave } from "./brave.ts";
import { isTinyFishAvailable, searchWithTinyFish } from "./tinyfish.ts";
import { isSearch1APIAvailable, searchWithSearch1API } from "./search1api.ts";
import { isSearchinfinityAvailable, searchWithSearchinfinity } from "./searchinfinity.ts";
import { isQueritAvailable, searchWithQuerit } from "./querit.ts";
import { isTavilyAvailable, searchWithTavily } from "./tavily.ts";
import { isYouAvailable, searchWithYou } from "./you.ts";
import { isFirecrawlAvailable, searchWithFirecrawl } from "./firecrawl.ts";
import { isJinaSearchAvailable, searchWithJina } from "./jina-search.ts";
import { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts";
import { isKagiAvailable, searchWithKagi } from "./kagi.ts";
import { isBochaAvailable, searchWithBocha } from "./bocha.ts";
import { isOllamaAvailable, searchWithOllama } from "./ollama.ts";
import { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts";
import { isDuckDuckGoAvailable, searchWithDuckDuckGo } from "./duckduckgo.ts";
import { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts";
import { isXcrawlAvailable, searchWithXCrawl } from "./xcrawl.ts";
import { isXaiSearchAvailable, searchWithXai } from "./xai-search.ts";
import { isBrightDataAvailable, searchWithBrightData } from "./brightdata.ts";
import { isSerpBaseAvailable, searchWithSerpBase } from "./serpbase.ts";
import { isSerpApiAvailable, searchWithSerpApi } from "./serpapi.ts";
import { isSerperAvailable, searchWithSerper } from "./serper.ts";
import { isSerplyAvailable, searchWithSerply } from "./serply.ts";
import { isBaizhiAvailable, searchWithBaizhi } from "./baizhi.ts";
import { isZaiAvailable, searchWithZai } from "./zai.ts";
import { isValyuAvailable, searchWithValyu } from "./valyu.ts";
import { isKimiSearchAvailable, searchWithKimi } from "./kimi-search.ts";
import { isMistralAvailable, searchWithMistral } from "./mistral-search.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export const RESOLVED_SEARCH_PROVIDERS = ["brave", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "you", "firecrawl", "jina", "searxng", "duckduckgo", "perplexity", "kimi", "exa", "serpdive", "kagi", "ollama", "anysearch", "xai", "mistral", "brightdata", "serpbase", "serpapi", "serper", "serply", "valyu", "bocha", "xcrawl", "baizhi", "zai"] as const;
export const SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS] as const;

export type ResolvedSearchProvider = typeof RESOLVED_SEARCH_PROVIDERS[number];
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[];
export type ProviderAvailability = { all: boolean } & Record<ResolvedSearchProvider, boolean>;
export type SearchProviderErrorKind =
	| "transient"
	| "quota"
	| "network"
	| "credential"
	| "config"
	| "auth"
	| "invalid-request"
	| "invalid-response"
	| "unsupported"
	| "aborted"
	| "unknown";

export interface SearchRoutingConfig {
	providers: ResolvedSearchProvider[];
	useCurrentModel?: boolean;
	fallbackOn: Array<Extract<SearchProviderErrorKind, "transient" | "quota" | "network" | "invalid-response" | "unsupported">>;
}

export class SearchProviderError extends Error {
	readonly provider: ResolvedSearchProvider;
	readonly kind: SearchProviderErrorKind;
	readonly status?: number;
	readonly causeError: unknown;

	constructor(
		provider: ResolvedSearchProvider,
		kind: SearchProviderErrorKind,
		message: string,
		status: number | undefined,
		cause: unknown,
	) {
		super(`${provider} search failed (${kind}): ${message}`);
		this.name = "SearchProviderError";
		this.provider = provider;
		this.kind = kind;
		this.status = status;
		this.causeError = cause;
	}
}

export interface ProviderSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

export interface ProviderSearchFailure {
	provider: ResolvedSearchProvider;
	error: string;
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider | "all";
	providerResponses?: ProviderSearchResponse[];
	providerErrors?: ProviderSearchFailure[];
}

const CONFIG_PATH = getWebSearchConfigPath();
// Explicit-only providers (DuckDuckGo, Kimi, AnySearch, XCrawl, xAI, Mistral, Bright Data, SerpBase, SerpApi, Serper, Serply, You.com, Valyu, Baizhi, Z.ai) are deliberately absent:
// `all` must never fan out to an opt-in or paid provider without the user asking for it.
export const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = ["searxng", "exa", "brave", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "firecrawl", "jina", "serpdive", "kagi", "ollama", "perplexity", "bocha"];
const VALID_ROUTING_KINDS = ["transient", "quota", "network", "invalid-response", "unsupported"] as const;

type SearchConfig = {
	searchProvider: SearchProviderSelection;
	searchProviderConfigured: boolean;
	searchRouting?: SearchRoutingConfig;
	searchModel?: string;
	allowedProviders?: ResolvedSearchProvider[];
};

let cachedSearchConfig: SearchConfig | null = null;

function getSearchConfig(): SearchConfig {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto", searchProviderConfigured: false };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const searchModel = normalizeSearchModel(raw.searchModel);
	const webSearch = raw.webSearch;
	if (webSearch !== undefined && (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch))) {
		throw new Error(`webSearch in ${CONFIG_PATH} must be an object`);
	}
	const allowedProviders = webSearch && Object.hasOwn(webSearch, "allowedProviders")
		? normalizeResolvedProviderList((webSearch as Record<string, unknown>).allowedProviders, `webSearch.allowedProviders in ${CONFIG_PATH}`)
		: undefined;
	const searchProviderConfigured = Object.hasOwn(raw, "searchProvider") || Object.hasOwn(raw, "provider");
	const searchProvider = normalizeSearchProviderSelection(raw.searchProvider ?? raw.provider, `provider in ${CONFIG_PATH}`);
	const searchRouting = Object.hasOwn(raw, "searchRouting") ? normalizeSearchRouting(raw.searchRouting) : undefined;
	if (allowedProviders) {
		if (Object.hasOwn(raw, "searchProvider")) {
			assertSearchProviderSelectionAllowed(normalizeSearchProviderSelection(raw.searchProvider), `searchProvider in ${CONFIG_PATH}`, allowedProviders);
		}
		if (Object.hasOwn(raw, "provider")) {
			assertSearchProviderSelectionAllowed(normalizeSearchProviderSelection(raw.provider), `provider in ${CONFIG_PATH}`, allowedProviders);
		}
		if (searchRouting) assertSearchProviderSelectionAllowed(searchRouting.providers, `searchRouting.providers in ${CONFIG_PATH}`, allowedProviders);
	}
	cachedSearchConfig = {
		searchProvider,
		searchProviderConfigured,
		...(searchRouting ? { searchRouting } : {}),
		...(searchModel ? { searchModel } : {}),
		...(allowedProviders ? { allowedProviders } : {}),
	};
	return cachedSearchConfig;
}

function normalizeSearchRouting(value: unknown): SearchRoutingConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`searchRouting in ${CONFIG_PATH} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	const providers = normalizeResolvedProviderList(raw.providers, `searchRouting.providers in ${CONFIG_PATH}`);
	const useCurrentModel = raw.useCurrentModel;
	if (useCurrentModel !== undefined && typeof useCurrentModel !== "boolean") {
		throw new Error(`searchRouting.useCurrentModel in ${CONFIG_PATH} must be a boolean`);
	}
	if (!Array.isArray(raw.fallbackOn) || raw.fallbackOn.length === 0) {
		throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} must be a non-empty array`);
	}
	const fallbackOn: SearchRoutingConfig["fallbackOn"] = [];
	for (const kind of raw.fallbackOn) {
		if (typeof kind !== "string" || !VALID_ROUTING_KINDS.includes(kind as typeof VALID_ROUTING_KINDS[number])) {
			throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} may only contain transient, quota, network, invalid-response, or unsupported`);
		}
		if (!fallbackOn.includes(kind as SearchRoutingConfig["fallbackOn"][number])) {
			fallbackOn.push(kind as SearchRoutingConfig["fallbackOn"][number]);
		}
	}
	return {
		providers,
		...(useCurrentModel !== undefined ? { useCurrentModel: useCurrentModel as boolean } : {}),
		fallbackOn,
	};
}

export function getConfiguredSearchRouting(): SearchRoutingConfig | undefined {
	const config = getSearchConfig();
	return config.searchProviderConfigured ? undefined : config.searchRouting;
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeResolvedProviderList(value: unknown, label: string): ResolvedSearchProvider[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}
	const providers: ResolvedSearchProvider[] = [];
	for (const provider of value) {
		const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
		if (!RESOLVED_SEARCH_PROVIDERS.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} contains an invalid provider: ${String(provider)}`);
		}
		if (providers.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} must not contain duplicates: ${normalized}`);
		}
		providers.push(normalized as ResolvedSearchProvider);
	}
	return providers;
}

export function assertSearchProviderSelectionAllowed(
	selection: SearchProviderSelection,
	label = "provider",
	allowedProviders = getSearchConfig().allowedProviders,
): void {
	if (!allowedProviders) return;
	const requested = Array.isArray(selection)
		? selection
		: selection === "auto" || selection === "all" ? [] : [selection];
	const disabled = requested.filter(provider => !allowedProviders.includes(provider));
	if (disabled.length > 0) {
		throw new Error(`${label} ${disabled.length === 1 ? `references disabled provider "${disabled[0]}"` : `references disabled providers: ${disabled.join(", ")}`}; allowed by webSearch.allowedProviders: ${allowedProviders.join(", ")}`);
	}
}

export function getAllowedSearchProviders(): readonly ResolvedSearchProvider[] {
	return getSearchConfig().allowedProviders ?? RESOLVED_SEARCH_PROVIDERS;
}

export function normalizeSearchProviderSelection(value: unknown, label = "provider"): SearchProviderSelection {
	if (Array.isArray(value)) return normalizeResolvedProviderList(value, label);
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return SEARCH_PROVIDERS.includes(normalized as SearchProvider) ? normalized as SearchProvider : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProviderSelection;
	includeContent?: boolean;
	extensionContext?: ExtensionContext;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function providerErrorStatus(message: string): number | undefined {
	const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
	if (!match) return undefined;
	return Number(match[1]);
}

function classifyProviderError(provider: ResolvedSearchProvider, err: unknown): SearchProviderError {
	if (err instanceof SearchProviderError) return err;
	const message = errorMessage(err);
	const lower = message.toLowerCase();
	const status = providerErrorStatus(message);
	let kind: SearchProviderErrorKind = "unknown";
	const mentionsUnsupportedWebSearch = /(?:web[_ -]?search|web[_ -]?search_preview|(?:the )?tool)\b.*\b(?:unsupported|not supported|does not support|doesn't support|unknown|unrecognized|unavailable|not found)|\b(?:unsupported|not supported|does not support|doesn't support|unknown|unrecognized|unavailable|not found)\b.*\b(?:web[_ -]?search|web[_ -]?search_preview|(?:the )?tool)/i.test(lower);
	if (err instanceof CredentialResolutionError || /(?:api )?key (?:not found|missing)|credential resolution/.test(lower)) {
		kind = "credential";
	} else if (isAbortError(err)) {
		kind = "aborted";
	} else if (provider === "xai" && status === 403 && /spending[- ]limit|(?:no|out of) credits?|insufficient quota|quota (?:exceeded|exhausted)|credits? (?:exhausted|depleted|used up)/.test(lower)) {
		kind = "quota";
	} else if (status === 401 || status === 403) {
		kind = "auth";
	} else if (status === 400 || status === 422) {
		kind = "invalid-request";
	} else if (status === 402 || status === 429 || (provider === "tavily" && status === 432)) {
		kind = "quota";
	} else if (status !== undefined && (status === 408 || status === 425 || status >= 500)) {
		kind = "transient";
	} else if (/rate limit|quota|too many requests/.test(lower)) {
		kind = "quota";
	} else if (/unauthorized|forbidden|permission denied/.test(lower)) {
		kind = "auth";
	} else if (/bad request|invalid request/.test(lower)) {
		kind = "invalid-request";
	} else if (/invalid json|no parseable response|no parseable results|invalid response|returned empty response|no web_search_call/.test(lower)) {
		kind = "invalid-response";
	} else if (/temporar|service unavailable|server error/.test(lower)) {
		kind = "transient";
	} else if (err instanceof TypeError || /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(lower)) {
		kind = "network";
	} else if (/invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(lower)) {
		kind = "config";
	}
	return new SearchProviderError(provider, kind, message, status, err);
}

async function searchWithResolvedProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Promise<ProviderSearchResponse> {
	if (provider === "brave") return { ...(await searchWithBrave(query, options)), provider };
	if (provider === "tinyfish") return { ...(await searchWithTinyFish(query, options)), provider };
	if (provider === "search1api") return { ...(await searchWithSearch1API(query, options)), provider };
	if (provider === "searchinfinity") return { ...(await searchWithSearchinfinity(query, options)), provider };
	if (provider === "querit") return { ...(await searchWithQuerit(query, options)), provider };
	if (provider === "tavily") return { ...(await searchWithTavily(query, options)), provider };
	if (provider === "you") return { ...(await searchWithYou(query, options)), provider };
	if (provider === "firecrawl") return { ...(await searchWithFirecrawl(query, options)), provider };
	if (provider === "jina") return { ...(await searchWithJina(query, options)), provider };
	if (provider === "serpdive") return { ...(await searchWithSerpdive(query, options)), provider };
	if (provider === "kagi") return { ...(await searchWithKagi(query, options)), provider };
	if (provider === "bocha") return { ...(await searchWithBocha(query, options)), provider };
	if (provider === "ollama") return { ...(await searchWithOllama(query, options)), provider };
	if (provider === "anysearch") return { ...(await searchWithAnySearch(query, options)), provider };
	if (provider === "xai") return { ...(await searchWithXai(query, options, options.extensionContext)), provider };
	if (provider === "mistral") return { ...(await searchWithMistral(query, options)), provider };
	if (provider === "brightdata") return { ...(await searchWithBrightData(query, options)), provider };
	if (provider === "serpbase") return { ...(await searchWithSerpBase(query, options)), provider };
	if (provider === "serpapi") return { ...(await searchWithSerpApi(query, options)), provider };
	if (provider === "serper") return { ...(await searchWithSerper(query, options)), provider };
	if (provider === "serply") return { ...(await searchWithSerply(query, options)), provider };
	if (provider === "baizhi") return { ...(await searchWithBaizhi(query, options)), provider };
	if (provider === "zai") return { ...(await searchWithZai(query, options)), provider };
	if (provider === "valyu") return { ...(await searchWithValyu(query, options)), provider };
	if (provider === "xcrawl") return { ...(await searchWithXCrawl(query, options)), provider };
	if (provider === "perplexity") return { ...(await searchWithPerplexity(query, options)), provider };
	if (provider === "searxng") return { ...(await searchWithSearXNG(query, options)), provider };
	if (provider === "duckduckgo") return { ...(await searchWithDuckDuckGo(query, options)), provider };
	if (provider === "kimi") return { ...(await searchWithKimi(query, options, options.extensionContext)), provider };
	const result = await searchWithExa(query, options);
	if (result) return { ...result, provider };
	throw new Error("Exa search returned no results.");
}

async function isResolvedProviderAvailable(provider: ResolvedSearchProvider, options: FullSearchOptions): Promise<boolean> {
	if (provider === "brave") return isBraveAvailable();
	if (provider === "tinyfish") return isTinyFishAvailable();
	if (provider === "search1api") return isSearch1APIAvailable();
	if (provider === "searchinfinity") return isSearchinfinityAvailable();
	if (provider === "querit") return isQueritAvailable();
	if (provider === "tavily") return isTavilyAvailable();
	if (provider === "you") return isYouAvailable();
	if (provider === "firecrawl") return isFirecrawlAvailable();
	if (provider === "jina") return isJinaSearchAvailable();
	if (provider === "serpdive") return isSerpdiveAvailable();
	if (provider === "kagi") return isKagiAvailable();
	if (provider === "bocha") return isBochaAvailable();
	if (provider === "ollama") return isOllamaAvailable();
	if (provider === "anysearch") return isAnySearchAvailable();
	if (provider === "xai") return isXaiSearchAvailable(options.extensionContext);
	if (provider === "mistral") return isMistralAvailable();
	if (provider === "brightdata") return isBrightDataAvailable();
	if (provider === "serpbase") return isSerpBaseAvailable();
	if (provider === "serpapi") return isSerpApiAvailable();
	if (provider === "serper") return isSerperAvailable();
	if (provider === "serply") return isSerplyAvailable();
	if (provider === "baizhi") return isBaizhiAvailable();
	if (provider === "zai") return isZaiAvailable();
	if (provider === "valyu") return isValyuAvailable();
	if (provider === "xcrawl") return isXcrawlAvailable();
	if (provider === "perplexity") return isPerplexityAvailable();
	if (provider === "searxng") return isSearXNGAvailable();
	if (provider === "duckduckgo") return isDuckDuckGoAvailable();
	if (provider === "kimi") return isKimiSearchAvailable(options.extensionContext);
	return isExaAvailable();
}

export function providerLabel(provider: ResolvedSearchProvider): string {
	if (provider === "tinyfish") return "TinyFish";
	if (provider === "search1api") return "Search1API";
	if (provider === "searchinfinity") return "Searchinfinity";
	if (provider === "querit") return "Querit";
	if (provider === "firecrawl") return "Firecrawl";
	if (provider === "serpdive") return "SERPdive";
	if (provider === "searxng") return "SearXNG";
	if (provider === "duckduckgo") return "DuckDuckGo";
	if (provider === "kagi") return "Kagi";
	if (provider === "bocha") return "Bocha";
	if (provider === "xcrawl") return "XCrawl";
	if (provider === "kimi") return "Kimi";
	if (provider === "ollama") return "Ollama";
	if (provider === "xai") return "xAI";
	if (provider === "mistral") return "Mistral";
	if (provider === "brightdata") return "Bright Data";
	if (provider === "serpbase") return "SerpBase";
	if (provider === "serpapi") return "SerpApi";
	if (provider === "serper") return "Serper";
	if (provider === "serply") return "Serply";
	if (provider === "you") return "You.com";
	if (provider === "baizhi") return "Baizhi";
	if (provider === "zai") return "Z.ai";
	if (provider === "valyu") return "Valyu";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

async function searchWithProviders(
	query: string,
	options: FullSearchOptions,
	selectedProviders?: ResolvedSearchProvider[],
): Promise<AttributedSearchResponse> {
	const allowed = getAllowedSearchProviders();
	const providers = selectedProviders ?? (await Promise.all(ALL_SEARCH_PROVIDERS.filter(provider => allowed.includes(provider)).map(async (provider) => ({
		provider,
		available: await isResolvedProviderAvailable(provider, options),
	})))).filter((entry) => entry.available).map((entry) => entry.provider);
	if (providers.length === 0) {
		throw new Error("No configured search provider available for provider \"all\". DuckDuckGo, Kimi, AnySearch, xAI, Mistral, Bright Data, SerpBase, SerpApi, Serper, Serply, You.com, Valyu, Baizhi, Z.ai, and XCrawl are excluded.");
	}

	const settled = await Promise.allSettled(
		providers.map((provider) => searchWithResolvedProvider(provider, query, options)),
	);
	if (options.signal?.aborted) throw new Error("Aborted");

	const successes: ProviderSearchResponse[] = [];
	const failures: Array<{ provider: ResolvedSearchProvider; error: string }> = [];
	for (let index = 0; index < settled.length; index++) {
		const outcome = settled[index];
		if (outcome.status === "fulfilled") {
			successes.push(outcome.value);
		} else {
			failures.push({ provider: providers[index], error: errorMessage(outcome.reason) });
		}
	}
	if (successes.length === 0) {
		const label = selectedProviders ? "Selected-provider" : "All-provider";
		throw new Error(`${label} search failed:\n  - ${failures.map(({ provider, error }) => `${providerLabel(provider)}: ${error}`).join("\n  - ")}`);
	}

	const results: SearchResult[] = [];
	const seenResultUrls = new Set<string>();
	const inlineContent: NonNullable<SearchResponse["inlineContent"]> = [];
	const seenInlineUrls = new Set<string>();
	for (const response of successes) {
		for (const result of response.results) {
			if (seenResultUrls.has(result.url)) continue;
			seenResultUrls.add(result.url);
			results.push(result);
		}
		for (const content of response.inlineContent ?? []) {
			if (seenInlineUrls.has(content.url)) continue;
			seenInlineUrls.add(content.url);
			inlineContent.push(content);
		}
	}

	const answerSections = successes.map((response) =>
		`## ${providerLabel(response.provider)}\n\n${response.answer || "(No answer text returned.)"}`
	);
	if (failures.length > 0) {
		answerSections.push(
			`## Provider errors\n\n${failures.map(({ provider, error }) => `- **${providerLabel(provider)}:** ${error}`).join("\n")}`,
		);
	}

	return {
		provider: "all",
		answer: answerSections.join("\n\n"),
		results,
		providerResponses: successes,
		...(failures.length > 0 ? { providerErrors: failures } : {}),
		...(inlineContent.length > 0 ? { inlineContent } : {}),
	};
}

async function searchWithConfiguredRouting(
	query: string,
	options: FullSearchOptions,
	routing: SearchRoutingConfig,
): Promise<AttributedSearchResponse> {
	const diagnostics: string[] = [];
	for (const provider of routing.providers) {
		if (!(await isResolvedProviderAvailable(provider, options))) {
			diagnostics.push(`${provider}: unavailable`);
			continue;
		}
		try {
			return await searchWithResolvedProvider(provider, query, options);
		} catch (err) {
			const classified = classifyProviderError(provider, err);
			diagnostics.push(`${provider} [${classified.kind}]: ${errorMessage(err)}`);
			if (!routing.fallbackOn.includes(classified.kind as SearchRoutingConfig["fallbackOn"][number])) {
				throw classified;
			}
		}
	}
	throw new Error(`Configured search routing exhausted:\n  - ${diagnostics.join("\n  - ")}`);
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider === undefined || options.provider === "auto"
		? config.searchProvider
		: options.provider;
	assertSearchProviderSelectionAllowed(provider, "Requested provider");
	if (Array.isArray(provider)) {
		return searchWithProviders(query, options, normalizeResolvedProviderList(provider, "provider"));
	}
	if (provider === "all") return searchWithProviders(query, options);
	if (provider !== "auto") return searchWithResolvedProvider(provider, query, options);
	if (!config.searchProviderConfigured && config.searchRouting) {
		return searchWithConfiguredRouting(query, options, config.searchRouting);
	}

	const fallbackErrors: string[] = [];
	const allowed = new Set(config.allowedProviders ?? RESOLVED_SEARCH_PROVIDERS);

	if (allowed.has("searxng") && isSearXNGAvailable()) {
		try {
			const result = await searchWithSearXNG(query, options);
			return { ...result, provider: "searxng" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`SearXNG: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("exa") && isExaAvailable()) {
		try {
			const result = await searchWithExa(query, options);
			if (result) return { ...result, provider: "exa" };
		} catch (err) {
			if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
			fallbackErrors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("brave") && isBraveAvailable()) {
		try {
			const result = await searchWithBrave(query, options);
			return { ...result, provider: "brave" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Brave: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("tinyfish") && isTinyFishAvailable()) {
		try {
			const result = await searchWithTinyFish(query, options);
			return { ...result, provider: "tinyfish" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`TinyFish: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("search1api") && isSearch1APIAvailable()) {
		try {
			const result = await searchWithSearch1API(query, options);
			return { ...result, provider: "search1api" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Search1API: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("searchinfinity") && isSearchinfinityAvailable()) {
		try {
			const result = await searchWithSearchinfinity(query, options);
			return { ...result, provider: "searchinfinity" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Searchinfinity: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("querit") && isQueritAvailable()) {
		try {
			const result = await searchWithQuerit(query, options);
			return { ...result, provider: "querit" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Querit: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("tavily") && isTavilyAvailable()) {
		try {
			const result = await searchWithTavily(query, options);
			return { ...result, provider: "tavily" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Tavily: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("firecrawl") && isFirecrawlAvailable()) {
		try {
			const result = await searchWithFirecrawl(query, options);
			return { ...result, provider: "firecrawl" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Firecrawl: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("jina") && isJinaSearchAvailable()) {
		try {
			const result = await searchWithJina(query, options);
			return { ...result, provider: "jina" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Jina: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("serpdive") && isSerpdiveAvailable()) {
		try {
			const result = await searchWithSerpdive(query, options);
			return { ...result, provider: "serpdive" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`SERPdive: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("kagi") && isKagiAvailable()) {
		try {
			const result = await searchWithKagi(query, options);
			return { ...result, provider: "kagi" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Kagi: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("bocha") && isBochaAvailable()) {
		try {
			const result = await searchWithBocha(query, options);
			return { ...result, provider: "bocha" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Bocha: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("ollama") && isOllamaAvailable()) {
		try {
			const result = await searchWithOllama(query, options);
			return { ...result, provider: "ollama" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Ollama: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("perplexity") && isPerplexityAvailable()) {
		try {
			const result = await searchWithPerplexity(query, options);
			return { ...result, provider: "perplexity" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Perplexity: ${errorMessage(err)}`);
		}
	}

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
		`  1. Set braveApiKey, tinyfishApiKey, search1apiApiKey, searchinfinityApiKey, queritApiKey, tavilyApiKey, firecrawlBaseUrl, jinaApiKey, serpdiveApiKey, kagiApiKey, ollamaApiKey, searxngBaseUrl, perplexityApiKey, exaApiKey, bochaApiKey in ${CONFIG_PATH}\n` +
		"  2. Set BRAVE_API_KEY, TINYFISH_API_KEY, SEARCH1API_KEY, SEARCHINFINITY_API_KEY, QUERIT_API_KEY, TAVILY_API_KEY, FIRECRAWL_BASE_URL, JINA_API_KEY, SERPDIVE_API_KEY, KAGI_API_KEY, BOCHA_API_KEY, OLLAMA_API_KEY, SEARXNG_BASE_URL, EXA_API_KEY, or PERPLEXITY_API_KEY env vars\n" +
		"  3. Explicitly select provider: \"anysearch\" for anonymous AnySearch, \"xcrawl\" for XCrawl, \"xai\" for Grok, \"mistral\" for Mistral Conversations web search, \"brightdata\" with brightdataSerpZone for paid Bright Data SERP, \"serpbase\", \"serpapi\", \"serper\", or \"serply\" for Google SERP, \"you\" for You.com, \"zai\" for Z.ai GLM Coding Plan search, or \"valyu\" for research search"
	);
}
