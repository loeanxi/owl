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
import type { RequestContext, Router } from "./router.ts";

export interface AccountRoutesDeps {
	accounts: AccountStore;
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
function maskCredentials(account: Account): Account {
	const credentials: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(account.credentials)) {
		credentials[key] = typeof value === "string" && value.length > 0 ? "***" : value;
	}
	return { ...account, credentials };
}
