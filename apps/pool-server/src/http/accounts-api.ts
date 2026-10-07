/**
 * 账号 REST —— 移植自 manager `AccountController`（阶段 1 子集）。
 * 对外凭证一律脱敏（manager 约定）；PUT 时 "***" 视为「保持原值」，
 * 避免客户端回传脱敏值覆盖真实凭证。
 */

import {
	type Account,
	type AccountInput,
	type AccountStore,
	BusinessError,
	isPlatform,
	type Platform,
	parseCredentials,
} from "owl-pool";
import { probeAccount } from "../catalog/discovery.ts";
import type { RequestContext, Router } from "./router.ts";

export interface AccountRoutesDeps {
	accounts: AccountStore;
	/** 按平台刷新积分并落库。缺省时保持「尚未接入」。 */
	refreshCredit?(account: Account): Promise<Account>;
	/** 按平台探测连通性。缺省时只探测已接入的 HTTP 模型目录。 */
	pingAccount?(account: Account): Promise<Record<string, unknown>>;
	login?: {
		login(account: Account): Promise<Record<string, unknown>>;
		status(account: Account): Promise<Record<string, unknown>>;
		cancel(account: Account, jobId: string | null): Promise<Record<string, unknown>>;
		input(account: Account, text: string): Promise<Record<string, unknown>>;
	};
}

export function registerAccountRoutes(router: Router, deps: AccountRoutesDeps): void {
	router.get("/api/accounts", async (ctx) => {
		const platform = readPlatform(ctx);
		return deps.accounts.list(platform).map(maskCredentials);
	});

	router.post("/api/accounts", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const input = parseAccountInput(body, {});
		return maskCredentials(deps.accounts.create(input, Date.now()));
	});

	router.get("/api/accounts/:id", async (ctx) => maskCredentials(deps.accounts.require(ctx.params.id!)));

	router.put("/api/accounts/:id", async (ctx) => {
		const body = await ctx.readBody<Record<string, unknown>>();
		const current = deps.accounts.require(ctx.params.id!);
		const input = parseAccountInput(body, current);
		return maskCredentials(deps.accounts.updateFields(ctx.params.id!, input, Date.now()));
	});

	router.patch("/api/accounts/:id/enabled", async (ctx) => {
		const raw = ctx.query.get("enabled") ?? (await enabledFromBody(ctx));
		if (raw !== "true" && raw !== "false") {
			throw BusinessError.of("account.badEnabled", "enabled 参数只接受 true/false");
		}
		return maskCredentials(deps.accounts.updateFields(ctx.params.id!, { enabled: raw === "true" }, Date.now()));
	});

	router.post("/api/accounts/:id/ping", async (ctx) => {
		const account = deps.accounts.require(ctx.params.id!);
		return deps.pingAccount !== undefined ? deps.pingAccount(account) : probeAccount(account);
	});

	router.post("/api/accounts/:id/auth/login", async (ctx) => {
		const account = deps.accounts.require(ctx.params.id!);
		if (deps.login === undefined) {
			throw BusinessError.of("account.loginUnsupported", "登录流程尚未接入");
		}
		return deps.login.login(account);
	});

	router.get("/api/accounts/:id/auth/status", async (ctx) => {
		const account = deps.accounts.require(ctx.params.id!);
		if (deps.login === undefined) {
			throw BusinessError.of("account.loginUnsupported", "登录流程尚未接入");
		}
		return deps.login.status(account);
	});

	router.post("/api/accounts/:id/auth/cancel", async (ctx) => {
		const account = deps.accounts.require(ctx.params.id!);
		if (deps.login === undefined) {
			throw BusinessError.of("account.loginUnsupported", "登录流程尚未接入");
		}
		return deps.login.cancel(account, ctx.query.get("jobId"));
	});

	router.post("/api/accounts/:id/auth/input", async (ctx) => {
		const account = deps.accounts.require(ctx.params.id!);
		if (deps.login === undefined) {
			throw BusinessError.of("account.loginUnsupported", "登录流程尚未接入");
		}
		const body = await ctx.readBody<Record<string, unknown>>();
		const text = typeof body.text === "string" ? body.text : typeof body.code === "string" ? body.code : "";
		return deps.login.input(account, text);
	});

	router.post("/api/accounts/:id/credits/refresh", async (ctx) => {
		const account = deps.accounts.require(ctx.params.id!);
		if (deps.refreshCredit === undefined) {
			return { ...maskCredentials(account), creditsStatus: "FAIL", creditsMessage: "该平台积分查询尚未接入" };
		}
		return maskCredentials(await deps.refreshCredit(account));
	});

	router.post("/api/accounts/credits/refresh", async (ctx) => {
		const onlyEnabled = ctx.query.get("onlyEnabled") !== "false";
		const accounts = deps.accounts.list().filter((account) => !onlyEnabled || account.enabled);
		if (deps.refreshCredit === undefined) {
			return {
				total: accounts.length,
				ok: 0,
				failed: accounts.length,
				items: accounts.map((account) => ({
					accountId: account.id,
					accountName: account.name,
					snapshot: { ok: false, message: "该平台积分查询尚未接入" },
				})),
			};
		}
		const items = await mapPool(accounts, 4, async (account) => {
			const updated = await deps.refreshCredit!(account);
			return {
				accountId: account.id,
				accountName: account.name,
				snapshot: { ok: updated.creditsStatus === "OK", message: updated.creditsMessage ?? "" },
			};
		});
		const ok = items.filter((item) => item.snapshot.ok).length;
		return { total: accounts.length, ok, failed: accounts.length - ok, items };
	});

	router.post("/api/credentials/check", async (ctx) => {
		const onlyEnabled = ctx.query.get("onlyEnabled") !== "false";
		return deps.accounts
			.list()
			.filter((account) => !onlyEnabled || account.enabled)
			.map((account) => checkCredential(deps.accounts, account));
	});

	router.post("/api/credentials/check/:id", async (ctx) =>
		checkCredential(deps.accounts, deps.accounts.require(ctx.params.id!)),
	);

	router.delete("/api/accounts/:id", async (ctx) => {
		deps.accounts.require(ctx.params.id!);
		deps.accounts.delete(ctx.params.id!);
		return { deleted: true };
	});
}

function readPlatform(ctx: RequestContext): Platform | undefined {
	const raw = ctx.query.get("platform") ?? undefined;
	if (raw !== undefined && !isPlatform(raw)) {
		throw BusinessError.of("account.badPlatform", `未知平台: ${raw}`);
	}
	return raw;
}

async function enabledFromBody(ctx: RequestContext): Promise<string> {
	const body = await ctx.readBody<Record<string, unknown>>();
	return String(body.enabled ?? "");
}

/** 校验并组装录入字段；credentials 里值为 "***" 的键用现有值回填（PUT 场景）。 */
function parseAccountInput(body: Record<string, unknown>, current: Partial<Account>): AccountInput {
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (name.length === 0) {
		throw BusinessError.of("account.nameRequired", "账号名称不能为空");
	}
	// PUT 允许省略 platform（保持原值）；POST 没有现值，缺失即报错
	const platform = body.platform ?? current.platform;
	if (!isPlatform(platform)) {
		throw BusinessError.of("account.badPlatform", `未知平台: ${String(platform)}`);
	}
	if (
		body.credentials !== undefined &&
		(body.credentials === null || typeof body.credentials !== "object" || Array.isArray(body.credentials))
	) {
		throw BusinessError.of("account.badCredentials", "credentials 必须是对象");
	}
	const merged: Record<string, unknown> = {
		...parseCredentials({ credentials: (body.credentials ?? {}) as Record<string, unknown> }),
	};
	for (const [key, value] of Object.entries(merged)) {
		if (value === "***") {
			merged[key] = parseCredentials({ credentials: current.credentials ?? {} })[key];
		}
	}
	return {
		name,
		platform,
		credentials: merged,
		enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
		remark: body.remark === undefined ? undefined : body.remark === null ? null : String(body.remark),
	};
}

/** 凭证脱敏：字符串值一律打码（阶段 2 移植 AccountResponse 的按平台精细脱敏）。 */
const SENSITIVE_KEY = /token|secret|session|authorization|password|apikey|api_key/i;
const UNLIMITED_NOTE = "积分池不限量";

/** 对齐 manager Masker：短值打满星，长值保留末 4 位。 */
function maskValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 8) {
		return "****";
	}
	return `****${trimmed.slice(-4)}`;
}

const WARN_DAYS = 7;

function checkCredential(accounts: AccountStore, account: Account): Record<string, unknown> {
	const now = Date.now();
	const expires = account.credentialExpiresAt ?? null;
	const remaining = expires === null ? null : Math.floor((expires - now) / 86_400_000);
	let status: Account["credentialStatus"] = "UNKNOWN";
	let message = "凭证没有到期时间，尚未探测上游";
	if (Object.keys(parseCredentials(account)).length === 0) {
		status = "ERROR";
		message = "账号没有凭证";
	} else if (remaining !== null && remaining < 0) {
		status = "EXPIRED";
		message = "凭证已过期";
	} else if (remaining !== null && remaining <= WARN_DAYS) {
		status = "WARN";
		message = `凭证将在 ${remaining} 天后到期`;
	} else if (remaining !== null) {
		status = "OK";
		message = "凭证在有效期内";
	}
	const saved = accounts.patchState(account.id, {
		credentialStatus: status,
		credentialCheckedAt: now,
		credentialMessage: message,
	});
	const checked = saved.credentialExpiresAt;
	return {
		accountId: saved.id,
		accountName: saved.name,
		platform: saved.platform,
		enabled: saved.enabled,
		status: saved.credentialStatus ?? "UNKNOWN",
		expiresAt: checked === null || checked === undefined ? "" : new Date(checked).toISOString(),
		remainingDays: remaining === null ? -1 : remaining,
		checkedAt: new Date(now).toISOString(),
		message,
	};
}

function creditBuckets(raw: string | null | undefined): unknown[] {
	if (raw === null || raw === undefined || raw.trim().length === 0) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * 对外账号视图：保留测试用的 credentials（字符串一律 ***），
 * 同时给出原版管理台读取的 credentialsMasked（按字段名精细脱敏）。
 */
function maskCredentials(account: Account): Account & {
	credentialsMasked: Record<string, string>;
	creditsUnlimited: boolean;
	creditBuckets: unknown[];
	credentialRemainingDays: number | null;
} {
	const parsed = parseCredentials(account);
	const credentials: Record<string, unknown> = {};
	const credentialsMasked: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value === null || value === undefined) {
			continue;
		}
		const text = typeof value === "string" ? value : JSON.stringify(value);
		credentials[key] = typeof value === "string" && value.length > 0 ? "***" : value;
		credentialsMasked[key] = SENSITIVE_KEY.test(key) ? maskValue(text) : text;
	}
	const expires = account.credentialExpiresAt;
	const credentialRemainingDays =
		expires === null || expires === undefined ? null : Math.floor((expires - Date.now()) / 86_400_000);
	return {
		...account,
		credentials,
		credentialsMasked,
		creditsUnlimited: account.creditsMessage === UNLIMITED_NOTE,
		creditBuckets: creditBuckets(account.creditsDetails),
		credentialRemainingDays,
	};
}

async function mapPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) {
				return;
			}
			out[index] = await run(items[index]!);
		}
	});
	await Promise.all(workers);
	return out;
}
