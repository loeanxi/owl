/**
 * 模型诊断 —— 移植自 manager diagnostics。
 * 只跑固定用例（文本标记、流式结束、2+3 工具与续接），不接受自定义提示词。
 * 诊断不走成员钱包和公开调用日志。
 */
import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
	type Account,
	type AccountStore,
	GatewayFault,
	type Platform,
	stripModelPrefix,
	type UpstreamChatClient,
	UpstreamException,
} from "owl-pool";
import { jsonRespond } from "./http/respond.ts";
import type { Router } from "./http/router.ts";

const CASES = ["TEXT", "STREAM", "TOOLS", "TOOL_CONTINUATION", "IMAGE", "LONG_CONTEXT"] as const;
type DiagnosticCase = (typeof CASES)[number];
const EXECUTABLE = new Set<DiagnosticCase>(["TEXT", "STREAM", "TOOLS", "TOOL_CONTINUATION"]);
type DiagnosticStatus =
	| "QUEUED"
	| "PENDING"
	| "RUNNING"
	| "PASSED"
	| "FAILED"
	| "NOT_TESTED"
	| "CANCELLED"
	| "TIMED_OUT";

const TOOL = "diagnostic_add";
const MAX_SLOTS = 4;

interface ResultRow {
	id: string;
	run_id: string;
	account_id: string;
	upstream_model: string;
	case_type: DiagnosticCase;
	status: DiagnosticStatus;
	reason_code: string | null;
	reason: string | null;
	duration_ms: number | null;
	checked_at: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	evidence_fingerprint: string;
}

interface RunRow {
	id: string;
	account_id: string;
	account_name: string;
	platform: string;
	upstream_model: string;
	status: DiagnosticStatus;
	requested_by: string;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	timeout_seconds: number;
	evidence_fingerprint: string;
}

interface ToolTurn {
	messages: Array<Record<string, unknown>>;
	callId: string;
	receipt: string;
}

interface Job {
	runId: string;
	accountId: string;
	platform: Platform;
	model: string;
	timeoutSeconds: number;
	stopped: boolean;
	toolTurn: ToolTurn | null;
	caseStarted: number;
}

export interface DiagnosticRoutesDeps {
	db: DatabaseSync;
	accounts: AccountStore;
	upstreams: Map<Platform, UpstreamChatClient>;
}

export function registerDiagnosticRoutes(router: Router, deps: DiagnosticRoutesDeps): void {
	const service = new DiagnosticService(deps);
	router.post("/api/model-diagnostics/runs", async (ctx) => {
		try {
			const view = service.start((await ctx.readBody<Record<string, unknown>>()) ?? {}, "admin");
			jsonRespond(ctx.response, 202, { ok: true, data: view });
		} catch (error) {
			writeDiagnosticError(ctx.response, error);
		}
	});
	router.get("/api/model-diagnostics/runs", async (ctx) =>
		service.list(ctx.query.get("accountId"), ctx.query.get("upstreamModel"), Number(ctx.query.get("limit") ?? "20")),
	);
	router.get("/api/model-diagnostics/latest", async (ctx) =>
		service.latest(ctx.query.get("accountId") ?? "", ctx.query.get("upstreamModel") ?? ""),
	);
	router.post("/api/model-diagnostics/runs/:id/cancel", async (ctx) => {
		try {
			return service.cancel(ctx.params.id ?? "");
		} catch (error) {
			writeDiagnosticError(ctx.response, error);
		}
	});
	router.get("/api/model-diagnostics/runs/:id", async (ctx) => {
		try {
			return service.get(ctx.params.id ?? "");
		} catch (error) {
			writeDiagnosticError(ctx.response, error);
		}
	});
}

class DiagnosticService {
	readonly #db: DatabaseSync;
	readonly #accounts: AccountStore;
	readonly #upstreams: Map<Platform, UpstreamChatClient>;
	readonly #active = new Map<string, Job>();
	readonly #activeAccounts = new Map<string, string>();
	#slots = MAX_SLOTS;

	constructor(deps: DiagnosticRoutesDeps) {
		this.#db = deps.db;
		this.#accounts = deps.accounts;
		this.#upstreams = deps.upstreams;
		this.#recover();
	}

	start(body: Record<string, unknown>, requestedBy: string): Record<string, unknown> {
		if (body.confirmSpend !== true) throw fault(400, "diagnostic_spend_confirmation", "请确认诊断会消耗上游额度");
		const model = normalizeModel(body.upstreamModel);
		const timeout =
			body.timeoutSeconds === undefined || body.timeoutSeconds === null ? 60 : Number(body.timeoutSeconds);
		if (!Number.isInteger(timeout) || timeout < 15 || timeout > 120) {
			throw fault(400, "diagnostic_invalid_timeout", "单项诊断超时应为 15 到 120 秒");
		}
		const selected = selectCases(body.cases);
		if (![...selected].some((type) => EXECUTABLE.has(type)))
			throw fault(400, "diagnostic_no_case", "请选择至少一项可执行诊断");
		if (selected.has("TOOL_CONTINUATION")) selected.add("TOOLS");
		const accountId = String(body.accountId ?? "");
		const account = this.#accounts.get(accountId);
		if (account === undefined) throw fault(404, "diagnostic_account_missing", "账号不存在");
		if (!account.enabled || !this.#upstreams.has(account.platform)) {
			throw fault(400, "diagnostic_account_unavailable", "请选择已启用且支持诊断的账号");
		}
		if (this.#slots <= 0) throw fault(429, "diagnostic_busy", "诊断并发已满，请稍后重试");
		this.#slots -= 1;
		const runId = randomUUID();
		if (this.#activeAccounts.has(account.id)) {
			this.#slots += 1;
			throw fault(409, "diagnostic_account_busy", "该账号已有诊断正在执行或停止中");
		}
		this.#activeAccounts.set(account.id, runId);
		try {
			const now = Date.now();
			const fingerprint = evidenceFingerprint(this.#db, account, model);
			const requested = requestedBy.slice(0, 128) || "local-recovery";
			this.#db
				.prepare(
					`INSERT INTO model_diagnostic_runs (id, account_id, account_name, platform, upstream_model, status,
					requested_by, created_at, timeout_seconds, evidence_fingerprint)
				 VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
				)
				.run(runId, account.id, account.name, account.platform, model, requested, now, timeout, fingerprint);
			for (const type of CASES) {
				const chosen = EXECUTABLE.has(type) && selected.has(type);
				this.#insertResult({
					id: randomUUID(),
					run_id: runId,
					account_id: account.id,
					upstream_model: model,
					case_type: type,
					status: chosen ? "PENDING" : "NOT_TESTED",
					reason_code: chosen ? null : EXECUTABLE.has(type) ? "not_selected" : "fixture_not_available",
					reason: chosen ? null : notTestedReason(type),
					duration_ms: null,
					checked_at: null,
					input_tokens: null,
					output_tokens: null,
					evidence_fingerprint: fingerprint,
				});
			}
			const job: Job = {
				runId,
				accountId: account.id,
				platform: account.platform,
				model,
				timeoutSeconds: timeout,
				stopped: false,
				toolTurn: null,
				caseStarted: 0,
			};
			this.#active.set(runId, job);
			void this.#execute(job);
			return this.#view(runId);
		} catch (error) {
			if (!this.#active.has(runId) && this.#activeAccounts.get(account.id) === runId) {
				this.#activeAccounts.delete(account.id);
				this.#slots += 1;
			}
			throw error;
		}
	}

	get(id: string): Record<string, unknown> {
		if (this.#loadRun(id) === undefined) throw fault(404, "diagnostic_not_found", "未找到诊断记录");
		return this.#view(id);
	}

	list(accountId: string | null, model: string | null, limit: number): Array<Record<string, unknown>> {
		const size = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 20;
		const account = blank(accountId);
		const upstream = blank(model);
		const rows = this.#db
			.prepare(
				`SELECT id FROM model_diagnostic_runs
			 WHERE (? IS NULL OR account_id = ?) AND (? IS NULL OR upstream_model = ?)
			 ORDER BY created_at DESC LIMIT ?`,
			)
			.all(account, account, upstream, upstream, size) as Array<{ id: string }>;
		return rows.map((row) => this.#view(row.id));
	}

	latest(accountId: string, upstreamModel: string): Array<Record<string, unknown>> {
		const model = normalizeModel(upstreamModel);
		const current = this.#currentFingerprint(accountId, model);
		return CASES.map((type) => {
			const found = this.#db
				.prepare(
					`SELECT * FROM model_diagnostic_results
				 WHERE account_id = ? AND upstream_model = ? AND case_type = ? AND checked_at IS NOT NULL
				 ORDER BY checked_at DESC LIMIT 1`,
				)
				.get(accountId, model, type) as ResultRow | undefined;
			if (found === undefined) {
				return caseView(
					{
						case_type: type,
						status: "NOT_TESTED",
						reason_code: "no_evidence",
						reason: "尚无该账号与模型的实测记录",
					},
					false,
				);
			}
			return caseView(found, current === found.evidence_fingerprint);
		});
	}

	cancel(id: string): Record<string, unknown> {
		const job = this.#active.get(id);
		if (job === undefined) {
			if (this.#loadRun(id) === undefined) throw fault(404, "diagnostic_not_found", "未找到诊断记录");
			return this.#view(id);
		}
		this.#stop(job, "CANCELLED", "cancelled_by_admin", "管理员已取消诊断");
		return this.#view(id);
	}

	async #execute(job: Job): Promise<void> {
		try {
			if (job.stopped) return;
			this.#db
				.prepare("UPDATE model_diagnostic_runs SET status = 'RUNNING', started_at = ? WHERE id = ?")
				.run(Date.now(), job.runId);
			for (const type of CASES) {
				const result = this.#result(job.runId, type);
				if (job.stopped) return;
				if (result.status !== "PENDING") continue;
				if (type === "TOOL_CONTINUATION" && job.toolTurn === null) {
					this.#finishSkipped(result, "NOT_TESTED", "tool_prerequisite_failed", "前置工具调用未通过，续接未测试");
					continue;
				}
				job.caseStarted = Date.now();
				this.#updateResult(result.id, { status: "RUNNING" });
				const timer = setTimeout(() => this.#timeout(job, type), job.timeoutSeconds * 1000);
				try {
					const outcome = await this.#probe(job, type);
					if (job.stopped) return;
					if (outcome.turn !== undefined) job.toolTurn = outcome.turn;
					this.#finishPassed(job, result, outcome);
				} catch (error) {
					if (job.stopped) return;
					const reason = safeReason(error);
					this.#finishFailed(job, result, reason[0], reason[1]);
				} finally {
					clearTimeout(timer);
				}
			}
			if (!job.stopped) {
				const failed = this.#results(job.runId).some((row) => row.status === "FAILED");
				this.#db
					.prepare("UPDATE model_diagnostic_runs SET status = ?, finished_at = ? WHERE id = ?")
					.run(failed ? "FAILED" : "PASSED", Date.now(), job.runId);
			}
		} catch {
			this.#stop(job, "FAILED", "diagnostic_internal_failure", "诊断未能完成，请重试并检查服务状态");
		} finally {
			this.#release(job);
		}
	}

	async #probe(job: Job, type: DiagnosticCase): Promise<ProbeOutcome> {
		const account = this.#currentAccount(job);
		const client = this.#upstreams.get(job.platform);
		if (client === undefined || account === undefined)
			throw fault(400, "diagnostic_unsupported_platform", "该平台暂不支持诊断");
		if (type === "TEXT") {
			const marker = `DIAG_TEXT_${nonce()}`;
			const payload = basePayload(job.model, false);
			payload.messages = [user(`Reply with exactly this text: ${marker}`)];
			return probeText(await client.chatCompletion(account, payload), marker);
		}
		if (type === "STREAM") {
			const marker = `DIAG_STREAM_${nonce()}`;
			const received: string[] = [];
			let frames = 0;
			let terminal = false;
			let truncated = false;
			let usage: Record<string, unknown> | null = null;
			await client.chatCompletionStream(account, textPayload(job.model, true, marker), (frame) => {
				if (job.stopped) throw invalid("cancelled", "诊断已取消");
				const parsed = readStreamFrame(frame, received, () => {
					frames += 1;
				});
				terminal = terminal || parsed.terminal;
				truncated = truncated || parsed.truncated;
				if (parsed.usage !== null) usage = parsed.usage;
			});
			if (frames === 0 || !terminal || truncated || !received.join("").includes(marker)) {
				throw invalid("incomplete_stream", "未收到完整的流式文本及结束标记");
			}
			return outcome("stream_verified", "已收到文本增量与流式结束标记", usage, undefined);
		}
		if (type === "TOOLS") {
			const payload = basePayload(job.model, false);
			payload.messages = [
				user(
					"Call diagnostic_add exactly once with x=2 and y=3. After its result, reply with the receipt field exactly. Do not invent a receipt.",
				),
			];
			payload.tools = toolDefinitions();
			payload.tool_choice = "required";
			return probeTools(await client.chatCompletion(account, payload));
		}
		const turn = job.toolTurn;
		if (turn === null) throw invalid("tool_prerequisite_failed", "前置工具调用未通过，无法验收续接");
		const messages = [
			...turn.messages,
			{ role: "tool", tool_call_id: turn.callId, content: `{"sum":5,"receipt":"${turn.receipt}"}` },
		];
		const payload = basePayload(job.model, false);
		payload.messages = messages;
		payload.tools = toolDefinitions();
		payload.tool_choice = "none";
		return probeContinuation(await client.chatCompletion(account, payload), turn.receipt);
	}

	#currentAccount(job: Job): Account | undefined {
		const account = this.#accounts.get(job.accountId);
		if (account === undefined || !account.enabled || account.platform !== job.platform) {
			throw fault(409, "account_changed", "账号已变更");
		}
		return account;
	}

	#timeout(job: Job, expected: DiagnosticCase): void {
		const result = this.#result(job.runId, expected);
		if (job.stopped || result.status !== "RUNNING") return;
		this.#stop(job, "TIMED_OUT", "diagnostic_timeout", "诊断已超时，已请求停止上游调用");
	}

	#stop(job: Job, status: DiagnosticStatus, code: string, reason: string): void {
		if (terminal(this.#loadRun(job.runId)?.status)) return;
		job.stopped = true;
		const now = Date.now();
		this.#db
			.prepare("UPDATE model_diagnostic_runs SET status = ?, finished_at = ? WHERE id = ?")
			.run(status, now, job.runId);
		for (const result of this.#results(job.runId)) {
			if (terminal(result.status)) continue;
			const duration = result.status === "RUNNING" ? now - job.caseStarted : null;
			this.#db
				.prepare(
					`UPDATE model_diagnostic_results SET status = ?, reason_code = ?, reason = ?, checked_at = ?, duration_ms = COALESCE(?, duration_ms) WHERE id = ?`,
				)
				.run(status, code, reason, now, duration, result.id);
		}
	}

	#finishPassed(job: Job, result: ResultRow, probe: ProbeOutcome): void {
		const now = Date.now();
		this.#db
			.prepare(
				`UPDATE model_diagnostic_results SET status = 'PASSED', reason_code = ?, reason = ?, input_tokens = ?, output_tokens = ?,
				checked_at = ?, duration_ms = ? WHERE id = ?`,
			)
			.run(probe.code, probe.reason, probe.inputTokens, probe.outputTokens, now, now - job.caseStarted, result.id);
	}

	#finishFailed(job: Job, result: ResultRow, code: string, reason: string): void {
		const now = Date.now();
		this.#db
			.prepare(
				`UPDATE model_diagnostic_results SET status = 'FAILED', reason_code = ?, reason = ?, checked_at = ?, duration_ms = ? WHERE id = ?`,
			)
			.run(code, clip(reason, 240), now, now - job.caseStarted, result.id);
	}

	#finishSkipped(result: ResultRow, status: DiagnosticStatus, code: string, reason: string): void {
		this.#db
			.prepare("UPDATE model_diagnostic_results SET status = ?, reason_code = ?, reason = ? WHERE id = ?")
			.run(status, code, reason, result.id);
	}

	#release(job: Job): void {
		this.#active.delete(job.runId);
		if (this.#activeAccounts.get(job.accountId) === job.runId) {
			this.#activeAccounts.delete(job.accountId);
			this.#slots = Math.min(MAX_SLOTS, this.#slots + 1);
		}
	}

	#recover(): void {
		const now = Date.now();
		const rows = this.#db
			.prepare("SELECT id FROM model_diagnostic_runs WHERE status IN ('QUEUED', 'RUNNING')")
			.all() as Array<{ id: string }>;
		for (const row of rows) {
			this.#db
				.prepare("UPDATE model_diagnostic_runs SET status = 'CANCELLED', finished_at = ? WHERE id = ?")
				.run(now, row.id);
			this.#db
				.prepare(
					`UPDATE model_diagnostic_results SET status = 'CANCELLED', reason_code = 'process_restarted',
					reason = '服务已重启，本次诊断未完成，请重新运行', checked_at = COALESCE(checked_at, ?)
				 WHERE run_id = ? AND status IN ('QUEUED', 'PENDING', 'RUNNING')`,
				)
				.run(now, row.id);
		}
	}

	#view(id: string): Record<string, unknown> {
		const run = this.#loadRun(id);
		if (run === undefined) throw fault(404, "diagnostic_not_found", "未找到诊断记录");
		const current = this.#currentFingerprint(run.account_id, run.upstream_model) === run.evidence_fingerprint;
		return {
			id: run.id,
			accountId: run.account_id,
			accountName: run.account_name,
			platform: run.platform,
			upstreamModel: run.upstream_model,
			status: run.status,
			requestedBy: run.requested_by,
			createdAt: iso(run.created_at),
			startedAt: iso(run.started_at),
			finishedAt: iso(run.finished_at),
			cases: this.#results(run.id).map((row) => caseView(row, current)),
			isCurrent: current,
		};
	}

	#loadRun(id: string): RunRow | undefined {
		return this.#db.prepare("SELECT * FROM model_diagnostic_runs WHERE id = ?").get(id) as RunRow | undefined;
	}

	#results(runId: string): ResultRow[] {
		const rows = this.#db
			.prepare("SELECT * FROM model_diagnostic_results WHERE run_id = ?")
			.all(runId) as unknown as ResultRow[];
		return rows.sort((left, right) => CASES.indexOf(left.case_type) - CASES.indexOf(right.case_type));
	}

	#result(runId: string, type: DiagnosticCase): ResultRow {
		const found = this.#results(runId).find((row) => row.case_type === type);
		if (found === undefined) throw fault(500, "diagnostic_internal_failure", "诊断用例缺失");
		return found;
	}

	#insertResult(row: ResultRow): void {
		this.#db
			.prepare(
				`INSERT INTO model_diagnostic_results (id, run_id, account_id, upstream_model, case_type, status, reason_code, reason,
				duration_ms, checked_at, input_tokens, output_tokens, evidence_fingerprint)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.id,
				row.run_id,
				row.account_id,
				row.upstream_model,
				row.case_type,
				row.status,
				row.reason_code,
				row.reason,
				row.duration_ms,
				row.checked_at,
				row.input_tokens,
				row.output_tokens,
				row.evidence_fingerprint,
			);
	}

	#updateResult(id: string, patch: { status: DiagnosticStatus }): void {
		this.#db.prepare("UPDATE model_diagnostic_results SET status = ? WHERE id = ?").run(patch.status, id);
	}

	#currentFingerprint(accountId: string, model: string): string {
		const account = this.#accounts.get(accountId);
		return account === undefined ? "" : evidenceFingerprint(this.#db, account, model);
	}
}

function selectCases(value: unknown): Set<DiagnosticCase> {
	if (value === undefined || value === null) return new Set(EXECUTABLE);
	if (!Array.isArray(value) || value.length === 0) return new Set();
	const selected = new Set<DiagnosticCase>();
	for (const item of value) {
		if (!CASES.includes(item as DiagnosticCase)) throw fault(400, "diagnostic_no_case", "请选择至少一项可执行诊断");
		selected.add(item as DiagnosticCase);
	}
	return selected;
}

function normalizeModel(value: unknown): string {
	const model = typeof value === "string" ? value.trim() : "";
	if (model.length === 0 || model.length > 256 || model.includes("://") || /[\u0000-\u001f]/.test(model)) {
		throw fault(400, "diagnostic_invalid_model", "请输入有效的上游模型标识");
	}
	if (model !== stripModelPrefix(model) || model.includes("@")) {
		throw fault(
			400,
			"diagnostic_raw_model_required",
			"请输入实际上游模型标识，不要添加网关平台前缀或 @ 推理等级后缀",
		);
	}
	return model;
}

function notTestedReason(type: DiagnosticCase): string {
	if (!EXECUTABLE.has(type)) {
		return type === "IMAGE" ? "本轮未检查图片输入能力，请另行核验" : "本轮未检查长上下文，不代表已确认模型上下文上限";
	}
	return "本轮未选择此用例";
}

function terminal(status: DiagnosticStatus | undefined): boolean {
	return status !== undefined && status !== "QUEUED" && status !== "PENDING" && status !== "RUNNING";
}

function evidenceFingerprint(db: DatabaseSync, account: Account, model: string): string {
	const digest = createHash("sha256");
	add(digest, account.id, account.platform, account.enabled, JSON.stringify(account.credentials), model);
	const found = db
		.prepare(
			`SELECT model_version, context_window, max_output_tokens, supports_images, supports_tools, reasoning_efforts,
			available_context_windows, available_modes, default_reasoning_effort, available,
			verified_model_version, verified_supports_images, verified_supports_tools, verified_reasoning_efforts, verification_status
		 FROM discovered_models WHERE platform = ? AND upstream_model = ?`,
		)
		.get(account.platform, model) as Record<string, unknown> | undefined;
	if (found === undefined) add(digest, "unlisted");
	else add(digest, ...Object.values(found));
	return digest.digest("hex");
}

function add(digest: ReturnType<typeof createHash>, ...fields: unknown[]): void {
	for (const field of fields) {
		const bytes = Buffer.from(String(field), "utf8");
		digest.update(Buffer.from(`${bytes.length}:`, "ascii"));
		digest.update(bytes);
	}
}

function caseView(
	row: Partial<ResultRow> & { case_type: DiagnosticCase; status: DiagnosticStatus },
	current: boolean,
): Record<string, unknown> {
	return {
		caseType: row.case_type,
		status: row.status,
		reasonCode: row.reason_code ?? null,
		reason: row.reason ?? null,
		durationMs: row.duration_ms ?? null,
		checkedAt: iso(row.checked_at),
		inputTokens: row.input_tokens ?? null,
		outputTokens: row.output_tokens ?? null,
		isCurrent: current && row.checked_at != null,
	};
}

interface ProbeOutcome {
	code: string;
	reason: string;
	inputTokens: number | null;
	outputTokens: number | null;
	turn?: ToolTurn;
}

function probeText(body: Record<string, unknown>, marker: string): ProbeOutcome {
	const message = messageOf(body);
	if (!contentOf(message.content).includes(marker) || toolCalls(message).length > 0) {
		throw invalid("text_mismatch", "未收到预期文本标记");
	}
	return outcome("text_verified", "收到预期文本标记", body, undefined);
}

function probeTools(body: Record<string, unknown>): ProbeOutcome {
	const message = messageOf(body);
	const calls = toolCalls(message);
	if (calls.length !== 1) throw invalid("tool_call_missing", "未收到唯一的诊断工具调用");
	const call = calls[0] ?? {};
	const id = String(call.id ?? "");
	const fn = (call.function ?? {}) as Record<string, unknown>;
	if (id.length === 0 || id.length > 256 || call.type !== "function" || fn.name !== TOOL) {
		throw invalid("unknown_tool", "返回了未授权工具或无效调用标识，未执行任何工具");
	}
	let parsed: Record<string, unknown>;
	try {
		const argumentsText = String(fn.arguments ?? "");
		if (argumentsText.length > 4096) throw new Error("long");
		parsed = JSON.parse(argumentsText) as Record<string, unknown>;
	} catch {
		throw invalid("invalid_tool_arguments", "诊断工具参数不是有效 JSON");
	}
	if (Object.keys(parsed).length !== 2 || parsed.x !== 2 || parsed.y !== 3) {
		throw invalid("invalid_tool_arguments", "工具参数不符合固定算术用例，未执行任何工具");
	}
	const receipt = `DIAG_RESULT_${nonce()}`;
	const messages = [
		user(
			"Call diagnostic_add exactly once with x=2 and y=3. After its result, reply with the receipt field exactly. Do not invent a receipt.",
		),
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id, type: "function", function: { name: TOOL, arguments: '{"x":2,"y":3}' } }],
		},
	];
	return outcome("tool_call_verified", "工具名称、调用标识和固定参数均通过验证", body, {
		messages,
		callId: id,
		receipt,
	});
}

function probeContinuation(body: Record<string, unknown>, receipt: string): ProbeOutcome {
	const message = messageOf(body);
	if (toolCalls(message).length > 0 || !contentOf(message.content).includes(receipt)) {
		throw invalid("tool_result_not_used", "续接未返回工具结果中的随机标记");
	}
	return outcome("tool_continuation_verified", "工具结果已回传，模型正确读取随机结果标记", body, undefined);
}

function readStreamFrame(
	frame: string,
	received: string[],
	countText: () => void,
): { terminal: boolean; truncated: boolean; usage: Record<string, unknown> | null } {
	if (frame === "[DONE]") return { terminal: true, truncated: false, usage: null };
	if (frame.length > 65_536) throw invalid("invalid_stream", "流式响应格式无效");
	let chunk: Record<string, unknown>;
	try {
		chunk = JSON.parse(frame) as Record<string, unknown>;
	} catch {
		throw invalid("invalid_stream", "流式响应不是有效 JSON");
	}
	if (chunk.error !== undefined) throw invalid("invalid_stream", "流式响应包含错误");
	let terminal = false;
	let truncated = false;
	const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
	for (const choice of choices) {
		const row = choice as Record<string, unknown>;
		const delta = (row.delta ?? {}) as Record<string, unknown>;
		const text = contentOf(delta.content);
		if (text.length > 0) {
			received.push(text);
			countText();
		}
		if (row.finish_reason !== undefined && row.finish_reason !== null) terminal = true;
		if (row.finish_reason === "length" || row.finish_reason === "content_filter") truncated = true;
	}
	if (received.join("").length > 65_536) throw invalid("response_too_large", "诊断响应超过长度上限");
	return { terminal, truncated, usage: chunk.usage === undefined ? null : chunk };
}

function textPayload(model: string, stream: boolean, marker: string): Record<string, unknown> {
	const payload = basePayload(model, stream);
	payload.messages = [user(`Reply with exactly this text: ${marker}`)];
	return payload;
}

function basePayload(model: string, stream: boolean): Record<string, unknown> {
	return { model, messages: [], stream, max_tokens: 512 };
}

function toolDefinitions(): unknown[] {
	return [
		{
			type: "function",
			function: {
				name: TOOL,
				description: "Diagnostic-only fixed addition. The only accepted input is x=2 and y=3.",
				parameters: {
					type: "object",
					properties: { x: { type: "integer", enum: [2] }, y: { type: "integer", enum: [3] } },
					required: ["x", "y"],
					additionalProperties: false,
				},
			},
		},
	];
}

function user(prompt: string): Record<string, unknown> {
	return { role: "user", content: prompt };
}

function nonce(): string {
	return randomUUID().replace(/-/g, "");
}

function messageOf(root: Record<string, unknown>): Record<string, unknown> {
	const choices = Array.isArray(root.choices) ? root.choices : [];
	const first = (choices[0] ?? {}) as Record<string, unknown>;
	const message = first.message;
	if (message === null || typeof message !== "object" || root.error !== undefined)
		throw invalid("invalid_completion", "模型响应缺少有效消息");
	return message as Record<string, unknown>;
}

function contentOf(node: unknown): string {
	if (typeof node === "string") return node;
	if (!Array.isArray(node)) return "";
	return node
		.map((item) =>
			item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
				? (item as { text: string }).text
				: "",
		)
		.join("");
}

function toolCalls(message: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
}

function outcome(
	code: string,
	reason: string,
	root: Record<string, unknown> | null,
	turn: ToolTurn | undefined,
): ProbeOutcome {
	const usage =
		root?.usage_source !== undefined && root.usage_source !== "KNOWN"
			? null
			: (root?.usage as Record<string, unknown> | undefined);
	return {
		code,
		reason,
		inputTokens: count(usage, "prompt_tokens"),
		outputTokens: count(usage, "completion_tokens"),
		turn,
	};
}

function count(usage: Record<string, unknown> | null | undefined, name: string): number | null {
	const value = usage?.[name];
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

class InvalidResult extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function invalid(code: string, message: string): InvalidResult {
	return new InvalidResult(code, message);
}

function safeReason(error: unknown): [string, string] {
	if (error instanceof InvalidResult) return [error.code, error.message];
	if (error instanceof UpstreamException) {
		if (error.kind === "AUTH") return ["upstream_auth", "上游账号鉴权失败"];
		if (error.kind === "RATE") return ["upstream_rate_limited", "上游账号触发限流"];
		if (error.kind === "QUOTA") return ["upstream_quota", "上游账号额度不足"];
		if (error.kind === "BAD_REQUEST") return ["unsupported_request", "上游不支持本次诊断请求或能力"];
		return ["upstream_unavailable", "上游服务暂不可用"];
	}
	if (error instanceof GatewayFault) {
		if (error.code === "gateway_busy") return ["account_busy", "所选账号繁忙，本次未换号"];
		if (error.code === "request_cancelled") return ["upstream_cancelled", "上游调用已取消"];
		if (error.status === 504) return ["upstream_timeout", "上游响应超时"];
	}
	return ["diagnostic_call_failed", "诊断调用未完成，请检查账号和运行环境"];
}

function fault(status: number, code: string, message: string): GatewayFault {
	return new GatewayFault(status, code, message);
}

function writeDiagnosticError(response: ServerResponse, error: unknown): void {
	if (response.writableEnded) return;
	if (error instanceof GatewayFault) {
		jsonRespond(response, error.status, { ok: false, error: error.message, code: error.code });
		return;
	}
	jsonRespond(response, 500, {
		ok: false,
		error: "诊断未能完成，请重试并检查服务状态",
		code: "diagnostic_internal_failure",
	});
}

function iso(value: number | null | undefined): string | null {
	return value === null || value === undefined || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

function blank(value: string | null): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function clip(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max);
}
