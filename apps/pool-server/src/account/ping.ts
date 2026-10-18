/**
 * 账号连通性 Ping —— 移植自 manager `AccountPingService`。
 * 各平台打自己的轻量接口，返回 ok、耗时和一句说明。
 */
import type { Account } from "owl-pool";
import { parseCredentials, UpstreamException } from "owl-pool";
import { probeAccount } from "../catalog/discovery.ts";
import { workBuddyToken } from "../catalog/workbuddy-catalog.ts";

export interface PingHooks {
	fetchImpl?: typeof fetch;
	workbuddyBaseUrl: string;
	workbuddyAuthRoots: string[];
	exchangeTraeToken(session: string): Promise<string>;
	/** IDE token 凭证直取/续期；null = 账号没有 IDE 凭证，继续走 session 交换。 */
	resolveTraeJwt?(account: Account): Promise<string | null>;
	codexPing?(account: Account): Promise<string>;
	mimoPing?(account: Account): Promise<string>;
	sdkStatus?(account: Account): Promise<Record<string, unknown>>;
	claudePing?(account: Account): Promise<string>;
	/** accessToken 被拒时用 refreshToken 换新票。 */
	refreshWorkBuddy?(account: Account): Promise<string>;
}

export async function pingAccount(account: Account, hooks: PingHooks): Promise<Record<string, unknown>> {
	const started = Date.now();
	try {
		const message = await messageFor(account, hooks);
		return body(account, true, Date.now() - started, message);
	} catch (error) {
		const message = error instanceof Error && error.message.length > 0 ? error.message : "上游不可达";
		return body(account, false, Date.now() - started, message.slice(0, 200));
	}
}

async function messageFor(account: Account, hooks: PingHooks): Promise<string> {
	switch (account.platform) {
		case "WORKBUDDY":
			return pingWorkBuddy(account, hooks);
		case "TRAE":
			return pingTrae(account, hooks);
		case "CODEX":
			if (hooks.codexPing === undefined) {
				throw new Error("CODEX 的连通性探测还没有接入");
			}
			return hooks.codexPing(account);
		case "CURSOR":
		case "COPILOT":
		case "QODER":
			return pingSdk(account, hooks);
		case "MIMO":
			if (hooks.mimoPing === undefined) {
				throw new Error("MIMO 的连通性探测还没有接入");
			}
			return hooks.mimoPing(account);
		case "CLAUDE":
			if (hooks.claudePing !== undefined) {
				return hooks.claudePing(account);
			}
			return fromProbe(account);
		default:
			return fromProbe(account);
	}
}

async function pingWorkBuddy(account: Account, hooks: PingHooks): Promise<string> {
	const fetchImpl = hooks.fetchImpl ?? fetch;
	let token = await workBuddyAccessToken(account, hooks);
	let response = await postResource(fetchImpl, hooks.workbuddyBaseUrl, token);
	let node = await readJson(response);
	// 登录票被拒时上游仍可能返回 HTTP 200，正文 code 才是 401/403。这种情况也要续期后再探一次。
	if (workBuddyRejected(response, node) && hooks.refreshWorkBuddy !== undefined) {
		token = await hooks.refreshWorkBuddy(account);
		response = await postResource(fetchImpl, hooks.workbuddyBaseUrl, token);
		node = await readJson(response);
	}
	const code = statusCode(node);
	if (code !== 0 && code !== 200) {
		const msg =
			typeof node?.msg === "string"
				? node.msg
				: typeof node?.message === "string"
					? node.message
					: `上游返回 code=${code}`;
		throw new Error(msg);
	}
	return "get-user-resource OK";
}

function workBuddyRejected(response: Response, node: Record<string, unknown> | null): boolean {
	if (response.status === 401 || response.status === 403) {
		return true;
	}
	const code = statusCode(node);
	return code === 401 || code === 403;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	const body: unknown = await response.json().catch(() => null);
	return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
}

function statusCode(node: Record<string, unknown> | null): number {
	const code = node?.code;
	if (typeof code === "number" && Number.isFinite(code)) {
		return code;
	}
	if (typeof code === "string" && code.trim().length > 0) {
		const parsed = Number(code);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return -1;
}

async function workBuddyAccessToken(account: Account, hooks: PingHooks): Promise<string> {
	try {
		return workBuddyToken(account, hooks.workbuddyAuthRoots);
	} catch (error) {
		if (hooks.refreshWorkBuddy === undefined) {
			throw error;
		}
		return hooks.refreshWorkBuddy(account);
	}
}

function postResource(fetchImpl: typeof fetch, baseUrl: string, token: string): Promise<Response> {
	return fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v2/billing/meter/get-user-resource`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "ManagerCheckIn/0.1",
		},
		body: "{}",
		signal: AbortSignal.timeout(20_000),
	});
}

async function pingTrae(account: Account, hooks: PingHooks): Promise<string> {
	let ideFailure: string | null = null;
	if (hooks.resolveTraeJwt !== undefined) {
		try {
			const jwt = await hooks.resolveTraeJwt(account);
			if (jwt !== null) {
				return "Trae IDE 凭证可用";
			}
		} catch (error) {
			// 刷新链路失效时若还有 session 仍可回落；都没有才抛这个更具体的错
			if (error instanceof UpstreamException && error.kind === "AUTH") {
				ideFailure = error.message;
			} else {
				throw error;
			}
		}
	}
	const session = parseCredentials(account).session;
	if (typeof session !== "string" || session.trim().length === 0) {
		if (ideFailure !== null) {
			throw new Error(ideFailure);
		}
		throw new Error("缺少 session");
	}
	try {
		const jwt = await hooks.exchangeTraeToken(session);
		if (jwt.trim().length === 0) {
			throw new Error("GetUserToken 未返回 Token");
		}
	} catch (error) {
		if (error instanceof UpstreamException && error.kind === "AUTH") {
			throw new Error("Trae 登录已失效，请点击重新登录");
		}
		throw error;
	}
	return "GetUserToken OK";
}

async function pingSdk(account: Account, hooks: PingHooks): Promise<string> {
	if (hooks.sdkStatus === undefined) {
		throw new Error(`${account.platform} 的连通性探测还没有接入`);
	}
	const status = await hooks.sdkStatus(account);
	if (status.authenticated !== true) {
		throw new Error(
			typeof status.message === "string" && status.message.length > 0 ? status.message : "官方登录状态无效",
		);
	}
	return "官方登录状态有效";
}

async function fromProbe(account: Account): Promise<string> {
	const probed = await probeAccount(account);
	if (probed.ok !== true) {
		throw new Error(typeof probed.message === "string" ? probed.message : "上游不可达");
	}
	return typeof probed.message === "string" ? probed.message : "模型目录可达";
}

function body(account: Account, ok: boolean, latencyMs: number, message: string): Record<string, unknown> {
	return {
		accountId: account.id,
		accountName: account.name,
		ok,
		latencyMs,
		message,
		occurredAt: new Date().toISOString(),
	};
}
