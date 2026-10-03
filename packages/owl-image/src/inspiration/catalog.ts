/**
 * Versioned, bundled inspiration metadata and model-facing search.
 * Ported from dsh-image-gen src/inspiration.ts (Apache-2.0), trimmed to the
 * tool-facing subset: the bundled snapshots are parsed defensively and the
 * search returns reusable prompts. Image-path resolution stays out — owl has
 * no plugin HTTP surface to serve case images from.
 */
import rawCases from "./data/awesome-gpt-image-2.json" with { type: "json" };
import rawHanddrawCases from "./data/handraw-style.json" with { type: "json" };

export const INSPIRATION_SOURCE_ID = "awesome-gpt-image-2";
export const INSPIRATION_SOURCE_VERSION = "c7d293963b21c60bf338003915438cc5c39dd3ca";
export const INSPIRATION_SOURCE_UPDATED_AT = "2026-08-28T10:24:55Z";
export const INSPIRATION_SOURCE_REPOSITORY = "https://github.com/freestylefly/awesome-gpt-image-2";
export const MAX_INSPIRATION_CASES = 2_000;

export const HANDDRAW_SOURCE_ID = "handraw-style";
export const HANDDRAW_SOURCE_VERSION = "50998b094866e22007001161bca12c892a3796b1";
export const HANDDRAW_SOURCE_UPDATED_AT = "2026-09-27T14:24:28+08:00";
export const HANDDRAW_SOURCE_REPOSITORY = "https://github.com/yang0/handraw-style";

export interface InspirationCase {
	id: string;
	title: string;
	imageAlt: string;
	sourceLabel?: string | undefined;
	sourceUrl?: string | undefined;
	githubUrl?: string | undefined;
	prompt: string;
	promptPreview: string;
	category: string;
	styles: string[];
	scenes: string[];
	featured: boolean;
}

export interface InspirationSource {
	id: string;
	label: string;
	repository: string;
	version: string;
	updatedAt?: string | undefined;
	categories: string[];
	styles: string[];
	scenes: string[];
	cases: InspirationCase[];
}

export interface InspirationCatalog {
	schemaVersion: 1;
	sources: InspirationSource[];
}

interface InspirationSourceMeta {
	id: string;
	label: string;
	repository: string;
	version: string;
	updatedAt: string | undefined;
}

/** Parse one snapshot document defensively before it becomes application data. */
function parseInspirationSource(value: unknown, meta: InspirationSourceMeta): InspirationSource {
	const document = record(value);
	const cases = Array.isArray(document?.cases) ? document.cases : [];
	if (cases.length === 0 || cases.length > MAX_INSPIRATION_CASES) throw new Error("素材索引案例数量无效");

	const seen = new Set<string>();
	const parsedCases: InspirationCase[] = [];
	for (const candidate of cases) {
		const entry = record(candidate);
		const id = String(entry?.id ?? "").trim();
		const title = text(entry?.title, 240);
		const prompt = text(entry?.prompt, 8_000);
		if (!id || !title || !prompt || seen.has(id)) continue;
		seen.add(id);
		const promptPreview = text(entry?.promptPreview, 600) || prompt.slice(0, 280);
		const sourceUrl = safeHttpUrl(entry?.sourceUrl);
		const githubUrl = safeHttpUrl(entry?.githubUrl);
		const sourceLabel = optionalText(entry?.sourceLabel, 240);
		parsedCases.push({
			id,
			title,
			imageAlt: text(entry?.imageAlt, 320) || title,
			...(sourceLabel !== undefined ? { sourceLabel } : {}),
			...(sourceUrl !== undefined ? { sourceUrl } : {}),
			...(githubUrl !== undefined ? { githubUrl } : {}),
			prompt,
			promptPreview,
			category: text(entry?.category, 120) || "Other Use Cases",
			styles: strings(entry?.styles, 64, 60),
			scenes: strings(entry?.scenes, 64, 60),
			featured: entry?.featured === true,
		});
	}
	if (parsedCases.length === 0) throw new Error("素材索引不包含可用案例");

	return {
		id: meta.id,
		label: meta.label,
		repository: safeHttpUrl(document?.repository) ?? meta.repository,
		version: meta.version,
		updatedAt: optionalText(document?.updatedAt, 60) ?? meta.updatedAt,
		categories: strings(document?.categories, 80, 120),
		styles: strings(document?.styles, 80, 120),
		scenes: strings(document?.scenes, 80, 120),
		cases: parsedCases,
	};
}

export function findInspirationCase(
	catalog: InspirationCatalog,
	sourceId: string,
	caseId: string,
): InspirationCase | undefined {
	return catalog.sources
		.find((candidate) => candidate.id === sourceId)
		?.cases.find((candidate) => candidate.id === caseId);
}

/** One model-ready search hit: where the case lives plus its full reusable prompt. */
export interface InspirationSearchHit {
	sourceId: string;
	sourceLabel: string;
	id: string;
	title: string;
	category: string;
	prompt: string;
}

export interface InspirationSearchRequest {
	/** Substring matched case-insensitively against titles, prompts, categories, and style/scene tags; empty matches everything. */
	query: string;
	/** Restrict the search to one source id. */
	sourceId?: string | undefined;
	/** Restrict the search to one exact category name. */
	category?: string | undefined;
	/** Maximum hits to return; defaults to 8, clamped to 1-20. */
	limit?: number | undefined;
}

export interface InspirationSearchResult {
	/** Total matching cases before the limit; lets the caller refine instead of re-querying blindly. */
	total: number;
	hits: InspirationSearchHit[];
}

const DEFAULT_INSPIRATION_SEARCH_HITS = 8;
const MAX_INSPIRATION_SEARCH_HITS = 20;

/** Search the catalog for reusable prompts; bounded hits even with an empty query. */
export function searchInspirationCases(
	catalog: InspirationCatalog,
	request: InspirationSearchRequest,
): InspirationSearchResult {
	const limit = Math.min(Math.max(request.limit ?? DEFAULT_INSPIRATION_SEARCH_HITS, 1), MAX_INSPIRATION_SEARCH_HITS);
	const query = request.query.trim().toLowerCase();
	const matches: InspirationSearchHit[] = [];
	for (const source of catalog.sources) {
		if (request.sourceId !== undefined && source.id !== request.sourceId) continue;
		for (const item of source.cases) {
			if (request.category !== undefined && item.category !== request.category) continue;
			if (
				query !== "" &&
				![item.title, item.prompt, item.category, ...item.styles, ...item.scenes].some((value) =>
					value.toLowerCase().includes(query),
				)
			)
				continue;
			matches.push({
				sourceId: source.id,
				sourceLabel: source.label,
				id: item.id,
				title: item.title,
				category: item.category,
				prompt: item.prompt,
			});
		}
	}
	return { total: matches.length, hits: matches.slice(0, limit) };
}

export const BUNDLED_INSPIRATION_CATALOG: InspirationCatalog = {
	schemaVersion: 1,
	sources: [
		parseInspirationSource(rawCases, {
			id: INSPIRATION_SOURCE_ID,
			label: "GPT Image 2 案例库",
			repository: INSPIRATION_SOURCE_REPOSITORY,
			version: INSPIRATION_SOURCE_VERSION,
			updatedAt: INSPIRATION_SOURCE_UPDATED_AT,
		}),
		parseInspirationSource(rawHanddrawCases, {
			id: HANDDRAW_SOURCE_ID,
			label: "手绘风格图鉴",
			repository: HANDDRAW_SOURCE_REPOSITORY,
			version: HANDDRAW_SOURCE_VERSION,
			updatedAt: HANDDRAW_SOURCE_UPDATED_AT,
		}),
	],
};

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown, maxLength: number): string {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function optionalText(value: unknown, maxLength: number): string | undefined {
	const result = text(value, maxLength);
	return result.length > 0 ? result : undefined;
}

function strings(value: unknown, maxItems: number, maxLength: number): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const normalized = text(item, maxLength);
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
			if (result.length === maxItems) break;
		}
	}
	return result;
}

function safeHttpUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 2_000) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}
