/**
 * WorkBuddy accessToken 续期。
 * 官方客户端在登录票被拒时 POST /v2/auth/token/refresh，请求头带 X-Refresh-Token，
 * 不把 refreshToken 放进对话请求。成功后把新的 accessToken / refreshToken 写回账号。
 */
import type { Account, AccountStore } from "owl-pool";
import { parseCredentials, UpstreamException } from "owl-pool";

export interface WorkBuddyTokenOptions {
	accounts: AccountStore;
	baseUrl: string;
	userAgent: string;
	origin: string;
	referer: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export class WorkBuddyTokenService {
	readonly #accounts: AccountStore;
	readonly #baseUrl: string;
	readonly #userAgent: string;
	readonly #origin: string;
	readonly #referer: string;
	readonly #fetchImpl: typeof fetch;
	readonly #now: () => number;
	readonly #inflight = new Map<string, Promise<string>>();

	constructor(options: WorkBuddyTokenOptions) {
		this.#accounts = options.accounts;
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#userAgent = options.userAgent;
		this.#origin = options.origin;
		this.#referer = options.referer;
		this.#fetchImpl = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	/** 用账号上的 refreshToken 换新 accessToken 并落盘。没有续期票或上游拒绝时抛 AUTH。 */
	refresh(account: Account): Promise<string> {
		const pending = this.#inflight.get(account.id);
		if (pending !== undefined) {
			return pending;
		}
		const job = this.#refresh(account).finally(() => {
			this.#inflight.delete(account.id);
		});
		this.#inflight.set(account.id, job);
		return job;
	}

	async #refresh(account: Account): Promise<string> {
		const current = this.#accounts.require(account.id);
		const credentials = parseCredentials(current);
		const refreshToken = text(credentials.refreshToken);
		if (refreshToken === null) {
			throw new UpstreamException("AUTH", "WorkBuddy 账号缺少 refreshToken，无法续期");
		}
		let response: Response;
		try {
			response = await this.#fetchImpl(`${this.#baseUrl}/v2/auth/token/refresh`, {
				method: "POST",
				headers: {
					"X-Refresh-Token": refreshToken,
					"X-Auth-Refresh-Source": "plugin",
					"X-Domain": text(credentials.domain) ?? domainOf(this.#baseUrl),
					Accept: "application/json",
					"Content-Type": "application/json",
					"User-Agent": this.#userAgent,
					Origin: this.#origin,
					Referer: this.#referer,
				},
				body: "{}",
				signal: AbortSignal.timeout(20_000),
			});
		} catch (error) {
			throw new UpstreamException(
				"SERVER",
				`WorkBuddy 凭证续期失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (response.status === 401 || response.status === 403) {
			throw new UpstreamException("AUTH", "WorkBuddy refreshToken 已失效，需要账号主人重新登录后提供新票");
		}
		const body: unknown = await response.json().catch(() => null);
		const payload = authPayload(body);
		if (!response.ok || payload === null) {
			throw new UpstreamException("SERVER", `WorkBuddy 续期接口 HTTP ${response.status}`);
		}
		const accessToken = text(payload.accessToken);
		if (accessToken === null) {
			throw new UpstreamException("SERVER", "WorkBuddy 续期接口未返回 accessToken");
		}
		const next: Record<string, unknown> = { ...credentials, accessToken };
		const rotated = text(payload.refreshToken);
		if (rotated !== null) {
			next.refreshToken = rotated;
		}
		const domain = text(payload.domain);
		if (domain !== null) {
			next.domain = domain;
		}
		const expiresAt = expiryOf(payload, this.#now());
		if (expiresAt !== null) {
			next.expiresAt = expiresAt;
		}
		this.#accounts.updateFields(current.id, { credentials: next }, this.#now());
		if (expiresAt !== null) {
			this.#accounts.patchState(current.id, {
				credentialExpiresAt: expiresAt,
				credentialStatus: "OK",
				credentialMessage: "已用 refreshToken 续期",
				credentialCheckedAt: this.#now(),
			});
		}
		return accessToken;
	}
}

function text(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function domainOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return "www.workbuddy.cn";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 兼容 { data: auth } 与再包一层 data 的响应。 */
function authPayload(body: unknown): Record<string, unknown> | null {
	if (!isRecord(body)) {
		return null;
	}
	const data = isRecord(body.data) ? body.data : body;
	if (typeof data.accessToken === "string") {
		return data;
	}
	return isRecord(data.data) && typeof data.data.accessToken === "string" ? data.data : null;
}

function expiryOf(payload: Record<string, unknown>, now: number): number | null {
	const direct = payload.expiresAt;
	if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
		return direct > 1e12 ? direct : direct * 1000;
	}
	const seconds = payload.expiresIn;
	if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
		return now + seconds * 1000;
	}
	return null;
}
