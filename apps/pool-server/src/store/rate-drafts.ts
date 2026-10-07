/**
 * 模型单价草稿 —— 移植自 manager `ModelRateDraftService`。
 * 草稿可记美元原价；应用到正式单价时按 7.20 折成人民币，正式表只存人民币。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BusinessError, type ModelRate } from "owl-pool";
import type { SqliteBillingStore } from "./billing-store.ts";
import type { SqliteCatalogStore } from "./gateway-stores.ts";

const USD_TO_CNY = "7.20";

interface DraftRow {
	id: string;
	model: string;
	platform: string | null;
	promptPer1m: string | null;
	completionPer1m: string | null;
	cacheReadPer1m: string | null;
	cacheWritePer1m: string | null;
	currency: string;
	sourceUrl: string | null;
	checkedDate: string | null;
	status: string;
	appliedRateId: string | null;
	remark: string | null;
	updatedAt: number;
}

export function listRateDrafts(db: DatabaseSync, platform: string | null): Record<string, unknown> {
	const all = loadAll(db);
	const wanted = blank(platform);
	const drafts = all.filter((draft) => wanted === null || draft.platform === wanted).map(draftView);
	const platforms = [
		...new Set(all.map((draft) => draft.platform).filter((value): value is string => value !== null)),
	].sort();
	return { drafts, platforms, totalCount: all.length };
}

export function seedRateDrafts(db: DatabaseSync, catalog: SqliteCatalogStore): Record<string, unknown> {
	const models = catalog.listModels();
	let created = 0;
	for (const model of models) {
		const name = model.publicId.trim().toLowerCase();
		if (name.length === 0 || findByModel(db, name) !== undefined) {
			continue;
		}
		insert(db, { ...emptyDraft(name), id: randomUUID(), updatedAt: Date.now() });
		created += 1;
	}
	return { created, catalogTotal: models.length, draftTotal: loadAll(db).length };
}

export function upsertRateDraft(db: DatabaseSync, body: Record<string, unknown>): Record<string, unknown> {
	const model = String(body.model ?? "")
		.trim()
		.toLowerCase();
	if (model.length === 0) {
		throw BusinessError.of("billing.draft.modelNameRequired", "模型名不能为空");
	}
	const existing = findByModel(db, model);
	const draft = applyFields(existing ?? emptyDraft(model), body);
	if (existing === undefined) {
		draft.id = randomUUID();
		insert(db, draft);
	} else {
		save(db, draft);
	}
	return draftView(draft);
}

export function updateRateDraft(db: DatabaseSync, id: string, body: Record<string, unknown>): Record<string, unknown> {
	const existing = findById(db, id);
	if (existing === undefined) {
		throw BusinessError.of("billing.draft.notFound", "单价草稿不存在");
	}
	const draft = applyFields(existing, body);
	save(db, draft);
	return draftView(draft);
}

export function applyRateDraft(db: DatabaseSync, store: SqliteBillingStore, id: string): Record<string, unknown> {
	const draft = findById(db, id);
	if (draft === undefined) {
		throw BusinessError.of("billing.draft.notFound", "单价草稿不存在");
	}
	if (draft.promptPer1m === null || draft.completionPer1m === null) {
		throw BusinessError.of("billing.draft.incomplete", "草稿输入/输出单价尚未核对完整，不能应用");
	}
	const currency = draft.currency.toUpperCase();
	if (currency !== "CNY" && currency !== "USD") {
		throw BusinessError.of(
			"billing.draft.currencyUnsupported",
			"仅支持 CNY 与 USD 单价草稿，其他币种请先手工换算为人民币",
		);
	}
	const usd = currency === "USD";
	const rate: ModelRate = {
		model: draft.model,
		promptPer1m: yuanToCents(usd ? toCny(draft.promptPer1m) : draft.promptPer1m),
		completionPer1m: yuanToCents(usd ? toCny(draft.completionPer1m) : draft.completionPer1m),
		cacheReadPer1m: yuanToCents(usd ? toCny(draft.cacheReadPer1m) : draft.cacheReadPer1m),
		cacheWritePer1m: yuanToCents(usd ? toCny(draft.cacheWritePer1m) : draft.cacheWritePer1m),
		enabled: true,
	};
	store.saveRate(rate);
	draft.status = "APPLIED";
	draft.appliedRateId = draft.model;
	draft.remark = usd ? conversionRemark(draft.remark) : draft.remark;
	draft.updatedAt = Date.now();
	save(db, draft);
	return {
		id: rate.model,
		model: rate.model,
		promptPer1m: centsToYuan(rate.promptPer1m),
		completionPer1m: centsToYuan(rate.completionPer1m),
		cacheReadPer1m: centsToYuan(rate.cacheReadPer1m),
		cacheWritePer1m: centsToYuan(rate.cacheWritePer1m),
		enabled: true,
		currency: "CNY",
	};
}

export function deleteRateDraft(db: DatabaseSync, id: string): void {
	if (findById(db, id) === undefined) {
		throw BusinessError.of("billing.draft.notFound", "单价草稿不存在");
	}
	db.prepare("DELETE FROM billing_rate_drafts WHERE id = ?").run(id);
}

function applyFields(draft: DraftRow, body: Record<string, unknown>): DraftRow {
	const platform = blank(body.platform);
	if (platform !== null && platform.length > 64) {
		throw BusinessError.of("billing.draft.platformTooLong", "平台名过长");
	}
	const currency = blank(body.currency)?.toUpperCase() ?? "CNY";
	if (currency.length > 8) {
		throw BusinessError.of("billing.draft.currencyInvalid", "币种代码不合法");
	}
	const next: DraftRow = {
		...draft,
		platform,
		promptPer1m: rateOrNull(body.promptPer1m, "输入"),
		completionPer1m: rateOrNull(body.completionPer1m, "输出"),
		cacheReadPer1m: rateOrNull(body.cacheReadPer1m, "缓存读取"),
		cacheWritePer1m: rateOrNull(body.cacheWritePer1m, "缓存写入"),
		currency,
		sourceUrl: blank(body.sourceUrl),
		checkedDate: blank(body.checkedDate),
		remark: blank(body.remark),
		updatedAt: Date.now(),
	};
	if (draft.status === "APPLIED") {
		next.status = "DRAFT";
		next.appliedRateId = null;
	}
	return next;
}

function draftView(draft: DraftRow): Record<string, unknown> {
	const preview =
		draft.currency.toUpperCase() === "USD"
			? {
					rate: USD_TO_CNY,
					promptPer1m: toCny(draft.promptPer1m),
					completionPer1m: toCny(draft.completionPer1m),
					cacheReadPer1m: toCny(draft.cacheReadPer1m),
					cacheWritePer1m: toCny(draft.cacheWritePer1m),
				}
			: null;
	return {
		id: draft.id,
		model: draft.model,
		platform: draft.platform,
		promptPer1m: draft.promptPer1m,
		completionPer1m: draft.completionPer1m,
		cacheReadPer1m: draft.cacheReadPer1m,
		cacheWritePer1m: draft.cacheWritePer1m,
		currency: draft.currency,
		cnyPreview: preview,
		sourceUrl: draft.sourceUrl,
		checkedDate: draft.checkedDate,
		status: draft.status,
		appliedRateId: draft.appliedRateId,
		remark: draft.remark,
		updatedAt: new Date(draft.updatedAt).toISOString(),
	};
}

function emptyDraft(model: string): DraftRow {
	return {
		id: "",
		model,
		platform: null,
		promptPer1m: null,
		completionPer1m: null,
		cacheReadPer1m: null,
		cacheWritePer1m: null,
		currency: "CNY",
		sourceUrl: null,
		checkedDate: null,
		status: "DRAFT",
		appliedRateId: null,
		remark: null,
		updatedAt: Date.now(),
	};
}

function loadAll(db: DatabaseSync): DraftRow[] {
	return (db.prepare("SELECT * FROM billing_rate_drafts ORDER BY model").all() as Array<Record<string, unknown>>).map(
		rowOf,
	);
}

function findById(db: DatabaseSync, id: string): DraftRow | undefined {
	const row = db.prepare("SELECT * FROM billing_rate_drafts WHERE id = ?").get(id) as
		| Record<string, unknown>
		| undefined;
	return row === undefined ? undefined : rowOf(row);
}

function findByModel(db: DatabaseSync, model: string): DraftRow | undefined {
	const row = db.prepare("SELECT * FROM billing_rate_drafts WHERE model = ?").get(model) as
		| Record<string, unknown>
		| undefined;
	return row === undefined ? undefined : rowOf(row);
}

function insert(db: DatabaseSync, draft: DraftRow): void {
	db.prepare(`
		INSERT INTO billing_rate_drafts (
			id, model, platform, prompt_per_1m, completion_per_1m, cache_read_per_1m, cache_write_per_1m,
			currency, source_url, checked_date, status, applied_rate_id, remark, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		draft.id,
		draft.model,
		draft.platform,
		draft.promptPer1m,
		draft.completionPer1m,
		draft.cacheReadPer1m,
		draft.cacheWritePer1m,
		draft.currency,
		draft.sourceUrl,
		draft.checkedDate,
		draft.status,
		draft.appliedRateId,
		draft.remark,
		draft.updatedAt,
	);
}

function save(db: DatabaseSync, draft: DraftRow): void {
	db.prepare(`
		UPDATE billing_rate_drafts SET
			platform = ?, prompt_per_1m = ?, completion_per_1m = ?, cache_read_per_1m = ?, cache_write_per_1m = ?,
			currency = ?, source_url = ?, checked_date = ?, status = ?, applied_rate_id = ?, remark = ?, updated_at = ?
		WHERE id = ?
	`).run(
		draft.platform,
		draft.promptPer1m,
		draft.completionPer1m,
		draft.cacheReadPer1m,
		draft.cacheWritePer1m,
		draft.currency,
		draft.sourceUrl,
		draft.checkedDate,
		draft.status,
		draft.appliedRateId,
		draft.remark,
		draft.updatedAt,
		draft.id,
	);
}

function rowOf(row: Record<string, unknown>): DraftRow {
	return {
		id: String(row.id),
		model: String(row.model),
		platform: text(row.platform),
		promptPer1m: text(row.prompt_per_1m),
		completionPer1m: text(row.completion_per_1m),
		cacheReadPer1m: text(row.cache_read_per_1m),
		cacheWritePer1m: text(row.cache_write_per_1m),
		currency: text(row.currency) ?? "CNY",
		sourceUrl: text(row.source_url),
		checkedDate: text(row.checked_date),
		status: text(row.status) ?? "DRAFT",
		appliedRateId: text(row.applied_rate_id),
		remark: text(row.remark),
		updatedAt: Number(row.updated_at),
	};
}

function rateOrNull(value: unknown, label: string): string | null {
	const textValue = blank(value);
	if (textValue === null) {
		return null;
	}
	if (!/^\d+(?:\.\d{1,6})?$/.test(textValue)) {
		throw BusinessError.of("billing.draft.rateInvalid", `${label}单价不能为负，最多 6 位小数`);
	}
	return textValue;
}

function toCny(usd: string | null): string | null {
	if (usd === null) {
		return null;
	}
	const [whole, frac = ""] = usd.split(".");
	const scaled = Number(`${whole}${frac.padEnd(6, "0").slice(0, 6)}`);
	const rate = 720;
	const product = Math.round((scaled * rate) / 1_000_000);
	return `${Math.trunc(product / 100)}.${String(product % 100).padStart(2, "0")}`;
}

function yuanToCents(value: string | null): number {
	if (value === null) {
		return 0;
	}
	const [whole, frac = ""] = value.split(".");
	return Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
}

function centsToYuan(cents: number): string {
	return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function conversionRemark(original: string | null): string {
	const tag = `USD×${USD_TO_CNY}→CNY`;
	const base = original?.trim() ?? "";
	if (base.includes(tag)) {
		return base;
	}
	return base.length === 0 ? `按汇率 ${tag} 折算` : `${base}；按汇率 ${tag} 折算`;
}

function blank(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const textValue = value.trim();
	return textValue.length === 0 ? null : textValue;
}

function text(value: unknown): string | null {
	return value === null || value === undefined || value === "" ? null : String(value);
}
