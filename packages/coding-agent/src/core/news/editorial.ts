/**
 * Editorial rules adapted from KKKKhazix/AIHOT, Copyright (c) 2026 数字生命卡兹克.
 * Licensed under MIT; the complete upstream notice is retained in industry.ts and prompts.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import {
	CATEGORIES,
	CATEGORY_TAGS,
	ENTITIES,
	ENTITY_TAGS,
	IDENTITY_LEXICON,
	PLAIN_TERMS,
	PUBLISHER_DOMAINS,
	TAG_SYNONYMS,
	TOPIC_TAGS,
} from "./industry.ts";
import { NEWS_DATA_BOUNDARY, newsPrompt } from "./prompts.ts";
import type {
	NewsAnalysis,
	NewsCapability,
	NewsConfiguration,
	NewsEvaluation,
	NewsEvaluationSample,
	NewsFactFrame,
	NewsHotEvent,
	NewsItem,
	NewsMaterial,
	NewsModelCaller,
	NewsModelResponse,
	NewsRelation,
	NewsReport,
	NewsReportKind,
	NewsSource,
	NewsStory,
} from "./types.ts";

const MAX_BODY_CHARS = 60_000;
const DAY_MS = 86_400_000;
/**
 * 正常采集允许的滞后上限。原先只有 2 天，但首次启用的信源只能取到 feed 里已有的最新几条，
 * 低频信源（DeepMind 约 5 天一篇）于是永远达不到标准、被判为历史资料而无法进入精选。
 */
const FRESH_DISCOVERY_MS = 7 * DAY_MS;
const PrefilterSchema = Type.Object({
	label: Type.Union([Type.Literal("PASS"), Type.Literal("BLOCK"), Type.Literal("UNKNOWN")]),
	reason: Type.String({ maxLength: 200 }),
});
const ScoreSchema = Type.Object(
	{ attentionScore: Type.Integer({ minimum: 0, maximum: 100 }) },
	{ additionalProperties: false },
);
const StructureSchema = Type.Object({
	scope: Type.Union([Type.Literal("single"), Type.Literal("composite"), Type.Literal("unknown")]),
	category: Type.Union([Type.String(), Type.Null()]),
	tags: Type.Array(Type.String(), { maxItems: 12 }),
	subjects: Type.Array(Type.String(), { maxItems: 6 }),
	fact: Type.Union([
		Type.Null(),
		Type.Object({
			title: Type.String({ maxLength: 100 }),
			subject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			action: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			object: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			occurredAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			evidence: Type.Optional(Type.Union([Type.String({ maxLength: 600 }), Type.Null()])),
			conditions: Type.Optional(
				Type.Array(Type.Object({ quote: Type.String({ maxLength: 400 }) }), { maxItems: 4 }),
			),
		}),
	]),
});
const CopySchema = Type.Object({
	titleZh: Type.String({ minLength: 1, maxLength: 200 }),
	summaryZh: Type.String({ minLength: 1, maxLength: 4000 }),
	editorialJudgment: Type.Optional(Type.String({ maxLength: 500 })),
	itemType: Type.Optional(Type.String()),
	authorRole: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
});
const RelationSchema = Type.Union([
	Type.Literal("SAME_OCCURRENCE"),
	Type.Literal("SAME_STORY"),
	Type.Literal("UNRELATED"),
	Type.Literal("ROUNDUP"),
]);
const DecisionSchema = Type.Object({
	id: Type.String(),
	relation: RelationSchema,
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
	note: Type.Optional(Type.String()),
});
const BatchSchema = Type.Object({
	query: Type.String(),
	decisions: Type.Array(DecisionSchema),
	selection: Type.Object({ addsValue: Type.Boolean(), reason: Type.String({ maxLength: 500 }) }),
});
const ReviewSchema = Type.Object({ relation: RelationSchema, confidence: Type.Number({ minimum: 0, maximum: 1 }) });
const SignalSchema = Type.Object({ decisions: Type.Array(DecisionSchema) });
const DigestSchema = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 100 }),
	digest: Type.String({ minLength: 1, maxLength: 3000 }),
});
const PeriodSchema = Type.Object({
	overview: Type.String({ maxLength: 2000 }),
	sections: Type.Record(Type.String(), Type.String({ maxLength: 500 })),
});
const TranslationSchema = Type.Object({ t: Type.Array(Type.String()) });
const outputOrigins = new WeakMap<object, { purpose: string; response: NewsModelResponse }>();

export class NewsOutputError extends Error {
	readonly purpose: string;
	readonly response: NewsModelResponse | undefined;
	constructor(purpose: string, message: string, response?: NewsModelResponse) {
		super(`${purpose}: ${message}`);
		this.name = "NewsOutputError";
		this.purpose = purpose;
		this.response = response;
	}
}

function rejectOutput(origin: unknown, message: string, fallbackPurpose: string): never {
	const received = origin && typeof origin === "object" ? outputOrigins.get(origin) : undefined;
	throw new NewsOutputError(received?.purpose ?? fallbackPurpose, message, received?.response);
}

/** A failed response is never converted into a synthetic score or publication. */
async function requestJson<S extends TSchema>(
	call: NewsModelCaller,
	config: NewsConfiguration,
	capability: NewsCapability,
	purpose: string,
	system: string,
	user: string,
	schema: S,
	maxTokens: number,
	temperature = 0.2,
): Promise<Static<S>> {
	if (!config.modelCallsEnabled) throw new Error("News model calls are disabled");
	const request = {
		capability,
		purpose,
		model: config.models[capability],
		system: `${system}\n\n${NEWS_DATA_BOUNDARY}`,
		user,
		maxTokens,
		temperature,
	};
	const responseCache = call.responseCache;
	const cacheKey = responseCache ? await responseCache.key(request) : null;
	if (cacheKey) {
		const cached = responseCache?.read(cacheKey);
		if (cached !== null && Check(schema, cached)) return cached as Static<S>;
	}
	const response = await call(request);
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"));
	} catch {
		throw new NewsOutputError(purpose, "model returned invalid JSON", response);
	}
	if (!Check(schema, parsed))
		throw new NewsOutputError(purpose, "model output does not match the JSON schema", response);
	if (parsed && typeof parsed === "object") outputOrigins.set(parsed, { purpose, response });
	if (cacheKey) responseCache?.stage(cacheKey, parsed);
	return parsed;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function materialInput(material: NewsMaterial, source: NewsSource): string {
	return JSON.stringify({
		source: {
			name: source.name,
			kind: source.kind,
			tier: source.tier,
			firstParty: source.tier === "T1",
			owner: source.owner,
		},
		material: {
			title: material.title,
			body: material.body?.slice(0, MAX_BODY_CHARS) ?? "",
			publishedAt: material.publishedAt ?? null,
			author: material.author ?? null,
			url: material.url,
		},
	});
}

/** Scoring deliberately excludes source authority and the selection threshold. */
export function newsScoreInput(material: NewsMaterial): string {
	return JSON.stringify({
		publishedAt: material.publishedAt ?? null,
		title: material.title,
		body: (material.body || material.title).slice(0, MAX_BODY_CHARS),
	});
}

async function prefilterMaterial(
	material: NewsMaterial,
	source: NewsSource,
	config: NewsConfiguration,
	call: NewsModelCaller,
) {
	const result = await requestJson(
		call,
		config,
		"prefilter",
		"prefilter",
		newsPrompt("prefilter"),
		materialInput(material, source),
		PrefilterSchema,
		512,
		0,
	);
	return result.label === "BLOCK" && !material.body?.trim() ? { ...result, label: "UNKNOWN" as const } : result;
}

async function scoreMaterial(
	material: NewsMaterial,
	config: NewsConfiguration,
	call: NewsModelCaller,
): Promise<number[]> {
	const values: number[] = [];
	const scoreModel = config.models.score;
	const frozenConfig = { ...config, models: { ...config.models, score: scoreModel } };
	for (let i = 1; i <= 2; i++) {
		const score = await requestJson(
			call,
			frozenConfig,
			"score",
			`score-${i}`,
			newsPrompt("selection-score"),
			newsScoreInput(material),
			ScoreSchema,
			scoreModel?.id === "glm-5.3-flash" ? 65_536 : 1024,
			scoreModel?.id === "glm-5.3-flash" ? 1 : 0.2,
		);
		values.push(score.attentionScore);
	}
	return values;
}

export function normalizeNewsTags(tags: string[]): string[] {
	const allowed = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);
	return [
		...new Set(
			tags
				.map((tag) => TAG_SYNONYMS[tag.trim().toLowerCase()] ?? TAG_SYNONYMS[tag.trim()] ?? tag.trim())
				.filter((tag) => allowed.has(tag)),
		),
	].slice(0, 6);
}

function normalizeFrame(structure: Static<typeof StructureSchema>, material: NewsMaterial): NewsFactFrame | null {
	if (structure.scope !== "single" || !structure.fact || !material.body?.trim()) return null;
	const body = collapse(material.body.slice(0, MAX_BODY_CHARS));
	// Chinese paragraph layout can disappear in a quote; preserve Latin and numeric separators.
	const evidenceText = (value: string) =>
		collapse(value).replace(
			/(?<=[\p{Script=Han}，。！？；：、（）《》〈〉「」『』【】〔〕“”‘’…—])\s+(?=[\p{Script=Han}，。！？；：、（）《》〈〉「」『』【】〔〕“”‘’…—])/gu,
			"",
		);
	const comparableBody = evidenceText(body);
	const frame = structure.fact;
	const evidence = [
		...new Set(
			[frame.evidence ?? "", ...(frame.conditions ?? []).map((condition) => condition.quote)]
				.map(collapse)
				.filter((quote) => quote.length > 0 && comparableBody.includes(evidenceText(quote))),
		),
	];
	// The fact's main evidence must occur in the actual body, not its title or a translation.
	if (
		!frame.evidence?.trim() ||
		!comparableBody.includes(evidenceText(frame.evidence)) ||
		!frame.subject?.trim() ||
		!frame.action?.trim() ||
		!frame.object?.trim()
	)
		return null;
	let occurredAt = frame.occurredAt ?? null;
	if (occurredAt) {
		const [year, month, day] = occurredAt.split("-");
		const explicit = [occurredAt, `${year}/${month}/${day}`, `${year}年${Number(month)}月${Number(day)}日`].some(
			(value) => body.includes(value),
		);
		const relative =
			/今天|today/i.test(body) && material.publishedAt && beijingDate(new Date(material.publishedAt)) === occurredAt;
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(occurredAt) ||
			!Number.isFinite(Date.parse(occurredAt)) ||
			(!explicit && !relative)
		)
			occurredAt = null;
	}
	return {
		subject: frame.subject?.trim() ?? "",
		action: frame.action?.trim() ?? "",
		object: frame.object?.trim() ?? "",
		occurredAt,
		evidence,
	};
}

function identityIds(text: string): string[] {
	return IDENTITY_LEXICON.filter((entry) => entry.patterns.some((pattern) => pattern.test(text))).map(
		(entry) => entry.id,
	);
}

function guardCopy(
	copy: { title: string; summary: string },
	corpus: string,
	context: { publisherUrl?: string; owner?: string; origin?: unknown } = {},
): void {
	const allowed = new Set(identityIds(corpus));
	if (context.owner) allowed.add(context.owner);
	if (context.publisherUrl) {
		const host = new URL(context.publisherUrl).hostname;
		for (const publisher of PUBLISHER_DOMAINS)
			if (publisher.domains.some((domain) => host === domain || host.endsWith(`.${domain}`)))
				allowed.add(publisher.entityId);
	}
	const unsupported = identityIds(`${copy.title}\n${copy.summary}`).filter((id) => !allowed.has(id));
	if (unsupported.length)
		rejectOutput(context.origin, `copy introduced an unsupported identity: ${unsupported.join(", ")}`, "writing");
	if (!groundedNewsText(`${copy.title}\n${copy.summary}`, corpus))
		rejectOutput(context.origin, "copy introduced a name or number absent from the source", "writing");
}

function summarizeSystem(): string {
	// Keep the upstream instructions in system and material in user, rather than interpolating
	// untrusted body text into the upstream all-in-one prompt.
	const upstream = newsPrompt("summarize-article", {
		publishedDate: "未注明",
		today: "未注明",
		sourceName: "见用户资料",
		identity: "",
		title: "见用户资料",
		body: "见用户资料",
	});
	return `${upstream.split("输出格式（严格遵守）：")[0]}\n只输出 JSON {"titleZh":"中文标题","summaryZh":"忠实的中文摘要"}。`;
}

export async function analyzeMaterial(
	material: NewsMaterial,
	source: NewsSource,
	config: NewsConfiguration,
	call: NewsModelCaller,
): Promise<NewsAnalysis> {
	const prefilter = await prefilterMaterial(material, source, config, call);
	if (prefilter.label === "BLOCK")
		return {
			relevance: "block",
			scores: [],
			score: null,
			selectionCandidate: false,
			title: material.title,
			summary: "",
			reason: prefilter.reason,
			category: "",
			tags: [],
			entities: [],
			contentKind: "unknown",
			fact: null,
		};
	const structureSystem = newsPrompt("structure", {
		categoryCount: String(CATEGORIES.length),
		categoryGuide: CATEGORIES.map((category) => `- ${category.key}（${category.label}）：${category.guide}`).join(
			"\n",
		),
		categoryTags: CATEGORY_TAGS.join("、"),
		topicTags: TOPIC_TAGS.join("、"),
		entityTags: ENTITY_TAGS.join("、"),
		entities: Object.entries(ENTITIES)
			.map(([id, entity]) => `${id}（${entity.aliases.join("/")}）`)
			.join("，"),
	});
	const pendingStructure = requestJson(
		call,
		config,
		"structure",
		"structure",
		structureSystem,
		materialInput(material, source),
		StructureSchema,
		1600,
	).then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	try {
		const threshold = config.thresholds[source.tier];
		const scores = threshold === null || threshold === undefined ? [] : await scoreMaterial(material, config, call);
		const sum = scores.length === 2 ? scores[0]! + scores[1]! : null;
		const score = sum === null ? null : Math.floor(sum / 2);
		const structureResult = await pendingStructure;
		if ("error" in structureResult) throw structureResult.error;
		const structure = structureResult.value;
		const fact = normalizeFrame(structure, material);
		const near = sum !== null && (sum >= (threshold ?? 101) * 2 || sum > config.understandFloor * 2);
		const copy = await requestJson(
			call,
			config,
			near ? "understand" : "summarize",
			near ? "understand" : "summarize",
			near ? newsPrompt("understand") : summarizeSystem(),
			materialInput(material, source),
			CopySchema,
			near ? 16_384 : 2048,
		);
		const corpus = `${material.title}\n${material.body ?? ""}\n${source.name}`;
		guardCopy({ title: copy.titleZh, summary: copy.summaryZh }, corpus, {
			publisherUrl: material.url,
			owner: source.owner,
			origin: copy,
		});
		const tags = normalizeNewsTags(structure.tags);
		const entities = [
			...new Set(
				structure.subjects.filter(
					(id) => id in ENTITIES && (identityIds(corpus).includes(id) || id === source.owner),
				),
			),
		];
		for (const entity of entities) {
			const tag = ENTITIES[entity]?.displayTag;
			if (tag && !tags.includes(tag)) tags.push(tag);
		}
		return {
			relevance: material.body?.trim() && copy.titleZh.trim() && copy.summaryZh.trim() ? "pass" : "unknown",
			scores,
			score,
			selectionCandidate:
				!!material.body?.trim() &&
				sum !== null &&
				threshold !== null &&
				threshold !== undefined &&
				sum >= threshold * 2 &&
				structure.scope !== "unknown" &&
				(structure.fact === null || fact !== null),
			title: collapse(copy.titleZh),
			summary: copy.summaryZh.trim(),
			reason: copy.editorialJudgment?.trim() ?? "",
			category: CATEGORIES.some((category) => category.key === structure.category) ? (structure.category ?? "") : "",
			tags: tags.slice(0, 6),
			entities,
			contentKind: material.body?.trim() ? structure.scope : "unknown",
			fact,
		};
	} finally {
		// The caller must keep its receipt/store open until the paid concurrent step settles.
		await pendingStructure;
	}
}

/** Character bigrams are the upstream fallback when no embedding service is configured. */
export function lexicalSimilarity(a: string, b: string): number {
	const grams = (text: string) => {
		const compact = collapse(text)
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]/gu, "");
		return new Set(
			Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2)),
		);
	};
	const left = grams(a),
		right = grams(b);
	if (!left.size || !right.size) return 0;
	let shared = 0;
	for (const gram of left) if (right.has(gram)) shared++;
	return (2 * shared) / (left.size + right.size);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0,
		left = 0,
		right = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		left += a[i]! ** 2;
		right += b[i]! ** 2;
	}
	return left > 0 && right > 0 ? dot / Math.sqrt(left * right) : 0;
}

export function recallStoryCandidates(item: NewsItem, stories: NewsStory[], limit = 10): NewsStory[] {
	const earliest = Date.parse(item.discoveredAt) - 14 * DAY_MS;
	return stories
		.map((story) => ({
			story,
			similarity: Math.max(
				0,
				...story.reports
					.filter(
						(report) =>
							!report.withdrawn &&
							report.contentKind !== "composite" &&
							Date.parse(report.discoveredAt) > earliest,
					)
					.map((report) =>
						report.url === item.url
							? 1
							: lexicalSimilarity(`${item.title} ${item.summary}`, `${report.title} ${report.summary}`),
					),
			),
		}))
		.filter((candidate) => candidate.similarity >= 0.25)
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, limit)
		.map((candidate) => candidate.story);
}

export function newsFactKey(item: NewsItem): string {
	if (item.factId) return `fact:${item.factId}`;
	if (item.fact && item.contentKind === "single")
		return `frame:${createHash("sha256")
			.update(
				JSON.stringify([
					collapse(item.fact.subject).toLowerCase(),
					collapse(item.fact.action).toLowerCase(),
					collapse(item.fact.object).toLowerCase(),
					item.fact.occurredAt,
				]),
			)
			.digest("hex")
			.slice(0, 24)}`;
	return `article:${item.id}`;
}

export function pickNewsRepresentative(items: readonly NewsItem[]): NewsItem | undefined {
	return [...items].sort(
		(a, b) =>
			Number(b.sourceTier === "T1") - Number(a.sourceTier === "T1") ||
			Number(!!b.originalBody) - Number(!!a.originalBody) ||
			(b.score ?? 0) - (a.score ?? 0) ||
			Date.parse(a.timelineAt) - Date.parse(b.timelineAt) ||
			a.id.localeCompare(b.id),
	)[0];
}

/** Machine exports have one seat per fact; the desktop can fold these same members into groups. */
export function selectedNewsSeats(items: NewsItem[]): NewsItem[] {
	const groups = groupBy(
		items.filter((item) => item.selected && publicItem(item)),
		newsFactKey,
	);
	return [...groups.values()].flatMap((members) => {
		const representative = pickNewsRepresentative(members);
		return representative ? [representative] : [];
	});
}

function reportView(item: NewsItem) {
	return {
		title: item.title,
		summary: item.summary,
		source: item.sourceName,
		firstParty: item.sourceTier === "T1",
		at: item.publishedAt,
		scope: item.contentKind,
		frame: item.fact,
		sourceText: item.originalBody?.slice(0, 6000) ?? item.body?.slice(0, 6000) ?? null,
	};
}

interface RelationCandidate {
	key: string;
	story: NewsStory;
	item: NewsItem;
	root: boolean;
	selected: boolean;
	similarity: number;
}

export async function judgeRelation(
	item: NewsItem,
	stories: NewsStory[],
	config: NewsConfiguration,
	call: NewsModelCaller,
	readingBackground: NewsItem[] = [],
): Promise<NewsRelation> {
	const empty: NewsRelation = {
		storyId: null,
		factId: null,
		relation: "unrelated",
		novel: item.contentKind !== "unknown",
		reason: "没有已精选的相关报道",
		mentions: [],
	};
	if (item.backfill || Date.parse(item.discoveredAt) - Date.parse(item.publishedAt) > FRESH_DISCOVERY_MS)
		return { ...empty, novel: false, reason: "历史资料按原文时间归档" };
	if (
		item.participation === "editorial" &&
		(item.contentKind === "unknown" ||
			(item.contentKind === "single" && !item.fact && !["tip", "opinion"].includes(item.category)))
	)
		return { ...empty, novel: false, reason: "材料不足以确认当前新闻身份" };
	const candidates: RelationCandidate[] = [];
	for (const story of stories) {
		const reports = story.reports.filter(
			(report) => !report.withdrawn && report.contentKind === "single" && report.participation === "editorial",
		);
		const root = [...reports].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))[0];
		for (const members of groupBy(reports, newsFactKey).values()) {
			const representative = pickNewsRepresentative(members);
			if (!representative) continue;
			candidates.push({
				key: `C${candidates.length + 1}`,
				story,
				item: representative,
				root: !!root && newsFactKey(root) === newsFactKey(representative),
				selected: members.some((member) => member.selected),
				similarity:
					representative.url === item.url
						? 1
						: lexicalSimilarity(
								`${item.title} ${item.summary}`,
								`${representative.title} ${representative.summary}`,
							),
			});
		}
	}
	const picked = [...candidates]
		.sort((a, b) => Number(b.root) - Number(a.root) || b.similarity - a.similarity)
		.slice(0, 10);
	const reading = readingBackground
		.filter(
			(report) =>
				publicItem(report) &&
				report.selected &&
				report.id !== item.id &&
				(report.contentKind === "composite" || !report.storyId) &&
				Date.parse(report.discoveredAt) > Date.parse(item.discoveredAt) - 14 * DAY_MS,
		)
		.map((report) => ({
			report,
			similarity: lexicalSimilarity(`${item.title} ${item.summary}`, `${report.title} ${report.summary}`),
		}))
		.filter((entry) => entry.similarity >= 0.25)
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, 6)
		.map((entry) => entry.report);
	if (picked.length === 0 && (reading.length === 0 || item.participation !== "editorial"))
		return item.participation === "editorial" ? empty : { ...empty, novel: false };
	const user = JSON.stringify({
		query: reportView(item),
		candidates: picked.map((candidate) => ({
			id: candidate.key,
			root: candidate.root,
			selected: candidate.selected ? "已公开精选" : false,
			representative: reportView(candidate.item),
		})),
		readingBackground: reading.map((report) => ({ label: "已公开精选阅读背景", report: reportView(report) })),
	});
	if (item.participation !== "editorial") {
		const result = await requestJson(
			call,
			config,
			"group",
			"group-signal",
			newsPrompt("group-signal"),
			user,
			SignalSchema,
			1000,
			0,
		);
		validateDecisions(result.decisions, picked, result);
		const match = result.decisions.find(
			(decision) =>
				decision.confidence >= 0.8 &&
				(decision.relation === "SAME_OCCURRENCE" || decision.relation === "SAME_STORY"),
		);
		const target = picked.find((candidate) => candidate.key === match?.id);
		return target
			? {
					storyId: target.story.id,
					factId: target.item.factId ?? null,
					relation: match?.relation === "SAME_OCCURRENCE" ? "same" : "update",
					novel: false,
					reason: "讨论证据，不参与精选",
				}
			: { ...empty, novel: false };
	}
	const result = await requestJson(
		call,
		config,
		"group",
		"group",
		newsPrompt("group-batch"),
		user,
		BatchSchema,
		600 + 160 * picked.length,
		0,
	);
	validateDecisions(result.decisions, picked, result);
	let novel = picked.some((candidate) => candidate.selected) || reading.length > 0 ? result.selection.addsValue : true;
	const mentions = result.decisions
		.filter((decision) => decision.confidence >= 0.8 && decision.relation !== "UNRELATED")
		.flatMap((decision) => {
			const candidate = picked.find((entry) => entry.key === decision.id);
			return candidate ? [candidate.story.id] : [];
		});
	if (item.contentKind === "composite")
		return { ...empty, novel, mentions: [...new Set(mentions)], reason: result.selection.reason };
	const same = result.decisions
		.filter((decision) => decision.relation === "SAME_OCCURRENCE" && decision.confidence >= 0.8)
		.sort((a, b) => b.confidence - a.confidence);
	for (const decision of same) {
		const candidate = picked.find((entry) => entry.key === decision.id);
		if (!candidate) continue;
		let relation: "same" | "update" | null = "same";
		if (candidate.similarity < 0.85) {
			const review = await requestJson(
				call,
				config,
				"groupReview",
				`group-review:${candidate.item.factId ?? candidate.item.id}`,
				newsPrompt("group-pair"),
				JSON.stringify({ A: reportView(item), B: reportView(candidate.item) }),
				ReviewSchema,
				600,
				0,
			);
			relation =
				review.confidence < 0.75
					? null
					: review.relation === "SAME_OCCURRENCE"
						? "same"
						: review.relation === "SAME_STORY" && candidate.root
							? "update"
							: null;
		}
		if (relation) {
			if (relation === "same" && candidate.selected) novel = true;
			return {
				storyId: candidate.story.id,
				factId: relation === "same" ? (candidate.item.factId ?? null) : null,
				relation,
				novel,
				reason: result.selection.reason,
				mentions: [],
			};
		}
	}
	const development = result.decisions.find(
		(decision) =>
			decision.relation === "SAME_STORY" &&
			decision.confidence >= 0.8 &&
			picked.find((candidate) => candidate.key === decision.id)?.root,
	);
	const target = picked.find((candidate) => candidate.key === development?.id);
	return target
		? {
				storyId: target.story.id,
				factId: null,
				relation: "update",
				novel,
				reason: result.selection.reason,
				mentions: [],
			}
		: { ...empty, novel, reason: result.selection.reason };
}

function validateDecisions(decisions: Array<{ id: string }>, candidates: RelationCandidate[], origin: unknown): void {
	const ids = new Set(decisions.map((decision) => decision.id));
	if (
		decisions.length !== candidates.length ||
		ids.size !== candidates.length ||
		candidates.some((candidate) => !ids.has(candidate.key))
	)
		rejectOutput(origin, "every candidate requires exactly one decision", "group");
}

export async function composeStoryDigest(
	story: NewsStory,
	config: NewsConfiguration,
	call: NewsModelCaller,
): Promise<{ title: string; summary: string }> {
	const reports = story.reports
		.filter((item) => publicItem(item) && item.contentKind === "single" && item.participation === "editorial")
		.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
	if (!reports.length) return { title: story.title, summary: "" };
	const views = reports.map(reportView);
	const result = await requestJson(
		call,
		config,
		"digest",
		"digest",
		newsPrompt("story-digest"),
		JSON.stringify({ title: story.title, reports: views }),
		DigestSchema,
		1400,
		0.3,
	);
	guardCopy(
		{ title: result.title, summary: result.digest },
		// Validate against the source text and publication metadata actually supplied to the model.
		// Derived frames, tags and scores cannot establish a new identity or number.
		views
			.map((report) => [report.title, report.summary, report.source, report.at, report.sourceText].join("\n"))
			.join("\n"),
		{ origin: result },
	);
	return { title: story.manual ? story.title : collapse(result.title), summary: result.digest.trim() };
}

export async function translateNewsBody(
	item: NewsItem,
	config: NewsConfiguration,
	call: NewsModelCaller,
): Promise<string> {
	const original = item.originalBody ?? item.body;
	if (!original?.trim()) throw new Error("No original body available for translation");
	if (/[\p{Script=Han}]/u.test(original) && !/[A-Za-z]{4,}/.test(original)) return original;
	const fragments = original.match(/[\s\S]{1,6000}/g) ?? [];
	const translated: string[] = [];
	for (let index = 0; index < fragments.length; index++) {
		const fragment = fragments[index]!;
		const result = await requestJson(
			call,
			config,
			"translate",
			`translate-body-${index}`,
			newsPrompt("translate-body"),
			JSON.stringify({ fragments: [fragment] }),
			TranslationSchema,
			16_384,
			0.1,
		);
		if (result.t.length !== 1 || !result.t[0]?.trim())
			rejectOutput(result, "translation fragment count differs from input", "translate");
		guardCopy({ title: "", summary: result.t[0] }, fragment, { origin: result });
		const links = fragment.match(/https?:\/\/[^\s<>"'，。；？！、（）]+/g) ?? [];
		const writtenLinks = result.t[0].match(/https?:\/\/[^\s<>"'，。；？！、（）]+/g) ?? [];
		if (links.some((link) => !result.t[0]!.includes(link)) || writtenLinks.some((link) => !fragment.includes(link)))
			rejectOutput(result, "translation changed a source URL", "translate");
		const numericTokens = (text: string) => (text.match(/\d+(?:\.\d+)?(?:%|[kKmMbB])?/g) ?? []).sort().join("|");
		if (numericTokens(fragment) !== numericTokens(result.t[0]))
			rejectOutput(result, "translation changed a source number", "translate");
		translated.push(result.t[0]);
	}
	return translated.join("");
}

function publicItem(item: NewsItem): boolean {
	return item.status === "ready" && !item.withdrawn && item.relevance === "pass" && item.participation === "editorial";
}

function participants(story: NewsStory, start: number, end: number): Map<string, number> {
	const observed = new Map<string, number>();
	for (const report of story.reports) {
		const at = Date.parse(report.publishedAt);
		if (
			!Number.isFinite(at) ||
			report.withdrawn ||
			report.backfill ||
			Date.parse(report.discoveredAt) - at > 2 * DAY_MS ||
			report.participation === "isolated" ||
			report.status !== "ready" ||
			report.contentKind === "composite" ||
			at <= start ||
			at > end
		)
			continue;
		if (report.participation === "editorial" && (!publicItem(report) || !report.fact?.evidence.length)) continue;
		const key = report.participantId || report.sourceId;
		observed.set(key, Math.max(observed.get(key) ?? Number.NEGATIVE_INFINITY, at));
	}
	return observed;
}

export function calculateNewsHeat(stories: NewsStory[], at: Date = new Date()): NewsHotEvent[] {
	const now = at.getTime();
	const heatAt = (story: NewsStory, time: number) =>
		[...participants(story, time - 2 * DAY_MS, time).values()].reduce(
			(total, observed) => total + 0.5 ** ((time - observed) / DAY_MS),
			0,
		);
	return stories
		.filter(
			(story) =>
				participants(story, now - 2 * DAY_MS, now).size >= 2 &&
				story.reports.some(
					(item) =>
						publicItem(item) &&
						!item.backfill &&
						item.contentKind === "single" &&
						item.fact?.evidence.length &&
						Date.parse(item.publishedAt) > now - 2 * DAY_MS &&
						Date.parse(item.publishedAt) <= now,
				),
		)
		.map((story): NewsHotEvent => {
			const current = heatAt(story, now),
				previous = heatAt(story, now - 6 * 3_600_000);
			const change = previous > 0 ? (current - previous) / previous : null;
			return {
				story,
				heat: Math.round(current * 100) / 10,
				change,
				trend:
					now - Date.parse(story.createdAt) < 6 * 3_600_000
						? "new"
						: change !== null && change > 0.15
							? "rising"
							: "steady",
			};
		})
		.sort((a, b) => b.heat - a.heat || Date.parse(b.story.updatedAt) - Date.parse(a.story.updatedAt));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const id = key(row);
		const members = groups.get(id) ?? [];
		members.push(row);
		groups.set(id, members);
	}
	return groups;
}

function beijingDate(date: Date): string {
	return new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function reportWindow(
	kind: NewsReportKind,
	key: string,
): { start: number; end: number; firstDate: string; lastDate: string } {
	if (kind === "daily") {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("Invalid daily key");
		const end = Date.parse(`${key}T08:00:00+08:00`);
		if (!Number.isFinite(end) || beijingDate(new Date(end)) !== key) throw new Error("Invalid daily date");
		return { start: end - DAY_MS, end, firstDate: key, lastDate: key };
	}
	let firstDate: string, lastDate: string;
	if (kind === "weekly") {
		const match = /^(\d{4})-W(\d{2})$/.exec(key);
		if (!match || Number(match[2]) < 1 || Number(match[2]) > 53) throw new Error("Invalid ISO week key");
		const jan4 = new Date(`${match[1]}-01-04T00:00:00Z`);
		const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS + (Number(match[2]) - 1) * 7 * DAY_MS;
		firstDate = new Date(monday).toISOString().slice(0, 10);
		lastDate = new Date(monday + 6 * DAY_MS).toISOString().slice(0, 10);
	} else {
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new Error("Invalid monthly key");
		const [year, month] = key.split("-").map(Number);
		firstDate = `${key}-01`;
		lastDate = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
	}
	return {
		start: Date.parse(`${firstDate}T08:00:00+08:00`) - DAY_MS,
		end: Date.parse(`${lastDate}T08:00:00+08:00`),
		firstDate,
		lastDate,
	};
}

interface DailyCandidate {
	item: NewsItem;
	related: NewsItem[];
	score: number;
	sourceIds: Set<string>;
	followUp: boolean;
	full: boolean;
	mentions: string[];
}

function dailyCandidates(
	items: NewsItem[],
	stories: NewsStory[],
	previousReports: NewsReport[],
	key: string,
	start: number,
	end: number,
): DailyCandidate[] {
	const memorySince = end - 7 * DAY_MS;
	const previous = previousReports.filter(
		(report) =>
			report.kind === "daily" && report.key < key && Date.parse(`${report.key}T08:00:00+08:00`) >= memorySince,
	);
	const seenItems = new Set<string>(),
		seenFacts = new Set<string>(),
		seenStories = new Set<string>();
	for (const report of previous)
		for (const item of [
			...report.sections.flatMap((section) => section.items),
			...report.briefs,
			...Object.values(report.relatedItems ?? {}).flat(),
		]) {
			seenItems.add(item.id);
			seenFacts.add(newsFactKey(item));
			if (item.storyId) seenStories.add(item.storyId);
		}
	const available = items.filter((item) => publicItem(item) && !item.backfill);
	const candidates = available.filter((item) => {
		const release = Math.max(
			Date.parse(item.timelineAt),
			item.selectedReadyAt ? Date.parse(item.selectedReadyAt) : Date.parse(item.timelineAt),
		);
		return (
			item.selected &&
			release >= start &&
			release < end &&
			Date.parse(item.timelineAt) >= start - DAY_MS &&
			!seenItems.has(item.id) &&
			!seenFacts.has(newsFactKey(item))
		);
	});
	// Official evidence with three independent participants fills gaps in the daily only.
	for (const story of stories) {
		const evidence = story.reports.filter(
			(item) =>
				publicItem(item) &&
				!item.backfill &&
				item.contentKind === "single" &&
				!!item.fact?.evidence.length &&
				item.sourceTier !== "EXCLUDE_MP",
		);
		for (const [factKey, members] of groupBy(evidence, newsFactKey)) {
			const inWindow = members.some(
				(item) => Date.parse(item.timelineAt) >= start && Date.parse(item.timelineAt) < end,
			);
			const relevantSignals = story.reports.filter((report) => newsFactKey(report) === factKey);
			if (
				!inWindow ||
				members.some((item) => item.selected) ||
				participants({ ...story, reports: relevantSignals }, start - DAY_MS, end).size < 3 ||
				Math.min(...members.map((item) => Date.parse(item.timelineAt))) < start - DAY_MS
			)
				continue;
			const official = pickNewsRepresentative(members.filter((item) => item.sourceTier === "T1"));
			if (official && !seenFacts.has(factKey) && !seenItems.has(official.id)) candidates.push(official);
		}
	}
	const facts = [...groupBy(candidates, newsFactKey).values()].map((members) => {
		const representative = pickNewsRepresentative(members)!;
		const reports = available.filter((item) => newsFactKey(item) === newsFactKey(representative));
		return { representative, reports, sources: new Set(reports.map((item) => item.sourceId)).size };
	});
	const result = [
		...groupBy(facts, (fact) => fact.representative.storyId ?? newsFactKey(fact.representative)).values(),
	].map((members): DailyCandidate => {
		members.sort(
			(a, b) =>
				b.sources - a.sources || Date.parse(a.representative.timelineAt) - Date.parse(b.representative.timelineAt),
		);
		const item = members[0]!.representative;
		const related = members.slice(1).map((member) => member.representative);
		const sourceIds = new Set(members.flatMap((member) => member.reports.map((report) => report.sourceId)));
		const followUp = !!item.storyId && seenStories.has(item.storyId);
		const official = members.some((member) => member.reports.some((report) => report.sourceTier === "T1"));
		const story = stories.find((entry) => entry.id === item.storyId);
		const count = story ? participants(story, start, end).size : sourceIds.size;
		const score = Math.max(
			...members.flatMap((member) =>
				member.reports.filter((report) => report.selected).map((report) => report.score ?? 0),
			),
			item.score ?? 0,
		);
		const commentary = CATEGORIES.find((category) => category.key === item.category);
		return {
			item,
			related,
			sourceIds,
			followUp,
			score: (score || 50) + 5 * Math.log2(1 + count) + (official ? 5 : 0) - (followUp ? 6 : 0),
			full:
				!followUp ||
				(item.sourceTier === "T1" && !(commentary && "commentary" in commentary)) ||
				sourceIds.size >= 4,
			mentions: item.mentionedStoryIds ?? [],
		};
	});
	result.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
	// A composite folds underneath the most important event it mentions, never forms a bridge.
	const folded = new Set<DailyCandidate>();
	for (const entry of result) {
		const target = result.find(
			(candidate) =>
				candidate !== entry && candidate.item.storyId && entry.mentions.includes(candidate.item.storyId),
		);
		if (!target) continue;
		target.related.push(entry.item, ...entry.related);
		for (const source of entry.sourceIds) target.sourceIds.add(source);
		folded.add(entry);
	}
	return result.filter((entry) => !folded.has(entry));
}

/** Restrict generated introductions to named/numbered facts in the chosen items. */
export function groundedNewsText(text: string, corpus: string): boolean {
	const known = corpus.toLowerCase();
	const plain = new Set([...PLAIN_TERMS, "owl"]);
	const companyNames = Object.values(ENTITIES).map((entity) =>
		[entity.name, ...entity.aliases, ...(entity.otherNames ?? [])].map((name) => name.toLowerCase()),
	);
	const companies = companyNames.filter((names) => names.some((name) => known.includes(name)));
	const named = (word: string) =>
		plain.has(word) || known.includes(word) || companies.some((names) => names.includes(word));
	const words = (text.match(/[A-Za-z][A-Za-z0-9.+-]*/g) ?? [])
		.filter((word) => /[A-Z0-9]/.test(word))
		.map((word) => word.replace(/[.+-]+$/, "").toLowerCase());
	// Numbers are matched on their digits, not on the unit glyph: the source may write
	// "+23.7 percent" where the summary writes "23.7%", and a different unit rendering is
	// not a fabricated figure. A number that never appears in any rendering is still rejected.
	const figures = (text.match(/\d+(?:\.\d+)?%?/g) ?? []).filter((figure) => figure.length >= 3 || /[.%]/.test(figure));
	const figureKnown = (figure: string) => known.includes(figure.replace(/%/g, ""));
	const lower = text.toLowerCase();
	const mentioned = companyNames.filter((names) =>
		names.some((name) => /\p{Script=Han}/u.test(name) && lower.includes(name)),
	);
	return (
		words.every(named) &&
		figures.every(figureKnown) &&
		mentioned.every((names) => companies.includes(names))
	);
}

function fittedNewsText(text: string, max: number): string {
	let fitted = "";
	for (const sentence of text.trim().match(/[^。！？]+(?:[。！？]+[」”’）]*|$)/g) ?? []) {
		if (Array.from(fitted + sentence).length > max) break;
		fitted += sentence;
	}
	return fitted.trim();
}

export async function composeNewsReport(
	kind: NewsReportKind,
	key: string,
	items: NewsItem[],
	stories: NewsStory[],
	previousReports: NewsReport[],
	call?: NewsModelCaller,
	config?: NewsConfiguration,
): Promise<NewsReport | null> {
	const window = reportWindow(kind, key);
	const sourceItems = new Map(items.filter(publicItem).map((item) => [item.id, item]));
	let main: NewsItem[],
		briefs: NewsItem[] = [];
	let lead: string;
	let intros: Record<string, string> = {};
	let relatedItems: Record<string, NewsItem[]> = {};
	if (kind === "daily") {
		const candidates = dailyCandidates(items, stories, previousReports, key, window.start, window.end);
		const mainCandidates: DailyCandidate[] = [],
			rest: DailyCandidate[] = [];
		const perSource = new Map<string, number>();
		const noEarned = !candidates.some((candidate) => candidate.full);
		for (const candidate of candidates) {
			const count = perSource.get(candidate.item.sourceId) ?? 0;
			if (mainCandidates.length < 12 && count < 2 && (candidate.full || noEarned)) {
				mainCandidates.push(candidate);
				perSource.set(candidate.item.sourceId, count + 1);
			} else rest.push(candidate);
		}
		main = mainCandidates.map((candidate) => candidate.item);
		briefs = rest.slice(0, 10).map((candidate) => candidate.item);
		relatedItems = Object.fromEntries(
			[...mainCandidates, ...rest.slice(0, 10)]
				.filter((candidate) => candidate.related.length)
				.map((candidate) => [candidate.item.id, candidate.related]),
		);
		if (!main.length) return null;
		lead = `${main[0]!.title}\n${main[0]!.summary}`;
	} else {
		const dailyReports = previousReports.filter(
			(report) => report.kind === "daily" && report.key >= window.firstDate && report.key <= window.lastDate,
		);
		const carried = dailyReports.flatMap((report) => {
			const metadata: NewsReport & { leadItemId?: string; highlights?: string[] } = report;
			return report.sections
				.flatMap((section) => section.items)
				.flatMap((item) => {
					const current = sourceItems.get(item.id);
					return current
						? [
								{
									item: current,
									date: report.key,
									lead: metadata.leadItemId === item.id,
									highlight: metadata.highlights?.includes(item.id) ?? false,
									sources: stories.find((story) => story.id === current.storyId)?.sourceCount ?? 1,
								},
							]
						: [];
				});
		});
		const ranked = [...groupBy(carried, (entry) => entry.item.storyId ?? newsFactKey(entry.item)).values()]
			.map((members) => {
				members.sort(
					(a, b) =>
						b.sources - a.sources ||
						a.date.localeCompare(b.date) ||
						Number(b.item.sourceTier === "T1") - Number(a.item.sourceTier === "T1"),
				);
				return {
					item: members[0]!.item,
					rank:
						Math.max(...members.map((member) => member.item.score ?? 0)) +
						5 * Math.log2(1 + Math.max(...members.map((member) => member.sources))) +
						(members.some((member) => member.lead) ? 6 : 0) +
						(members.some((member) => member.highlight) ? 3 : 0) +
						4 * (new Set(members.map((member) => member.date)).size - 1),
				};
			})
			.sort((a, b) => b.rank - a.rank || a.item.id.localeCompare(b.item.id));
		main = ranked.slice(0, kind === "weekly" ? 20 : 30).map((entry) => entry.item);
		if (!main.length) return null;
		lead = `${key} 共收录 ${main.length} 件 AI 事件，来自 ${dailyReports.length} 期日报。`;
		if (call && config?.modelCallsEnabled) {
			const groups = groupBy(
				main,
				(item) => CATEGORIES.find((category) => category.key === item.category)?.section ?? "行业动态",
			);
			const introduced = [...groups].filter(([, members]) => members.length >= 3).map(([label]) => label);
			const result = await requestJson(
				call,
				config,
				"report",
				`report-${kind}`,
				newsPrompt("report-period", {
					kindName: kind === "weekly" ? "周报" : "月报",
					span: kind === "weekly" ? "一周" : "个月",
					sentences: kind === "weekly" ? "三到四句" : "四到五句",
					chars: kind === "weekly" ? "250" : "350",
					sections: introduced.length
						? newsPrompt("report-period-sections", {
								columns: introduced.map((label) => `「${label}」`).join(""),
							})
						: "",
					sectionsExample: introduced.length ? JSON.stringify({ [introduced[0]!]: "栏目导读" }) : "{}",
				}),
				JSON.stringify({
					periodStart: window.firstDate,
					periodEnd: window.lastDate,
					sections: [...groups].map(([label, members]) => ({
						label,
						items: members.map((item) => ({ title: item.title, summary: item.summary })),
					})),
				}),
				PeriodSchema,
				2500,
				0.3,
			);
			const corpus = [
				`${window.firstDate} ${window.lastDate}`,
				...main.map((item) => `${item.title}\n${item.summary}`),
			].join("\n");
			const overview = fittedNewsText(result.overview, kind === "weekly" ? 250 : 350);
			if (overview && groundedNewsText(overview, corpus)) lead = overview;
			intros = Object.fromEntries(
				Object.entries(result.sections)
					.map(([label, text]) => [label, fittedNewsText(text, 90)] as const)
					.filter(([label, text]) => introduced.includes(label) && text.trim() && groundedNewsText(text, corpus)),
			);
		}
	}
	const sectionOrder = [...new Set(CATEGORIES.map((category) => category.section))];
	const bySection = groupBy(
		main,
		(item) => CATEGORIES.find((category) => category.key === item.category)?.section ?? "行业动态",
	);
	const sections = sectionOrder.flatMap((label) => {
		const members = bySection.get(label);
		return members?.length ? [{ label, summary: intros[label] ?? "", items: members }] : [];
	});
	const sources = new Set([...main, ...briefs].map((item) => item.sourceId));
	const report: NewsReport & { leadItemId: string; highlights: string[] } = {
		id: `${kind}:${key}`,
		kind,
		key,
		periodStart: new Date(window.start).toISOString(),
		periodEnd: new Date(window.end).toISOString(),
		title: `Owl 资讯${kind === "daily" ? "日报" : kind === "weekly" ? "周报" : "月报"} · ${key}`,
		lead,
		leadItemId: main[0]!.id,
		highlights: main.slice(1, 4).map((item) => item.id),
		sections,
		briefs,
		relatedItems,
		createdAt: new Date().toISOString(),
		sourceCount: sources.size,
		storyCount: main.length,
	};
	return report;
}

function selectionMetrics(cases: NewsEvaluation["cases"]): { accuracy: number; precision: number; recall: number } {
	const labeled = cases.filter((entry) => entry.gold !== "either" && entry.error === null);
	const tp = labeled.filter((entry) => entry.gold === "select" && entry.selected).length;
	const tn = labeled.filter((entry) => entry.gold === "reject" && !entry.selected).length;
	const fp = labeled.filter((entry) => entry.gold === "reject" && entry.selected).length;
	const fn = labeled.filter((entry) => entry.gold === "select" && !entry.selected).length;
	return {
		accuracy: labeled.length ? (tp + tn) / labeled.length : 0,
		precision: tp + fp ? tp / (tp + fp) : 0,
		recall: tp + fn ? tp / (tp + fn) : 0,
	};
}

/** Evaluate article value independently of grouping; no writing/translation calls are purchased. */
export async function evaluateSelection(
	samples: NewsEvaluationSample[],
	config: NewsConfiguration,
	call: NewsModelCaller,
	onOutputError?: (error: NewsOutputError) => void,
): Promise<NewsEvaluation> {
	const scoresCache = new Map<string, Promise<number[]>>();
	const raw: Array<{ sample: NewsEvaluationSample; pass: boolean; sum: number | null; error: string | null }> = [];
	for (const sample of samples) {
		const source: NewsSource = {
			id: `eval:${sample.id}`,
			name: "评测样本",
			kind: "external",
			config: {},
			tier: sample.tier,
			participation: "editorial",
			enabled: true,
			intervalMinutes: 30,
			siteFulltext: false,
			syndicateFulltext: false,
			lastCollectedAt: null,
			nextCollectedAt: null,
			lastError: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		try {
			const prefilter = await prefilterMaterial(sample.material, source, config, call);
			let sum: number | null = null;
			if (prefilter.label !== "BLOCK" && config.thresholds[sample.tier] !== null) {
				const key = newsScoreInput(sample.material);
				let scores = scoresCache.get(key);
				if (!scores) {
					scores = scoreMaterial(sample.material, config, call);
					scoresCache.set(key, scores);
				}
				const values = await scores;
				sum = values[0]! + values[1]!;
			}
			raw.push({ sample, pass: prefilter.label !== "BLOCK", sum, error: null });
		} catch (error) {
			if (error instanceof NewsOutputError) onOutputError?.(error);
			raw.push({ sample, pass: false, sum: null, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const cases = raw.map((entry) => ({
		id: entry.sample.id,
		gold: entry.sample.gold,
		selected:
			entry.pass &&
			entry.sum !== null &&
			config.thresholds[entry.sample.tier] !== null &&
			entry.sum >= config.thresholds[entry.sample.tier]! * 2,
		score: entry.sum === null ? null : Math.floor(entry.sum / 2),
		error: entry.error,
	}));
	const thresholds = Array.from({ length: 26 }, (_, index) => {
		const threshold = 40 + index * 2;
		const alternative = raw.map((entry) => ({
			id: entry.sample.id,
			gold: entry.sample.gold,
			selected: entry.pass && entry.sum !== null && entry.sum >= threshold * 2,
			score: entry.sum === null ? null : Math.floor(entry.sum / 2),
			error: entry.error,
		}));
		const metrics = selectionMetrics(alternative);
		return { threshold, precision: metrics.precision, recall: metrics.recall };
	});
	return {
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		count: samples.length,
		...selectionMetrics(cases),
		cases,
		thresholds,
	};
}
