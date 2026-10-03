import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type {
	NewsAnalysis,
	NewsConfiguration,
	NewsEvaluation,
	NewsItem,
	NewsJob,
	NewsMaterial,
	NewsReceipt,
	NewsReport,
	NewsSource,
	NewsSourceInput,
	NewsStory,
	NewsUsage,
} from "./types.ts";

export function newsHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface StoredNewsJob extends NewsJob {
	data: Record<string, unknown>;
}
export interface StoredNewsReceipt extends NewsReceipt {
	logicalKey: string;
	response: unknown;
}
export class NewsBudgetError extends Error {}
export class NewsUnknownReceiptError extends Error {
	receiptId: string;
	constructor(id: string) {
		super(`调用结果未知，请先核对回执再手动重试：${id}`);
		this.receiptId = id;
	}
}

const EMPTY_ANALYSIS: NewsAnalysis = {
	relevance: "unknown",
	scores: [],
	score: null,
	selectionCandidate: false,
	title: "",
	summary: "",
	reason: "",
	category: "other",
	tags: [],
	entities: [],
	contentKind: "unknown",
	fact: null,
};

/** A local, durable content ledger. Mutations and their next jobs share a transaction. */
export class NewsStore {
	readonly path: string;
	private db: DatabaseSync;
	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path, { timeout: 5000 });
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
			CREATE TABLE IF NOT EXISTS news_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS news_sources(id TEXT PRIMARY KEY,data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS news_items(id TEXT PRIMARY KEY,identity_key TEXT NOT NULL UNIQUE,
			 source_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,material TEXT NOT NULL,
			 data TEXT NOT NULL,manual TEXT NOT NULL DEFAULT '{}');
			CREATE TABLE IF NOT EXISTS news_revisions(item_id TEXT NOT NULL,revision INTEGER NOT NULL,
			 data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(item_id,revision));
			CREATE TABLE IF NOT EXISTS news_stories(id TEXT PRIMARY KEY,data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS news_reports(id TEXT PRIMARY KEY,kind TEXT NOT NULL,period_key TEXT NOT NULL,
			 data TEXT NOT NULL,UNIQUE(kind,period_key));
			CREATE TABLE IF NOT EXISTS news_jobs(id TEXT PRIMARY KEY,dedupe TEXT NOT NULL UNIQUE,
			 status TEXT NOT NULL,next_at TEXT NOT NULL,data TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS news_jobs_due ON news_jobs(status,next_at);
			CREATE TABLE IF NOT EXISTS news_receipts(id TEXT PRIMARY KEY,logical_key TEXT NOT NULL UNIQUE,
			 status TEXT NOT NULL,data TEXT NOT NULL,response TEXT);
			CREATE TABLE IF NOT EXISTS news_attempts(id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,
			 started_at INTEGER NOT NULL,status TEXT NOT NULL,error TEXT);
			CREATE INDEX IF NOT EXISTS news_attempts_time ON news_attempts(started_at);
			CREATE TABLE IF NOT EXISTS news_evaluations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS news_audit(id INTEGER PRIMARY KEY,action TEXT NOT NULL,subject TEXT NOT NULL,
			 data TEXT NOT NULL,created_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS news_vectors(item_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,model TEXT NOT NULL,data TEXT NOT NULL);
			PRAGMA user_version=1;`);
	}
	close(): void {
		this.db.close();
	}
	transaction<T>(fn: () => T): T {
		if (this.db.isTransaction) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	getMeta<T>(key: string): T | null {
		const row = this.db.prepare("SELECT value FROM news_meta WHERE key=?").get(key);
		return row ? (JSON.parse(String(row.value)) as T) : null;
	}
	setMeta(key: string, value: unknown): void {
		this.db
			.prepare("INSERT INTO news_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
			.run(key, JSON.stringify(value));
	}
	audit(action: string, subject: string, data: unknown): void {
		this.db
			.prepare("INSERT INTO news_audit(action,subject,data,created_at) VALUES(?,?,?,?)")
			.run(action, subject, JSON.stringify(data), new Date().toISOString());
	}
	acquireLease(owner: string, now = Date.now()): boolean {
		return this.transaction(() => {
			const old = this.getMeta<{ owner: string; until: number }>("worker-lease");
			if (old && old.owner !== owner && old.until > now) return false;
			this.setMeta("worker-lease", { owner, until: now + 30000 });
			return true;
		});
	}
	releaseLease(owner: string): void {
		if (this.getMeta<{ owner: string }>("worker-lease")?.owner === owner)
			this.setMeta("worker-lease", { owner, until: 0 });
	}
	configuration(defaults: NewsConfiguration): NewsConfiguration {
		return this.getMeta<NewsConfiguration>("configuration") ?? structuredClone(defaults);
	}
	setConfiguration(configuration: NewsConfiguration): void {
		this.setMeta("configuration", configuration);
	}
	sources(): NewsSource[] {
		return this.db
			.prepare("SELECT data FROM news_sources")
			.all()
			.map((row) => JSON.parse(String(row.data)) as NewsSource);
	}
	source(id: string): NewsSource | null {
		const row = this.db.prepare("SELECT data FROM news_sources WHERE id=?").get(id);
		return row ? (JSON.parse(String(row.data)) as NewsSource) : null;
	}
	saveSource(input: NewsSourceInput): NewsSource {
		const old = this.source(input.id);
		const now = new Date().toISOString();
		const source: NewsSource = {
			...input,
			lastCollectedAt: old?.lastCollectedAt ?? null,
			nextCollectedAt: old?.nextCollectedAt ?? null,
			lastError: old?.lastError ?? null,
			createdAt: old?.createdAt ?? now,
			updatedAt: now,
		};
		this.writeSource(source);
		this.audit("source.save", source.id, source);
		return source;
	}
	writeSource(source: NewsSource): void {
		this.db
			.prepare("INSERT INTO news_sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
			.run(source.id, JSON.stringify(source));
	}
	deleteSource(id: string): void {
		this.db.prepare("DELETE FROM news_sources WHERE id=?").run(id);
		this.audit("source.delete", id, {});
	}
	items(): NewsItem[] {
		return this.db
			.prepare("SELECT data FROM news_items")
			.all()
			.map((row) => JSON.parse(String(row.data)) as NewsItem);
	}
	item(id: string): NewsItem | null {
		const row = this.db.prepare("SELECT data FROM news_items WHERE id=?").get(id);
		return row ? (JSON.parse(String(row.data)) as NewsItem) : null;
	}
	material(id: string): NewsMaterial | null {
		const row = this.db.prepare("SELECT material FROM news_items WHERE id=?").get(id);
		return row ? (JSON.parse(String(row.material)) as NewsMaterial) : null;
	}
	manual(id: string): Record<string, unknown> {
		const row = this.db.prepare("SELECT manual FROM news_items WHERE id=?").get(id);
		return row ? (JSON.parse(String(row.manual)) as Record<string, unknown>) : {};
	}
	writeItem(item: NewsItem): void {
		this.db.prepare("UPDATE news_items SET data=? WHERE id=?").run(JSON.stringify(item), item.id);
	}
	/** Source identity distinguishes independent publishers; URL tracking never creates another revision. */
	ingest(source: NewsSource, input: NewsMaterial): { item: NewsItem; changed: boolean } {
		return this.transaction(() => {
			const material = {
				...input,
				url: canonicalNewsUrl(input.url),
				title: input.title.trim(),
				body: input.body?.trim(),
			};
			const identity = newsHash([source.id, material.externalId || material.url]);
			const fingerprint = newsHash([
				material.title,
				material.body ?? null,
				material.publishedAt ?? null,
				material.author ?? null,
			]);
			const oldRow = this.db.prepare("SELECT data,fingerprint FROM news_items WHERE identity_key=?").get(identity);
			const old = oldRow ? (JSON.parse(String(oldRow.data)) as NewsItem) : null;
			if (old && oldRow?.fingerprint === fingerprint) return { item: old, changed: false };
			const now = new Date().toISOString();
			const revision = (old?.revision ?? 0) + 1;
			const parsedPublished = material.publishedAt ? Date.parse(material.publishedAt) : Number.NaN;
			const publishedAt = Number.isFinite(parsedPublished)
				? new Date(parsedPublished).toISOString()
				: (old?.publishedAt ?? now);
			const backfill = old?.backfill ?? material.backfill ?? Date.now() - Date.parse(publishedAt) > 7 * 86400000;
			const item: NewsItem = {
				...EMPTY_ANALYSIS,
				id: old?.id ?? randomUUID(),
				sourceId: source.id,
				sourceName: source.name,
				sourceKind: source.kind,
				sourceTier: source.tier,
				participantId: source.publisherGroup || source.owner || source.id,
				participation: source.participation,
				originalTitle: material.title,
				title: material.title,
				url: material.url,
				body: null,
				originalBody: material.body || null,
				author: material.author ?? null,
				publishedAt,
				discoveredAt: old?.discoveredAt ?? now,
				updatedAt: now,
				timelineAt: old?.timelineAt ?? publishedAt,
				revision,
				status: "pending",
				selected: false,
				novel: false,
				storyId: old?.storyId ?? null,
				fulltextAllowed: source.siteFulltext,
				backfill,
				saved: old?.saved ?? false,
				read: old?.read ?? false,
				withdrawn: old?.withdrawn ?? false,
				error: null,
			};
			this.db
				.prepare(`INSERT INTO news_items(id,identity_key,source_id,revision,fingerprint,material,data) VALUES(?,?,?,?,?,?,?)
				ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,material=excluded.material,data=excluded.data`)
				.run(item.id, identity, source.id, revision, fingerprint, JSON.stringify(material), JSON.stringify(item));
			this.db
				.prepare("INSERT INTO news_revisions VALUES(?,?,?,?)")
				.run(item.id, revision, JSON.stringify(material), now);
			this.enqueue("analyze", item.id, { revision }, `analyze:${item.id}:${revision}`);
			return { item, changed: true };
		});
	}
	commitAnalysis(id: string, revision: number, analysis: NewsAnalysis): NewsItem | null {
		const item = this.item(id);
		if (!item || item.revision !== revision) return null;
		const manual = this.manual(id);
		const updated: NewsItem = {
			...item,
			...analysis,
			status: analysis.relevance === "block" ? "blocked" : "ready",
			body: item.fulltextAllowed ? item.originalBody : null,
			updatedAt: new Date().toISOString(),
			error: null,
			...(manual.fields as Partial<NewsItem> | undefined),
		};
		updated.selected = updated.selectionCandidate && updated.participation === "editorial" && !updated.withdrawn;
		if (manual.fields && typeof manual.fields === "object" && "selected" in manual.fields)
			updated.selected = !!(manual.fields as Record<string, unknown>).selected;
		if (updated.relevance === "block" || updated.participation !== "editorial") updated.selected = false;
		this.writeItem(updated);
		return updated;
	}
	editItem(id: string, patch: Partial<NewsItem>, lockFields = false): NewsItem {
		const item = this.item(id);
		if (!item) throw new Error("资讯不存在");
		return this.transaction(() => {
			if (lockFields) {
				const manual = this.manual(id);
				manual.fields = { ...(manual.fields as Record<string, unknown> | undefined), ...patch };
				this.db.prepare("UPDATE news_items SET manual=? WHERE id=?").run(JSON.stringify(manual), id);
			}
			const updated = { ...item, ...patch, updatedAt: new Date().toISOString() };
			if (updated.withdrawn || updated.relevance === "block" || updated.participation !== "editorial")
				updated.selected = false;
			this.writeItem(updated);
			this.audit("item.edit", id, patch);
			return updated;
		});
	}
	moveItem(id: string, storyId: string | null, manual = false): NewsItem {
		return this.transaction(() => {
			if (storyId && !this.story(storyId)) throw new Error("事件不存在");
			if (manual) {
				const lock = this.manual(id);
				lock.storyId = storyId;
				lock.groupLocked = true;
				this.db.prepare("UPDATE news_items SET manual=? WHERE id=?").run(JSON.stringify(lock), id);
			}
			return this.editItem(id, { storyId });
		});
	}
	stories(): NewsStory[] {
		const items = this.items();
		return this.db
			.prepare("SELECT data FROM news_stories")
			.all()
			.map((row) => {
				const story = JSON.parse(String(row.data)) as NewsStory;
				const reports = items.filter(
					(item) =>
						item.storyId === story.id &&
						!item.withdrawn &&
						item.status === "ready" &&
						item.participation !== "isolated" &&
						item.relevance !== "block",
				);
				return { ...story, reports, sourceCount: new Set(reports.map((item) => item.participantId)).size };
			});
	}
	story(id: string): NewsStory | null {
		return this.stories().find((story) => story.id === id) ?? null;
	}
	saveStory(story: NewsStory): void {
		this.db
			.prepare("INSERT INTO news_stories VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
			.run(story.id, JSON.stringify({ ...story, reports: [] }));
	}
	reports(): NewsReport[] {
		return this.db
			.prepare("SELECT data FROM news_reports ORDER BY period_key DESC")
			.all()
			.map((row) => JSON.parse(String(row.data)) as NewsReport);
	}
	saveReport(report: NewsReport): void {
		this.db
			.prepare(
				`INSERT INTO news_reports VALUES(?,?,?,?) ON CONFLICT(kind,period_key) DO UPDATE SET data=excluded.data`,
			)
			.run(report.id, report.kind, report.key, JSON.stringify(report));
	}
	enqueue(
		kind: string,
		subject: string,
		data: Record<string, unknown> = {},
		dedupe = `${kind}:${subject}`,
	): StoredNewsJob {
		const existing = this.db.prepare("SELECT data FROM news_jobs WHERE dedupe=?").get(dedupe);
		if (existing) return JSON.parse(String(existing.data)) as StoredNewsJob;
		const now = new Date().toISOString();
		const job: StoredNewsJob = {
			id: randomUUID(),
			kind,
			subject,
			data,
			status: "pending",
			attempts: 0,
			createdAt: now,
			updatedAt: now,
			nextAttemptAt: now,
			error: null,
		};
		this.db
			.prepare("INSERT INTO news_jobs VALUES(?,?,?,?,?)")
			.run(job.id, dedupe, job.status, now, JSON.stringify(job));
		return job;
	}
	jobs(limit = 200): StoredNewsJob[] {
		return this.db
			.prepare("SELECT data FROM news_jobs ORDER BY next_at DESC LIMIT ?")
			.all(limit)
			.map((row) => JSON.parse(String(row.data)) as StoredNewsJob);
	}
	job(id: string): StoredNewsJob | null {
		const row = this.db.prepare("SELECT data FROM news_jobs WHERE id=?").get(id);
		return row ? (JSON.parse(String(row.data)) as StoredNewsJob) : null;
	}
	updateJob(job: StoredNewsJob): void {
		this.db
			.prepare("UPDATE news_jobs SET status=?,next_at=?,data=? WHERE id=?")
			.run(job.status, job.nextAttemptAt, JSON.stringify(job), job.id);
	}
	claimJob(allowed: (job: StoredNewsJob) => boolean, now = Date.now()): StoredNewsJob | null {
		return this.transaction(() => {
			const rows = this.db
				.prepare("SELECT data FROM news_jobs WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 500")
				.all(new Date(now).toISOString());
			for (const row of rows) {
				const job = JSON.parse(String(row.data)) as StoredNewsJob;
				if (!allowed(job)) continue;
				job.status = "running";
				job.attempts++;
				job.updatedAt = new Date(now).toISOString();
				this.updateJob(job);
				return job;
			}
			return null;
		});
	}
	recover(): void {
		this.transaction(() => {
			for (const row of this.db.prepare("SELECT data FROM news_jobs WHERE status='running'").all()) {
				const job = JSON.parse(String(row.data)) as StoredNewsJob;
				job.status = "pending";
				job.nextAttemptAt = new Date().toISOString();
				this.updateJob(job);
			}
			for (const row of this.db.prepare("SELECT id FROM news_receipts WHERE status='pending'").all())
				this.setReceiptState(String(row.id), "unknown", "上次进程中断，结果需要核对");
			for (const item of this.items())
				if (item.status === "processing") this.editItem(item.id, { status: "pending" });
		});
	}
	receipts(limit = 200): NewsReceipt[] {
		return this.db
			.prepare("SELECT data FROM news_receipts ORDER BY rowid DESC LIMIT ?")
			.all(limit)
			.map((row) => JSON.parse(String(row.data)) as NewsReceipt);
	}
	receipt(id: string): StoredNewsReceipt | null {
		const row = this.db.prepare("SELECT logical_key,data,response FROM news_receipts WHERE id=?").get(id);
		return row
			? {
					...(JSON.parse(String(row.data)) as NewsReceipt),
					logicalKey: String(row.logical_key),
					response: row.response ? (JSON.parse(String(row.response)) as unknown) : null,
				}
			: null;
	}
	beginReceipt(
		logicalKey: string,
		capability: string,
		subject: string,
		model: string,
		budget: NewsConfiguration["budget"],
	): { receipt: StoredNewsReceipt; cached: boolean } {
		return this.transaction(() => {
			const found = this.db.prepare("SELECT id FROM news_receipts WHERE logical_key=?").get(logicalKey);
			const old = found ? this.receipt(String(found.id)) : null;
			if (old && (old.status === "received" || old.status === "completed")) return { receipt: old, cached: true };
			if (old && (old.status === "pending" || old.status === "unknown")) throw new NewsUnknownReceiptError(old.id);
			const now = Date.now();
			for (const [span, maximum] of [
				[60000, budget.perMinute],
				[3600000, budget.perHour],
				[86400000, budget.perDay],
			]) {
				const row = this.db.prepare("SELECT count(*) AS n FROM news_attempts WHERE started_at>?").get(now - span);
				if (Number(row?.n ?? 0) >= maximum!) throw new NewsBudgetError("资讯调用额度已用完，稍后再试");
			}
			const stamp = new Date(now).toISOString();
			const receipt: StoredNewsReceipt = {
				id: old?.id ?? randomUUID(),
				logicalKey,
				response: null,
				capability,
				subject,
				model,
				status: "pending",
				createdAt: old?.createdAt ?? stamp,
				updatedAt: stamp,
				attempts: (old?.attempts ?? 0) + 1,
				usage: null,
				error: null,
			};
			const { logicalKey: _key, response: _response, ...publicData } = receipt;
			this.db
				.prepare(
					`INSERT INTO news_receipts VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,response=NULL`,
				)
				.run(receipt.id, logicalKey, receipt.status, JSON.stringify(publicData));
			this.db.prepare("INSERT INTO news_attempts VALUES(?,?,?,'pending',NULL)").run(randomUUID(), receipt.id, now);
			return { receipt, cached: false };
		});
	}
	receiveReceipt(id: string, response: unknown, usage: NewsUsage | null = null): void {
		this.transaction(() => {
			const old = this.receipt(id);
			if (!old) throw new Error("回执不存在");
			const { logicalKey: _key, response: _response, ...data } = old;
			this.db
				.prepare("UPDATE news_receipts SET status='received',data=?,response=? WHERE id=?")
				.run(
					JSON.stringify({ ...data, status: "received", usage, error: null, updatedAt: new Date().toISOString() }),
					JSON.stringify(response),
					id,
				);
			this.db.prepare("UPDATE news_attempts SET status='received' WHERE receipt_id=? AND status='pending'").run(id);
		});
	}
	setReceiptState(id: string, status: NewsReceipt["status"], error: string | null = null): void {
		const old = this.receipt(id);
		if (!old) throw new Error("回执不存在");
		const { logicalKey: _key, response: _response, ...data } = old;
		this.db
			.prepare("UPDATE news_receipts SET status=?,data=? WHERE id=?")
			.run(status, JSON.stringify({ ...data, status, error, updatedAt: new Date().toISOString() }), id);
		this.db
			.prepare("UPDATE news_attempts SET status=?,error=? WHERE receipt_id=? AND status='pending'")
			.run(status, error, id);
	}
	completeReceipts(subject: string): void {
		for (const row of this.db.prepare("SELECT id,data FROM news_receipts WHERE status='received'").all()) {
			if ((JSON.parse(String(row.data)) as NewsReceipt).subject === subject)
				this.setReceiptState(String(row.id), "completed");
		}
	}
	saveEvaluation(evaluation: NewsEvaluation): void {
		this.db
			.prepare("INSERT OR REPLACE INTO news_evaluations VALUES(?,?)")
			.run(evaluation.id, JSON.stringify(evaluation));
	}
	evaluations(): NewsEvaluation[] {
		return this.db
			.prepare("SELECT data FROM news_evaluations ORDER BY rowid DESC LIMIT 100")
			.all()
			.map((row) => JSON.parse(String(row.data)) as NewsEvaluation);
	}
	vector(item: NewsItem, model: string): number[] | null {
		const row = this.db
			.prepare("SELECT data FROM news_vectors WHERE item_id=? AND revision=? AND model=?")
			.get(item.id, item.revision, model);
		return row ? (JSON.parse(String(row.data)) as number[]) : null;
	}
	saveVector(item: NewsItem, model: string, vector: number[]): void {
		this.db
			.prepare(
				"INSERT INTO news_vectors VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision,model=excluded.model,data=excluded.data",
			)
			.run(item.id, item.revision, model, JSON.stringify(vector));
	}
	async backup(path: string): Promise<void> {
		mkdirSync(dirname(path), { recursive: true });
		await backup(this.db, path);
	}
	retain(before: string): number {
		let removed = 0;
		for (const item of this.items())
			if (
				!item.saved &&
				!item.selected &&
				item.discoveredAt < before &&
				(item.status === "ready" || item.status === "blocked")
			) {
				this.db.prepare("DELETE FROM news_items WHERE id=?").run(item.id);
				removed++;
			}
		return removed;
	}
}

export function canonicalNewsUrl(value: string): string {
	const url = new URL(value);
	if (!/^https?:$/.test(url.protocol) || url.username || url.password)
		throw new Error("资讯地址必须是无凭据的 HTTP(S) 链接");
	url.hash = "";
	for (const key of [...url.searchParams.keys()])
		if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
	url.searchParams.sort();
	return url.toString();
}
