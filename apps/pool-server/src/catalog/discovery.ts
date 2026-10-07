/**
 * 模型发现 —— 移植自 manager `ModelDiscoveryService` 里管理台会打到的部分：
 * 列出已发现模型、同步各平台上游目录、按已发现目录补未上架草稿、批量上架、核验。
 * Claude/Gemini/Grok 上游暂时不可达时回退内置清单。WorkBuddy、Trae、Qoder 失败时保留上次成功快照。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type Account, BusinessError, type Platform, type PublishedModel, parseCredentials } from "owl-pool";
import type { SqliteCatalogStore } from "../store/gateway-stores.ts";
import { fetchTraeCatalog } from "./trae-catalog.ts";
import { fetchWorkBuddyVisibleModels, type WorkBuddyCatalogConfig } from "./workbuddy-catalog.ts";

export interface DiscoveredDescriptor {
	upstreamModel: string;
	name: string;
	catalogSource: string;
	modelVersion?: string | null;
	contextWindow?: number | null;
	maxOutputTokens?: number | null;
	supportsImages?: boolean | null;
	supportsTools?: boolean | null;
	reasoningEfforts?: string[] | null;
	defaultReasoningEffort?: string | null;
	availableModes?: string[] | null;
	upstreamMultimodal?: boolean | null;
	available?: boolean;
}

export interface LiveDiscoveryOptions {
	trae?: {
		chatBaseUrl: string;
		chatPath: string;
		appId: string;
		ideVersion: string;
		ideVersionCode: string;
		remoteBaseUrl?: string;
	};
	workbuddy?: WorkBuddyCatalogConfig;
	sdkCatalog?: (account: Account) => Promise<unknown>;
}

interface DiscoveryNotice {
	state: string;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	error: string | null;
	added: string[];
	removed: string[];
	unchangedCount: number;
	affectedPublicModels: string[];
	unavailableModels: string[];
	noticeRevision: string | null;
	noticeAdded: string[];
}

const notices: Record<string, DiscoveryNotice> = {
	workbuddy: emptyNotice(),
	qoder: emptyNotice(),
	trae: emptyNotice(),
};

const CLAUDE_STATIC = [
	"claude-sonnet-4-5",
	"claude-sonnet-4-5-20250929",
	"claude-haiku-4-5",
	"claude-haiku-4-5-20251001",
	"claude-opus-4-5",
	"claude-opus-4-5-20251101",
];
const GEMINI_STATIC = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
const GROK_STATIC = [
	"grok-4",
	"grok-4-fast-reasoning",
	"grok-4-fast-non-reasoning",
	"grok-3",
	"grok-3-mini",
	"grok-code-fast-1",
];

const AUTHORITATIVE: Record<string, string[]> = {
	CLAUDE: ["claude_live", "claude_static"],
	GEMINI: ["gemini_live", "gemini_static"],
	GROK: ["grok_live", "grok_static"],
	ZCODE: ["zcode_live", "zcode_static"],
	WORKBUDDY: ["workbuddy_ui"],
	TRAE: ["trae_live"],
	QODER: ["qoder_builtin_live"],
	CODEX: ["provider_catalog"],
	CURSOR: ["provider_catalog"],
	COPILOT: ["provider_catalog"],
	MIMO: ["mimo_live", "mimo_catalog"],
};

export function listDiscovered(db: DatabaseSync): Array<Record<string, unknown>> {
	const rows = db
		.prepare("SELECT * FROM discovered_models ORDER BY platform, display_order, upstream_model")
		.all() as Array<Record<string, unknown>>;
	return rows.map((row) => discoveredView(db, row));
}

export function discoveryStatus(): Record<string, DiscoveryNotice> {
	return {
		workbuddy: notices.workbuddy ?? emptyNotice(),
		qoder: notices.qoder ?? emptyNotice(),
		trae: notices.trae ?? emptyNotice(),
	};
}

export async function syncDiscovered(
	db: DatabaseSync,
	accounts: Account[],
	live: LiveDiscoveryOptions = {},
): Promise<Array<Record<string, unknown>>> {
	await syncHttpPlatform(db, accounts, "CLAUDE", discoverClaude);
	await syncHttpPlatform(db, accounts, "GEMINI", discoverGemini);
	await syncHttpPlatform(db, accounts, "GROK", discoverGrok);
	await syncHttpPlatform(db, accounts, "ZCODE", discoverZcode);
	await syncAuthoritative(db, accounts, "TRAE", "trae", "trae_live", (active) => discoverTrae(active, live));
	await syncAuthoritative(db, accounts, "WORKBUDDY", "workbuddy", "workbuddy_ui", (active) =>
		discoverWorkBuddy(active, live),
	);
	await syncAuthoritative(db, accounts, "QODER", "qoder", "qoder_builtin_live", (active) =>
		discoverSdk(active, live, "Qoder CN 当前账号未返回可用内置模型"),
	);
	if (live.sdkCatalog !== undefined) {
		await syncSdkSnapshot(db, accounts, "CURSOR", "provider_catalog", live);
		await syncSdkSnapshot(db, accounts, "COPILOT", "provider_catalog", live);
	}
	return listDiscovered(db);
}

export function backfillDiscoveredDrafts(
	db: DatabaseSync,
	catalog: SqliteCatalogStore,
	accounts: Account[],
): PublishedModel[] {
	const created: PublishedModel[] = [];
	const enabled = new Set(accounts.filter((account) => account.enabled).map((account) => account.platform));
	for (const row of db.prepare("SELECT * FROM discovered_models WHERE available = 1").all() as Array<
		Record<string, unknown>
	>) {
		const platform = String(row.platform);
		if (!enabled.has(platform as Platform)) {
			continue;
		}
		const source = textOrNull(row.catalog_source);
		if (source === null || !(AUTHORITATIVE[platform] ?? []).includes(source)) {
			continue;
		}
		const upstream = String(row.upstream_model);
		if (upstream === "auto" || upstream === "default") {
			continue;
		}
		const draft = ensureDraft(catalog, platform as Platform, upstream, textOrNull(row.name) ?? upstream, row);
		if (draft !== null) {
			created.push(draft);
		}
	}
	return created;
}

export function batchPublish(catalog: SqliteCatalogStore, modelIds: string[]): PublishedModel[] {
	if (modelIds.length === 0) {
		throw BusinessError.of("catalog.modelIdsRequired", "请选择要上架的模型");
	}
	const published: PublishedModel[] = [];
	for (const id of modelIds) {
		const model = catalog.listModels().find((item) => item.id === id);
		if (model === undefined) {
			throw BusinessError.of("catalog.modelNotFound", "模型不存在");
		}
		const next = { ...model, published: true, updatedAt: Date.now() };
		catalog.saveModel(next);
		published.push(next);
	}
	return published;
}

export function verifyDiscovered(db: DatabaseSync, id: string, body: Record<string, unknown>): Record<string, unknown> {
	const row = db.prepare("SELECT * FROM discovered_models WHERE id = ?").get(id) as
		| Record<string, unknown>
		| undefined;
	if (row === undefined) {
		throw BusinessError.of("catalog.discoveredNotFound", "已发现模型不存在");
	}
	const efforts = Array.isArray(body.reasoningEfforts) ? body.reasoningEfforts.map((item) => String(item)) : [];
	db.prepare(`
		UPDATE discovered_models SET
			verified_model_version = ?, verified_supports_images = ?, verified_supports_tools = ?,
			verified_reasoning_efforts = ?, verified_at = ?, verification_source = ?,
			verification_status = 'VERIFIED', verification_invalidated_at = NULL
		WHERE id = ?
	`).run(
		textOrNull(body.verifiedModelVersion),
		body.supportsImages === true ? 1 : 0,
		body.supportsTools === true ? 1 : 0,
		JSON.stringify(efforts),
		Date.now(),
		textOrNull(body.verificationSource),
		id,
	);
	const next = db.prepare("SELECT * FROM discovered_models WHERE id = ?").get(id) as Record<string, unknown>;
	return discoveredView(db, next);
}

/** 管理台 Ping：对已接入的 HTTP 平台打模型目录，其余平台如实说明还没有探测。 */
export async function probeAccount(account: Account): Promise<Record<string, unknown>> {
	const started = Date.now();
	try {
		if (account.platform === "CLAUDE") {
			await claudeModelIds(account);
		} else if (account.platform === "GEMINI") {
			await geminiRows(account);
		} else if (account.platform === "GROK" || account.platform === "ZCODE") {
			await openAiModelIds(account, account.platform === "GROK" ? "https://api.x.ai" : zcodeBase(account));
		} else {
			return pingBody(account, false, Date.now() - started, `${account.platform} 的连通性探测还没有接入`);
		}
		return pingBody(account, true, Date.now() - started, "模型目录可达");
	} catch (error) {
		const message = error instanceof Error && error.message.length > 0 ? error.message : "上游不可达";
		return pingBody(account, false, Date.now() - started, message);
	}
}

export function replacePlatformSnapshot(
	db: DatabaseSync,
	platform: Platform,
	descriptors: DiscoveredDescriptor[],
): string[] {
	const seen = new Map<string, DiscoveredDescriptor>();
	for (const descriptor of descriptors) {
		const id = descriptor.upstreamModel.trim();
		if (id.length === 0 || id.length > 256 || id === "auto" || id === "default" || seen.has(id)) {
			continue;
		}
		seen.set(id, descriptor);
	}
	const existing = db.prepare("SELECT * FROM discovered_models WHERE platform = ?").all(platform) as Array<
		Record<string, unknown>
	>;
	const byUpstream = new Map(existing.map((row) => [String(row.upstream_model), row]));
	const firstSeen: string[] = [];
	const now = Date.now();
	let order = 0;
	for (const [upstream, descriptor] of seen) {
		const previous = byUpstream.get(upstream);
		byUpstream.delete(upstream);
		if (previous === undefined || textOrNull(previous.catalog_source) !== descriptor.catalogSource) {
			firstSeen.push(upstream);
		}
		upsertDiscovered(db, platform, upstream, descriptor, previous, order, now);
		order += 1;
	}
	for (const missing of byUpstream.values()) {
		db.prepare(
			"UPDATE discovered_models SET available = 0, updated_at = ? WHERE platform = ? AND upstream_model = ?",
		).run(now, platform, String(missing.upstream_model));
	}
	return firstSeen;
}

async function syncAuthoritative(
	db: DatabaseSync,
	accounts: Account[],
	platform: Platform,
	noticeKey: string,
	source: string,
	discover: (active: Account[]) => Promise<DiscoveredDescriptor[]>,
): Promise<void> {
	const active = accounts.filter(
		(account) => account.enabled && account.platform === platform && hasCatalogCredential(account),
	);
	if (active.length === 0) {
		replacePlatformSnapshot(db, platform, []);
		notices[noticeKey] = emptyNotice();
		return;
	}
	const before = availableIds(db, platform, source);
	try {
		const descriptors = await discover(active);
		const current = new Set(descriptors.map((item) => item.upstreamModel));
		replacePlatformSnapshot(db, platform, descriptors);
		noteSuccess(db, noticeKey, platform, source, before, current, true);
	} catch (error) {
		const message = error instanceof Error && error.message.length > 0 ? error.message : "官方模型目录不可用";
		noteFailure(noticeKey, message);
	}
}

async function syncSdkSnapshot(
	db: DatabaseSync,
	accounts: Account[],
	platform: Platform,
	_source: string,
	live: LiveDiscoveryOptions,
): Promise<void> {
	const active = accounts.filter((account) => account.enabled && account.platform === platform);
	if (active.length === 0) {
		replacePlatformSnapshot(db, platform, []);
		return;
	}
	try {
		replacePlatformSnapshot(db, platform, await discoverSdk(active, live, "当前账号未返回可用模型目录"));
	} catch (error) {
		console.warn(
			`Model discovery failed for ${platform} (${error instanceof Error ? error.message : "官方模型目录不可用"})`,
		);
	}
}

async function discoverTrae(accounts: Account[], live: LiveDiscoveryOptions): Promise<DiscoveredDescriptor[]> {
	if (live.trae === undefined) {
		throw new Error("Trae 模型目录客户端未配置");
	}
	const union = new Map<string, DiscoveredDescriptor>();
	for (const account of accounts) {
		const models = await fetchTraeCatalog(account, live.trae, live.trae.remoteBaseUrl);
		if (models.length === 0) {
			throw new Error("Trae 账号的可见模型目录为空");
		}
		for (const model of models) {
			const existing = union.get(model.upstreamModel);
			union.set(model.upstreamModel, {
				upstreamModel: model.upstreamModel,
				name: existing?.name ?? model.name,
				catalogSource: "trae_live",
				contextWindow: wider(existing?.contextWindow, model.contextWindow),
				maxOutputTokens: wider(existing?.maxOutputTokens, model.maxOutputTokens),
				upstreamMultimodal: model.upstreamMultimodal,
				availableModes: [...new Set([...(existing?.availableModes ?? []), ...model.modes])],
			});
		}
	}
	return [...union.values()];
}

async function discoverWorkBuddy(accounts: Account[], live: LiveDiscoveryOptions): Promise<DiscoveredDescriptor[]> {
	if (live.workbuddy === undefined) {
		throw new Error("WorkBuddy 模型目录客户端未配置");
	}
	const union = new Map<string, DiscoveredDescriptor>();
	for (const account of accounts) {
		const models = await fetchWorkBuddyVisibleModels(account, live.workbuddy);
		if (models.length === 0) {
			throw new Error(`账号“${account.name}”的官方可见模型列表为空`);
		}
		for (const model of models) {
			const existing = union.get(model.upstreamModel);
			union.set(model.upstreamModel, {
				upstreamModel: model.upstreamModel,
				name: model.name,
				catalogSource: "workbuddy_ui",
				modelVersion: model.modelVersion,
				contextWindow: wider(existing?.contextWindow, model.contextWindow),
				maxOutputTokens: wider(existing?.maxOutputTokens, model.maxOutputTokens),
				supportsImages: model.supportsImages,
				supportsTools: model.supportsTools,
				reasoningEfforts: model.reasoningEfforts,
				defaultReasoningEffort: model.defaultReasoningEffort,
			});
		}
	}
	return [...union.values()];
}

async function discoverSdk(
	accounts: Account[],
	live: LiveDiscoveryOptions,
	emptyMessage: string,
): Promise<DiscoveredDescriptor[]> {
	if (live.sdkCatalog === undefined) {
		throw new Error("平台运行组件未启用");
	}
	const found = new Map<string, DiscoveredDescriptor>();
	for (const account of accounts) {
		const raw = await live.sdkCatalog(account);
		const rows = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.models) ? raw.models : [];
		if (rows.length === 0) {
			throw new Error(emptyMessage);
		}
		for (const row of rows) {
			if (!isRecord(row) || typeof row.id !== "string" || row.id.trim().length === 0) {
				continue;
			}
			const id = row.id.trim();
			found.set(id, {
				upstreamModel: id,
				name: typeof row.name === "string" && row.name.trim().length > 0 ? row.name.trim() : id,
				catalogSource: account.platform === "QODER" ? "qoder_builtin_live" : "provider_catalog",
				modelVersion: typeof row.modelVersion === "string" ? row.modelVersion : null,
				contextWindow: positive(row.contextWindow),
				maxOutputTokens: positive(row.maxOutputTokens),
				supportsImages: typeof row.supportsImages === "boolean" ? row.supportsImages : null,
				supportsTools: typeof row.supportsTools === "boolean" ? row.supportsTools : null,
				reasoningEfforts: Array.isArray(row.reasoningEfforts)
					? row.reasoningEfforts.filter((item): item is string => typeof item === "string")
					: null,
				defaultReasoningEffort: typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : null,
			});
		}
	}
	if (found.size === 0) {
		throw new Error(emptyMessage);
	}
	return [...found.values()];
}

function hasCatalogCredential(account: Account): boolean {
	if (account.platform !== "TRAE") {
		return true;
	}
	const session = parseCredentials(account).session;
	return typeof session === "string" && session.trim().length > 0;
}

function noteSuccess(
	db: DatabaseSync,
	key: string,
	platform: Platform,
	source: string,
	before: Set<string>,
	current: Set<string>,
	manual: boolean,
): void {
	const previous = notices[key] ?? emptyNotice();
	const added = before.size === 0 ? [] : [...current].filter((id) => !before.has(id));
	const removed = before.size === 0 ? [] : [...before].filter((id) => !current.has(id));
	const unchanged = [...current].filter((id) => before.has(id)).length;
	const unavailable = unavailableIds(db, platform, source);
	const now = new Date().toISOString();
	const noticeAdded = (manual ? previous.noticeAdded : added).filter((id) => current.has(id));
	notices[key] = {
		state: "ok",
		lastAttemptAt: now,
		lastSuccessAt: now,
		lastFailureAt: null,
		error: null,
		added,
		removed,
		unchangedCount: unchanged,
		affectedPublicModels: affectedPublic(db, platform, unavailable),
		unavailableModels: unavailable,
		noticeRevision: noticeAdded.length === 0 ? null : manual ? previous.noticeRevision : now,
		noticeAdded,
	};
}

function noteFailure(key: string, message: string): void {
	const previous = notices[key] ?? emptyNotice();
	const now = new Date().toISOString();
	notices[key] = { ...previous, state: "failed", lastAttemptAt: now, lastFailureAt: now, error: message };
}

function emptyNotice(): DiscoveryNotice {
	return {
		state: "never",
		lastAttemptAt: null,
		lastSuccessAt: null,
		lastFailureAt: null,
		error: null,
		added: [],
		removed: [],
		unchangedCount: 0,
		affectedPublicModels: [],
		unavailableModels: [],
		noticeRevision: null,
		noticeAdded: [],
	};
}

function availableIds(db: DatabaseSync, platform: Platform, source: string): Set<string> {
	const rows = db
		.prepare(
			"SELECT upstream_model FROM discovered_models WHERE platform = ? AND catalog_source = ? AND available = 1",
		)
		.all(platform, source) as Array<{ upstream_model: string }>;
	return new Set(rows.map((row) => row.upstream_model).filter((id) => id !== "auto" && id !== "default"));
}

function unavailableIds(db: DatabaseSync, platform: Platform, source: string): string[] {
	const rows = db
		.prepare(
			"SELECT upstream_model FROM discovered_models WHERE platform = ? AND catalog_source = ? AND available = 0 AND last_seen_at IS NOT NULL ORDER BY upstream_model",
		)
		.all(platform, source) as Array<{ upstream_model: string }>;
	return rows.map((row) => row.upstream_model).filter((id) => id !== "auto" && id !== "default");
}

function affectedPublic(db: DatabaseSync, platform: Platform, unavailable: string[]): string[] {
	if (unavailable.length === 0) {
		return [];
	}
	const routeRows = db
		.prepare(
			"SELECT m.public_id AS public_id, r.upstream_model AS upstream_model FROM published_models m JOIN published_model_routes r ON r.model_id = m.id WHERE m.published = 1 AND r.enabled = 1 AND r.platform = ?",
		)
		.all(platform) as Array<{ public_id: string; upstream_model: string }>;
	const blocked = new Set(unavailable);
	return [...new Set(routeRows.filter((row) => blocked.has(row.upstream_model)).map((row) => row.public_id))].sort();
}

function wider(first: number | null | undefined, second: number | null): number | null {
	if (first === undefined || first === null) {
		return second;
	}
	if (second === null) {
		return first;
	}
	return Math.max(first, second);
}

function positive(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function syncHttpPlatform(
	db: DatabaseSync,
	accounts: Account[],
	platform: Platform,
	discover: (active: Account[]) => Promise<DiscoveredDescriptor[]>,
): Promise<void> {
	const active = accounts.filter((account) => account.enabled && account.platform === platform);
	if (active.length === 0) {
		replacePlatformSnapshot(db, platform, []);
		return;
	}
	try {
		replacePlatformSnapshot(db, platform, await discover(active));
	} catch (error) {
		const message = error instanceof Error ? error.message : "官方模型目录不可用";
		console.warn(`Model discovery failed for ${platform} (${message})`);
	}
}

async function discoverClaude(accounts: Account[]): Promise<DiscoveredDescriptor[]> {
	return discoverUnion(accounts, claudeModelIds, CLAUDE_STATIC, "claude_live", "claude_static", 200_000, true);
}

async function discoverGemini(accounts: Account[]): Promise<DiscoveredDescriptor[]> {
	const union = new Map<string, DiscoveredDescriptor>();
	for (const account of accounts) {
		try {
			for (const row of await geminiRows(account)) {
				const name = String(row.name ?? "");
				const id = name.startsWith("models/") ? name.slice("models/".length) : name;
				if (id.length === 0 || union.has(id)) {
					continue;
				}
				const methods = row.supportedGenerationMethods;
				if (Array.isArray(methods) && !methods.includes("generateContent")) {
					continue;
				}
				union.set(id, {
					upstreamModel: id,
					name: id,
					catalogSource: "gemini_live",
					contextWindow: typeof row.inputTokenLimit === "number" ? row.inputTokenLimit : null,
					maxOutputTokens: typeof row.outputTokenLimit === "number" ? row.outputTokenLimit : null,
					supportsImages: true,
					supportsTools: true,
				});
			}
		} catch {
			// 单个账号失败不否决其他账号
		}
	}
	if (union.size === 0) {
		for (const id of GEMINI_STATIC) {
			union.set(id, {
				upstreamModel: id,
				name: id,
				catalogSource: "gemini_static",
				supportsImages: true,
				supportsTools: true,
			});
		}
	}
	if (union.size === 0) {
		throw new Error("Gemini 账号的可见模型目录为空");
	}
	return [...union.values()];
}

async function discoverGrok(accounts: Account[]): Promise<DiscoveredDescriptor[]> {
	return discoverUnion(
		accounts,
		(account) => openAiModelIds(account, "https://api.x.ai"),
		GROK_STATIC,
		"grok_live",
		"grok_static",
		null,
		null,
	);
}

async function discoverZcode(accounts: Account[]): Promise<DiscoveredDescriptor[]> {
	const ids = new Set<string>();
	let live = false;
	for (const account of accounts) {
		try {
			for (const id of await openAiModelIds(account, zcodeBase(account))) {
				ids.add(id);
			}
			live = true;
		} catch {
			// ZCode 单账号失败时不灌一份猜测清单
		}
	}
	if (ids.size === 0) {
		throw new Error("ZCode 账号的可见模型目录为空");
	}
	const source = live ? "zcode_live" : "zcode_static";
	return [...ids].map((id) => ({ upstreamModel: id, name: id, catalogSource: source, supportsTools: true }));
}

async function discoverUnion(
	accounts: Account[],
	load: (account: Account) => Promise<string[]>,
	fallback: string[],
	liveSource: string,
	staticSource: string,
	contextWindow: number | null,
	supportsImages: boolean | null,
): Promise<DiscoveredDescriptor[]> {
	const ids = new Set<string>();
	let live = false;
	for (const account of accounts) {
		try {
			for (const id of await load(account)) {
				ids.add(id);
			}
			live = true;
		} catch {
			// 继续试下一个账号
		}
	}
	if (!live) {
		for (const id of fallback) {
			ids.add(id);
		}
	}
	if (ids.size === 0) {
		throw new Error("可见模型目录为空");
	}
	const source = live ? liveSource : staticSource;
	return [...ids].map((id) => ({
		upstreamModel: id,
		name: id,
		catalogSource: source,
		contextWindow,
		supportsImages,
		supportsTools: true,
	}));
}

async function claudeModelIds(account: Account): Promise<string[]> {
	const creds = parseCredentials(account);
	const oauth = String(creds.authType ?? "apikey").toLowerCase() === "oauth";
	const token = oauth ? String(creds.accessToken ?? "") : String(creds.apiKey ?? "");
	if (token.trim().length === 0) {
		throw new Error(oauth ? "CLAUDE OAuth 账号缺少可用 accessToken" : "CLAUDE 账号缺少 apiKey");
	}
	const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
	if (oauth) {
		headers.Authorization = `Bearer ${token}`;
	} else {
		headers["x-api-key"] = token;
	}
	const response = await fetch("https://api.anthropic.com/v1/models", { headers, signal: AbortSignal.timeout(8000) });
	if (!response.ok) {
		throw new Error(`Claude 模型目录返回 ${response.status}`);
	}
	const body = (await response.json()) as { data?: Array<{ id?: string }> };
	return (body.data ?? []).map((item) => String(item.id ?? "")).filter((id) => id.length > 0);
}

async function geminiRows(account: Account): Promise<Array<Record<string, unknown>>> {
	const creds = parseCredentials(account);
	const key = String(creds.apiKey ?? "");
	if (key.trim().length === 0) {
		throw new Error("Gemini 账号缺少 apiKey");
	}
	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
		{
			signal: AbortSignal.timeout(8000),
		},
	);
	if (!response.ok) {
		throw new Error(`Gemini 模型目录返回 ${response.status}`);
	}
	const body = (await response.json()) as { models?: Array<Record<string, unknown>> };
	return body.models ?? [];
}

async function openAiModelIds(account: Account, baseUrl: string): Promise<string[]> {
	const creds = parseCredentials(account);
	const key = String(creds.apiKey ?? creds.accessToken ?? "");
	if (key.trim().length === 0) {
		throw new Error("账号缺少 apiKey");
	}
	const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(8000),
	});
	if (!response.ok) {
		throw new Error(`模型目录返回 ${response.status}`);
	}
	const body = (await response.json()) as { data?: Array<{ id?: string }> };
	return (body.data ?? []).map((item) => String(item.id ?? "")).filter((id) => id.length > 0);
}

function zcodeBase(account: Account): string {
	const base = String(parseCredentials(account).baseUrl ?? "").trim();
	if (base.length === 0) {
		throw new Error("ZCode 账号缺少 baseUrl");
	}
	return base;
}

function upsertDiscovered(
	db: DatabaseSync,
	platform: Platform,
	upstream: string,
	descriptor: DiscoveredDescriptor,
	previous: Record<string, unknown> | undefined,
	order: number,
	now: number,
): void {
	const id = previous === undefined || textOrNull(previous.id) === null ? randomUUID() : String(previous.id);
	db.prepare(`
		INSERT INTO discovered_models (
			platform, upstream_model, available, context_window, max_output_tokens, updated_at,
			id, name, catalog_source, model_version, display_order, supports_images, supports_tools,
			reasoning_efforts, available_modes, upstream_multimodal, default_reasoning_effort, last_seen_at, verification_status
		) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(platform, upstream_model) DO UPDATE SET
			available = 1, context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
			updated_at = excluded.updated_at, id = COALESCE(discovered_models.id, excluded.id),
			name = excluded.name, catalog_source = excluded.catalog_source, model_version = excluded.model_version,
			display_order = excluded.display_order, supports_images = excluded.supports_images,
			supports_tools = excluded.supports_tools, reasoning_efforts = excluded.reasoning_efforts,
			available_modes = excluded.available_modes, upstream_multimodal = excluded.upstream_multimodal,
			default_reasoning_effort = excluded.default_reasoning_effort, last_seen_at = excluded.last_seen_at
	`).run(
		platform,
		upstream,
		descriptor.contextWindow ?? null,
		descriptor.maxOutputTokens ?? null,
		now,
		id,
		descriptor.name,
		descriptor.catalogSource,
		descriptor.modelVersion ?? null,
		order,
		boolOrNull(descriptor.supportsImages),
		boolOrNull(descriptor.supportsTools),
		JSON.stringify(descriptor.reasoningEfforts ?? []),
		JSON.stringify(descriptor.availableModes ?? []),
		boolOrNull(descriptor.upstreamMultimodal),
		descriptor.defaultReasoningEffort ?? null,
		now,
		previous === undefined ? "UNVERIFIED" : (textOrNull(previous.verification_status) ?? "UNVERIFIED"),
	);
}

function ensureDraft(
	catalog: SqliteCatalogStore,
	platform: Platform,
	upstream: string,
	name: string,
	row: Record<string, unknown>,
): PublishedModel | null {
	const existing =
		catalog.findPublishedByPublicId(upstream) ?? catalog.listModels().find((model) => model.publicId === upstream);
	const images = Number(row.supports_images) === 1;
	const tools = Number(row.supports_tools) === 1;
	if (existing === undefined) {
		const model: PublishedModel = {
			id: randomUUID(),
			publicId: upstream,
			name,
			description: null,
			modelVersion: textOrNull(row.model_version),
			contextWindow: numberOrNull(row.context_window),
			defaultContextWindow: numberOrNull(row.context_window),
			defaultReasoningEffort: textOrNull(row.default_reasoning_effort),
			maxOutputTokens: numberOrNull(row.max_output_tokens),
			supportsImages: images,
			supportsTools: tools,
			reasoningEfforts: jsonList(row.reasoning_efforts),
			published: false,
			sortOrder: 0,
			updatedAt: Date.now(),
		};
		catalog.saveModel(model);
		catalog.saveRoute({
			id: randomUUID(),
			modelId: model.id,
			platform,
			upstreamModel: upstream,
			priority: 0,
			enabled: true,
			supportsImages: images,
			supportsTools: tools,
			reasoningEfforts: model.reasoningEfforts,
		});
		return model;
	}
	const routes = catalog.routesOf(existing.id);
	if (!routes.some((route) => route.platform === platform && route.upstreamModel === upstream)) {
		catalog.saveRoute({
			id: randomUUID(),
			modelId: existing.id,
			platform,
			upstreamModel: upstream,
			priority: routes.length,
			enabled: !existing.published,
			supportsImages: images,
			supportsTools: tools,
			reasoningEfforts: jsonList(row.reasoning_efforts),
		});
	}
	return null;
}

function discoveredView(db: DatabaseSync, row: Record<string, unknown>): Record<string, unknown> {
	let id = textOrNull(row.id);
	if (id === null) {
		id = randomUUID();
		db.prepare("UPDATE discovered_models SET id = ? WHERE platform = ? AND upstream_model = ?").run(
			id,
			String(row.platform),
			String(row.upstream_model),
		);
	}
	const verified = textOrNull(row.verification_status) === "VERIFIED";
	return {
		id,
		platform: row.platform,
		upstreamModel: row.upstream_model,
		name: textOrNull(row.name) ?? row.upstream_model,
		catalogSource: textOrNull(row.catalog_source),
		modelVersion: verified ? textOrNull(row.verified_model_version) : textOrNull(row.model_version),
		displayOrder: numberOrNull(row.display_order),
		contextWindow: numberOrNull(row.context_window),
		maxOutputTokens: numberOrNull(row.max_output_tokens),
		supportsImages: verified ? Number(row.verified_supports_images) === 1 : Number(row.supports_images) === 1,
		upstreamMultimodal: Number(row.upstream_multimodal) === 1,
		supportsTools: verified ? Number(row.verified_supports_tools) === 1 : Number(row.supports_tools) === 1,
		reasoningEfforts: verified ? jsonList(row.verified_reasoning_efforts) : jsonList(row.reasoning_efforts),
		availableContextWindows: jsonList(row.available_context_windows),
		availableModes: jsonList(row.available_modes),
		defaultReasoningEffort: textOrNull(row.default_reasoning_effort),
		supportsDisabledReasoning: Number(row.supports_disabled_reasoning) === 1,
		available: Number(row.available) === 1,
		lastSeenAt:
			row.last_seen_at === null || row.last_seen_at === undefined
				? null
				: new Date(Number(row.last_seen_at)).toISOString(),
		verifiedModelVersion: textOrNull(row.verified_model_version),
		verifiedSupportsImages: Number(row.verified_supports_images) === 1,
		verifiedSupportsTools: Number(row.verified_supports_tools) === 1,
		verifiedReasoningEfforts: jsonList(row.verified_reasoning_efforts),
		verifiedAt: iso(row.verified_at),
		verificationSource: textOrNull(row.verification_source),
		verificationStatus: textOrNull(row.verification_status) ?? "UNVERIFIED",
		verificationInvalidatedAt: iso(row.verification_invalidated_at),
	};
}

function pingBody(account: Account, ok: boolean, latencyMs: number, message: string): Record<string, unknown> {
	return {
		accountId: account.id,
		accountName: account.name,
		ok,
		latencyMs,
		message,
		occurredAt: new Date().toISOString(),
	};
}

function textOrNull(value: unknown): string | null {
	return value === null || value === undefined || value === "" ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function boolOrNull(value: boolean | null | undefined): number | null {
	return value === undefined || value === null ? null : value ? 1 : 0;
}

function jsonList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item));
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
	} catch {
		return [];
	}
}

function iso(value: unknown): string | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	return new Date(Number(value)).toISOString();
}
