/**
 * Claude OAuth 访问令牌刷新 —— 移植自 manager `ClaudeTokenService`。
 * 到期前 5 分钟刷新；同一账号的并发刷新合并成一次；迟到的 401 不能覆盖更新后的令牌。
 */
import type { Account, AccountStore } from "owl-pool";
import { GatewayFault, parseCredentials, UpstreamException } from "owl-pool";

const REFRESH_SKEW_SECONDS = 300;

interface TokenSnapshot {
	credentials: Record<string, unknown>;
	accessToken: string;
	expiresAt: number;
}

export interface ClaudeTokenOptions {
	clientId: string;
	tokenUrl: string;
	fetchImpl?: typeof fetch;
}

export function createClaudeTokenResolver(
	accounts: AccountStore,
	options: ClaudeTokenOptions,
): {
	resolve: (account: Account) => Promise<string>;
	reject: (accountId: string, token: string) => void;
} {
	const inflight = new Map<string, Promise<string>>();
	const rejected = new Map<string, string | null>();

	function resolve(account: Account): Promise<string> {
		const existing = inflight.get(account.id);
		if (existing !== undefined) {
			return existing;
		}
		const job = refreshIfNeeded(accounts, options, account.id, rejected).finally(() => {
			inflight.delete(account.id);
		});
		inflight.set(account.id, job);
		return job;
	}

	function reject(accountId: string, token: string): void {
		const current = rejected.get(accountId);
		if (current !== undefined && current !== null && current !== token) {
			return;
		}
		rejected.set(accountId, token);
	}

	return { resolve, reject };
}

async function refreshIfNeeded(
	accounts: AccountStore,
	options: ClaudeTokenOptions,
	accountId: string,
	rejected: Map<string, string | null>,
): Promise<string> {
	const account = latest(accounts, accountId);
	const credentials = parseCredentials(account);
	if (String(credentials.authType ?? "oauth").toLowerCase() !== "oauth") {
		throw credentialsChanged();
	}
	const stored = snapshot(credentials);
	const blocked = rejected.get(accountId);
	if (usable(stored, blocked)) {
		return stored.accessToken;
	}
	const refreshToken = typeof credentials.refreshToken === "string" ? credentials.refreshToken : "";
	if (refreshToken.length === 0) {
		throw new UpstreamException("AUTH", "CLAUDE 账号缺少 refreshToken");
	}
	const response = await requestToken(options, refreshToken);
	const current = latest(accounts, accountId);
	if (JSON.stringify(parseCredentials(current)) !== JSON.stringify(credentials)) {
		const changed = snapshot(parseCredentials(current));
		if (!usable(changed, rejected.get(accountId))) {
			throw credentialsChanged();
		}
		return changed.accessToken;
	}
	const replacement = replacementOf(credentials, response);
	accounts.updateFields(accountId, { credentials: replacement.credentials }, Date.now());
	if (blocked === undefined || blocked === replacement.accessToken) {
		rejected.delete(accountId);
	}
	return replacement.accessToken;
}

/** 授权码换 token 并写入账号。调用方负责校验 PKCE state。 */
export async function exchangeClaudeAuthorizationCode(
	accounts: AccountStore,
	options: ClaudeTokenOptions & { redirectUri: string },
	accountId: string,
	code: string,
	verifier: string,
	expectedCredentials: string,
): Promise<void> {
	const account = latest(accounts, accountId);
	if (JSON.stringify(account.credentials) !== expectedCredentials) {
		throw new UpstreamException("AUTH", "授权流程已被替换，请重新发起");
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(options.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": "axios/1.13.6" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: options.redirectUri,
			client_id: options.clientId,
			code_verifier: verifier,
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new UpstreamException(
			response.status >= 500 ? "SERVER" : "AUTH",
			`Claude token 端点 HTTP ${response.status}`,
		);
	}
	const body: unknown = await response.json();
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new UpstreamException("SERVER", "Claude token 响应缺少有效 access_token");
	}
	const replacement = replacementOf(parseCredentials(account), body as Record<string, unknown>);
	accounts.updateFields(accountId, { credentials: replacement.credentials }, Date.now());
}

async function requestToken(options: ClaudeTokenOptions, refreshToken: string): Promise<Record<string, unknown>> {
	const fetchImpl = options.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(options.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": "axios/1.13.6" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: options.clientId,
			}),
			signal: AbortSignal.timeout(20_000),
		});
	} catch (error) {
		throw new UpstreamException(
			"SERVER",
			`CLAUDE token 刷新暂不可用: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!response.ok) {
		const kind = response.status === 429 ? "RATE" : response.status >= 500 ? "SERVER" : "AUTH";
		throw new UpstreamException(kind, `Claude token 端点 HTTP ${response.status}`);
	}
	const body: unknown = await response.json();
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new UpstreamException("SERVER", "Claude token 响应缺少有效 access_token");
	}
	return body as Record<string, unknown>;
}

function replacementOf(credentials: Record<string, unknown>, response: Record<string, unknown>): TokenSnapshot {
	const accessToken = typeof response.access_token === "string" ? response.access_token.trim() : "";
	if (accessToken.length === 0) {
		throw new UpstreamException("SERVER", "Claude token 响应缺少有效 access_token");
	}
	const expiresIn = Number(response.expires_in ?? 3600);
	if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new UpstreamException("SERVER", "Claude token 响应过期时间无效");
	}
	const expiresAt = Math.floor(Date.now() / 1000) + Math.trunc(expiresIn);
	const merged: Record<string, unknown> = { ...credentials, authType: "oauth", accessToken, expiresAt };
	if (typeof response.refresh_token === "string" && response.refresh_token.trim().length > 0) {
		merged.refreshToken = response.refresh_token;
	}
	if (typeof response.scope === "string" && response.scope.trim().length > 0) {
		merged.scope = response.scope;
	}
	return { credentials: merged, accessToken, expiresAt };
}

function snapshot(credentials: Record<string, unknown>): TokenSnapshot {
	const accessToken = typeof credentials.accessToken === "string" ? credentials.accessToken : "";
	return { credentials, accessToken, expiresAt: expirySeconds(credentials.expiresAt) };
}

function expirySeconds(value: unknown): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
	if (!Number.isFinite(number) || number <= 0) {
		return 0;
	}
	return number > 1_000_000_000_000 ? Math.floor(number / 1000) : Math.trunc(number);
}

function usable(token: TokenSnapshot, blocked: string | null | undefined): boolean {
	if (token.accessToken.length === 0) {
		return false;
	}
	if (token.expiresAt <= Math.floor(Date.now() / 1000) + REFRESH_SKEW_SECONDS) {
		return false;
	}
	return blocked === undefined || (blocked !== null && blocked !== token.accessToken);
}

function latest(accounts: AccountStore, accountId: string): Account {
	const account = accounts.get(accountId);
	if (account === undefined || account.platform !== "CLAUDE") {
		throw credentialsChanged();
	}
	return account;
}

function credentialsChanged(): GatewayFault {
	return new GatewayFault(409, "account_credentials_changed", "账号凭据已变更，请重试");
}
