import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync, backupCorruptFile, withFileLockSync } from "../../utils/atomic-file.ts";

export const EXECUTION_ANOMALY_MAX_RECORDS = 2_000;
const MAX_SUMMARY = 600;
const MAX_DETAILS = 8_000;
const MAX_REPORT_TEXT = 4_000;
const MAX_IDENTITY = 256;
const MAX_PATH = 2_048;

export type ExecutionAnomalyKind = "tool_error" | "model_error";
export type ExecutionAnomalyStatus = "pending" | "reported";
export type ExecutionAnomalyOutcome = "resolved" | "unresolved" | "ignored";
export type ExecutionAnomalyProcessingKind = "optimized" | "dismissed";

export interface ExecutionAnomalyProcessing {
	kind: ExecutionAnomalyProcessingKind;
	note: string;
	verification: string;
	processedAt: number;
}

export interface ExecutionAnomalyProcessInput {
	id: string;
	kind: ExecutionAnomalyProcessingKind;
	note: string;
	verification: string;
}

export interface ExecutionAnomalyInput {
	sessionId: string;
	sessionName?: string;
	sessionFile?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	toolCallId?: string;
	toolName?: string;
	kind: ExecutionAnomalyKind;
	summary: string;
	details?: string;
	timestamp?: number;
}

export interface ExecutionAnomalyReportInput {
	id: string;
	cause: string;
	action: string;
	outcome: ExecutionAnomalyOutcome;
}

export interface ExecutionAnomalyReport {
	cause: string;
	action: string;
	outcome: ExecutionAnomalyOutcome;
	reportedAt: number;
}

/** Observed failure evidence is immutable; a model's analysis is stored separately in report. */
export interface ExecutionAnomalyRecord extends Omit<ExecutionAnomalyInput, "timestamp"> {
	id: string;
	createdAt: number;
	updatedAt: number;
	status: ExecutionAnomalyStatus;
	report?: ExecutionAnomalyReport;
	/** A user processing marker; observed evidence and the model report remain unchanged. */
	processing?: ExecutionAnomalyProcessing;
}

export interface ExecutionAnomalyListInput {
	query?: string;
	status?: ExecutionAnomalyStatus;
	sessionId?: string;
	/** Omitted means active; processed entries remain available with explicit filters and get(). */
	processing?: "active" | ExecutionAnomalyProcessingKind | "all";
	limit?: number;
	offset?: number;
}

export interface ExecutionAnomalyListResult {
	records: ExecutionAnomalyRecord[];
	total: number;
}

export interface ExecutionAnomalyStoreOptions {
	now?: () => number;
	maxRecords?: number;
	onChange?: () => void;
}

interface StoreFile {
	version: 1;
	records: ExecutionAnomalyRecord[];
}

/** Matches research diagnosis redaction before bounded excerpts leave the transcript. */
function excerpt(text: string, maxLength: number): string {
	return text
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[redacted authorization]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted key]")
		.replace(
			/\b(api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|authorization|cookie)["']?\s*([=:])\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n}]+)/gi,
			"$1$2[redacted]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.slice(0, maxLength);
}

function requiredText(value: string, name: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
	return excerpt(value.trim(), maxLength);
}

function optionalText(value: string | undefined, maxLength: number): string | undefined {
	return typeof value === "string" && value.trim() ? excerpt(value.trim(), maxLength) : undefined;
}

function identity(value: string, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_IDENTITY)
		throw new Error(`${name} 无效或超出长度限制`);
	return value;
}

function timestamp(value: number): number {
	if (!Number.isFinite(value) || value < 0) throw new Error("执行异常时间无效");
	return Math.floor(value);
}

function boundedInteger(value: number | undefined, fallback: number, max: number, minimum = 0): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(minimum, Math.floor(value)))
		: fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function validProcessing(value: unknown): value is ExecutionAnomalyProcessing {
	return (
		isObject(value) &&
		Object.keys(value).every((key) => ["kind", "note", "verification", "processedAt"].includes(key)) &&
		(value.kind === "optimized" || value.kind === "dismissed") &&
		["note", "verification"].every(
			(key) => typeof value[key] === "string" && !!value[key].trim() && value[key].length <= MAX_REPORT_TEXT,
		) &&
		typeof value.processedAt === "number" &&
		Number.isInteger(value.processedAt) &&
		value.processedAt >= 0
	);
}

function validRecord(value: unknown): value is ExecutionAnomalyRecord {
	if (!isObject(value)) return false;
	const optional = ["sessionName", "sessionFile", "cwd", "provider", "model", "toolCallId", "toolName", "details"];
	if (
		!["id", "sessionId", "summary"].every((key) => typeof value[key] === "string" && value[key].trim()) ||
		!optional.every((key) => value[key] === undefined || typeof value[key] === "string") ||
		!["tool_error", "model_error"].includes(String(value.kind)) ||
		!["pending", "reported"].includes(String(value.status)) ||
		![value.createdAt, value.updatedAt].every(
			(item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
		)
	)
		return false;
	if (value.status === "pending") return value.report === undefined;
	const report = value.report;
	return (
		isObject(report) &&
		typeof report.cause === "string" &&
		!!report.cause.trim() &&
		typeof report.action === "string" &&
		!!report.action.trim() &&
		["resolved", "unresolved", "ignored"].includes(String(report.outcome)) &&
		typeof report.reportedAt === "number" &&
		Number.isFinite(report.reportedAt) &&
		report.reportedAt >= 0
	);
}

function evidence(input: ExecutionAnomalyInput): Omit<ExecutionAnomalyInput, "timestamp"> {
	if (input.kind !== "tool_error" && input.kind !== "model_error") throw new Error("执行异常类型无效");
	return {
		sessionId: identity(input.sessionId, "会话 ID"),
		sessionName: optionalText(input.sessionName, MAX_IDENTITY),
		sessionFile: optionalText(input.sessionFile, MAX_PATH),
		cwd: optionalText(input.cwd, MAX_PATH),
		provider: optionalText(input.provider, MAX_IDENTITY),
		model: optionalText(input.model, MAX_IDENTITY),
		toolCallId: input.toolCallId === undefined ? undefined : identity(input.toolCallId, "工具调用 ID"),
		toolName: optionalText(input.toolName, MAX_IDENTITY),
		kind: input.kind,
		summary: requiredText(input.summary, "异常摘要", MAX_SUMMARY),
		details: optionalText(input.details, MAX_DETAILS),
	};
}

export class ExecutionAnomalyStore {
	private readonly path: string;
	private readonly now: () => number;
	private readonly maxRecords: number;
	private readonly onChange?: () => void;

	constructor(agentDir: string, options: ExecutionAnomalyStoreOptions = {}) {
		this.path = join(agentDir, "execution-anomalies.json");
		this.now = options.now ?? Date.now;
		this.maxRecords = boundedInteger(options.maxRecords, EXECUTION_ANOMALY_MAX_RECORDS, 10_000, 1);
		this.onChange = options.onChange;
	}

	/** Read under the same lock as writers, including corruption backup, to avoid moving a newer file. */
	private read(): StoreFile {
		if (!existsSync(this.path)) return { version: 1, records: [] };
		let result: StoreFile;
		let invalidProcessing = false;
		try {
			const value: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
			if (
				!isObject(value) ||
				value.version !== 1 ||
				!Array.isArray(value.records) ||
				!value.records.every(validRecord)
			)
				throw new Error("执行异常日志格式无效");
			invalidProcessing = value.records.some(
				(item) => item.processing !== undefined && !validProcessing(item.processing),
			);
			result = {
				version: 1,
				records: value.records.map((item) => ({
					...evidence(item),
					id: identity(item.id, "异常 ID"),
					createdAt: timestamp(item.createdAt),
					updatedAt: timestamp(item.updatedAt),
					status: item.status,
					...(item.report
						? {
								report: {
									cause: excerpt(item.report.cause, MAX_REPORT_TEXT),
									action: excerpt(item.report.action, MAX_REPORT_TEXT),
									outcome: item.report.outcome,
									reportedAt: timestamp(item.report.reportedAt),
								},
							}
						: {}),
					...(validProcessing(item.processing)
						? {
								processing: {
									kind: item.processing.kind,
									note: excerpt(item.processing.note, MAX_REPORT_TEXT),
									verification: excerpt(item.processing.verification, MAX_REPORT_TEXT),
									processedAt: item.processing.processedAt,
								},
							}
						: {}),
				})),
			};
		} catch {
			if (!backupCorruptFile(this.path)) throw new Error("执行异常日志损坏且无法备份");
			return { version: 1, records: [] };
		}
		if (invalidProcessing) {
			// Invalid new metadata must not discard valid historical evidence or analysis.
			// Back up the entire original before repairing just the malformed markers.
			if (!backupCorruptFile(this.path)) throw new Error("执行异常处理标记损坏且无法备份，原始日志未修改");
			atomicWriteFileSync(this.path, `${JSON.stringify(result)}\n`, { mode: 0o600 });
		}
		return result;
	}

	private write(store: StoreFile): void {
		store.records.sort((left, right) => right.createdAt - left.createdAt);
		store.records = store.records.slice(0, this.maxRecords);
		atomicWriteFileSync(this.path, `${JSON.stringify(store)}\n`, { mode: 0o600 });
	}

	private changed(): void {
		try {
			this.onChange?.();
		} catch {
			// A disconnected settings subscriber must not turn a persisted report into a tool failure.
		}
	}

	record(input: ExecutionAnomalyInput): ExecutionAnomalyRecord {
		const observed = evidence(input);
		const createdAt = timestamp(input.timestamp ?? this.now());
		let changed = false;
		const result = withFileLockSync(this.path, () => {
			const store = this.read();
			const existing = observed.toolCallId
				? store.records.find(
						(item) => item.sessionId === observed.sessionId && item.toolCallId === observed.toolCallId,
					)
				: undefined;
			if (existing) return existing;
			const item: ExecutionAnomalyRecord = {
				...observed,
				id: randomUUID(),
				createdAt,
				updatedAt: createdAt,
				status: "pending",
			};
			// History imports and clock rollback may create an older timestamp. A successful
			// record() must still return a persisted ID that its owning model can report.
			store.records = store.records
				.sort((left, right) => right.createdAt - left.createdAt)
				.slice(0, this.maxRecords - 1);
			store.records.unshift(item);
			this.write(store);
			changed = true;
			return item;
		});
		if (changed) this.changed();
		return result;
	}

	/** Only the model executing the owning session may attach analysis to observed evidence. */
	report(sessionId: string, input: ExecutionAnomalyReportInput): ExecutionAnomalyRecord {
		if (!["resolved", "unresolved", "ignored"].includes(input.outcome)) throw new Error("执行异常处理结果无效");
		const owner = identity(sessionId, "会话 ID");
		const report: ExecutionAnomalyReport = {
			cause: requiredText(input.cause, "异常原因", MAX_REPORT_TEXT),
			action: requiredText(input.action, "处理过程", MAX_REPORT_TEXT),
			outcome: input.outcome,
			reportedAt: timestamp(this.now()),
		};
		const result = withFileLockSync(this.path, () => {
			const store = this.read();
			const item = store.records.find((entry) => entry.id === input.id && entry.sessionId === owner);
			if (!item) throw new Error("执行异常记录不存在或不属于当前会话");
			item.report = report;
			item.status = "reported";
			item.updatedAt = report.reportedAt;
			this.write(store);
			return item;
		});
		this.changed();
		return result;
	}

	list(input: ExecutionAnomalyListInput = {}): ExecutionAnomalyListResult {
		const processing = input.processing ?? "active";
		if (!["active", "optimized", "dismissed", "all"].includes(processing)) throw new Error("执行异常处理筛选无效");
		const query = input.query?.trim().toLocaleLowerCase();
		const offset = boundedInteger(input.offset, 0, Number.MAX_SAFE_INTEGER);
		const limit = boundedInteger(input.limit, 100, 500);
		return withFileLockSync(this.path, () => {
			const records = this.read()
				.records.filter((item) => !input.status || item.status === input.status)
				.filter((item) => !input.sessionId || item.sessionId === input.sessionId)
				.filter((item) =>
					processing === "all"
						? true
						: processing === "active"
							? !item.processing
							: item.processing?.kind === processing,
				)
				.filter((item) => !query || JSON.stringify(item).toLocaleLowerCase().includes(query))
				.sort((left, right) => right.createdAt - left.createdAt);
			return { records: records.slice(offset, offset + limit), total: records.length };
		});
	}

	/** Softly hide an optimized or intentionally dismissed finding without rewriting its evidence or model analysis. */
	process(input: ExecutionAnomalyProcessInput): ExecutionAnomalyRecord {
		const id = identity(input.id, "异常 ID");
		if (input.kind !== "optimized" && input.kind !== "dismissed") throw new Error("执行异常处理类型无效");
		const processing: ExecutionAnomalyProcessing = {
			kind: input.kind,
			note: requiredText(input.note, "处理说明", MAX_REPORT_TEXT),
			verification: requiredText(input.verification, "验证依据", MAX_REPORT_TEXT),
			processedAt: timestamp(this.now()),
		};
		const result = withFileLockSync(this.path, () => {
			const store = this.read();
			const item = store.records.find((entry) => entry.id === id);
			if (!item) throw new Error("执行异常记录不存在");
			item.processing = processing;
			this.write(store);
			return item;
		});
		this.changed();
		return result;
	}

	/** Restore a softly processed finding to the active list; its original error and report are retained. */
	restore(id: string): ExecutionAnomalyRecord {
		const target = identity(id, "异常 ID");
		let changed = false;
		const result = withFileLockSync(this.path, () => {
			const store = this.read();
			const item = store.records.find((entry) => entry.id === target);
			if (!item) throw new Error("执行异常记录不存在");
			if (item.processing) {
				delete item.processing;
				this.write(store);
				changed = true;
			}
			return item;
		});
		if (changed) this.changed();
		return result;
	}

	get(id: string): ExecutionAnomalyRecord | undefined {
		return withFileLockSync(this.path, () => this.read().records.find((item) => item.id === id));
	}
}
