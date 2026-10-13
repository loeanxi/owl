/**
 * Trae IDE 凭证链路 —— 用 Trae CN 桌面版导出的 {token, refreshToken, userId}
 * 直接充当 Cloud-IDE-JWT；临期或 401 时调 ExchangeToken 续期并把轮换结果写回账号。
 * 没有 IDE 凭证（只有 session）的账号不受影响，调用方回落到原有的会话交换。
 *
 * 导入方式见 D:\developTool\wb-decrypt\decrypt_trae_token.py（批量解密本机 Trae 系 IDE）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Account, AccountStore } from "owl-pool";
import { asString, parseCredentials, UpstreamException } from "owl-pool";
import { decryptTcValue, TRAE_AUTH_KEY } from "./trae-local.ts";

export const TRAE_EXCHANGE_URL = "https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken";
/** Trae CN 客户端内置的公共 ClientID（随客户端分发，非私密）。 */
export const TRAE_EXCHANGE_CLIENT_ID = "ono9krqynydwx5";
/** 临期提前量：标记过期前 5 分钟就开始换新，避免临界请求带旧 token。 */
const FRESH_MARGIN_MS = 5 * 60_000;

export interface TraeTokenOptions {
	accounts: AccountStore;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export function traeIdeToken(credentials: Record<string, unknown>): string | null {
	return asString(credentials.token)?.trim() || null;
}

export function traeTokenExpiresAt(credentials: Record<string, unknown>): number | null {
	const raw = credentials.expiredAt;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return raw > 10_000_000_000 ? raw : raw * 1000;
	}
	if (typeof raw === "string" && raw.trim().length > 0) {
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

/** 是否具备可续期的 IDE 凭证（refreshToken 必备）。 */
export function traeIdeRefreshable(credentials: Record<string, unknown>): boolean {
	return (asString(credentials.refreshToken)?.trim().length ?? 0) > 0;
}

export function traeStorageFile(credentials: Record<string, unknown>): string | null {
	return asString(credentials.storageFile)?.trim() || null;
}

/** 读本机 storage.json（tc 加密）并解出当前 token——storageFile 模式每次使用都取最新，续期归 IDE。 */
export function readStorageFileToken(path: string): { token: string; expiredAt: number | null } {
	const resolved = path.replace(/^~(?=$|[/\\])/, join(process.env.USERPROFILE ?? process.env.HOME ?? "", ""));
	if (!existsSync(resolved)) {
		throw new UpstreamException("AUTH", `storageFile 文件不存在: ${path}`);
	}
	let blob: unknown;
	try {
		const store = JSON.parse(readFileSync(resolved, "utf-8")) as Record<string, unknown>;
		blob = store[TRAE_AUTH_KEY];
	} catch (error) {
		throw new UpstreamException(
			"AUTH",
			`storageFile 读取失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof blob !== "string" || blob.trim().length === 0) {
		throw new UpstreamException("AUTH", "storageFile 里没有 Trae 登录凭证（IDE 未登录）");
	}
	const auth = decryptTcValue(blob);
	const token = typeof auth.token === "string" ? auth.token.trim() : "";
	if (token.length === 0) {
		throw new UpstreamException("AUTH", "storageFile 凭证里没有 token");
	}
	const stamp =
		auth.expiredAt === null || auth.expiredAt === undefined ? null : new Date(auth.expiredAt as string | number);
	return { token, expiredAt: stamp !== null && !Number.isNaN(stamp.getTime()) ? stamp.getTime() : null };
}

interface ExchangeResult {
	Token: unknown;
	RefreshToken: unknown;
	TokenExpireAt: unknown;
}

export class TraeTokenService {
	readonly #accounts: AccountStore;
	readonly #fetchImpl: typeof fetch;
	readonly #now: () => number;

	constructor(options: TraeTokenOptions) {
		this.#accounts = options.accounts;
		this.#fetchImpl = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * 解析可用的 Cloud-IDE-JWT。没有 IDE token 返回 null（调用方回落 session 交换）；
	 * token 临期/过期时自动用 refreshToken 续期并落盘；续期失败抛 AUTH。
	 * storageFile 模式（跟随本机 IDE）：每次读文件取最新 token，续期归 IDE，这里不主动刷新。
	 */
	async resolveJwt(account: Account): Promise<string | null> {
		const credentials = parseCredentials(account);
		const storageFile = traeStorageFile(credentials);
		if (storageFile !== null) {
			const live = readStorageFileToken(storageFile);
			if (live.expiredAt === null || live.expiredAt - FRESH_MARGIN_MS > this.#now()) {
				return live.token;
			}
			throw new UpstreamException("AUTH", "storageFile 里的 token 已过期，请先在 Trae CN 里重新登录");
		}
		const token = traeIdeToken(credentials);
		if (token === null) {
			return null;
		}
		const expiresAt = traeTokenExpiresAt(credentials);
		if (expiresAt === null || expiresAt - FRESH_MARGIN_MS > this.#now()) {
			return token;
		}
		return this.refresh(account);
	}

	/** 强制用 refreshToken 换新 token 并写回账号；失败抛 AUTH。 */
	async refresh(account: Account): Promise<string> {
		// 重新读取，避免用调用方持有的旧快照覆盖并发写入的凭证
		const current = this.#accounts.require(account.id);
		const credentials = parseCredentials(current);
		const refreshToken = asString(credentials.refreshToken)?.trim();
		if (refreshToken === undefined || refreshToken.length === 0) {
			throw new UpstreamException("AUTH", "Trae 账号缺少 refreshToken，请从 Trae CN 重新导入");
		}
		const userId = asString(credentials.userId)?.trim() ?? "";
		const host = (asString(credentials.host)?.trim() || "https://api.trae.cn").replace(/\/+$/, "");
		let response: Response;
		try {
			response = await this.#fetchImpl(`${host}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					ClientID: TRAE_EXCHANGE_CLIENT_ID,
					RefreshToken: refreshToken,
					ClientSecret: "-",
					UserID: userId,
				}),
				signal: AbortSignal.timeout(20_000),
			});
		} catch (error) {
			throw new UpstreamException(
				"SERVER",
				`Trae 凭证续期失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (response.status === 401 || response.status === 403) {
			throw new UpstreamException("AUTH", "Trae refreshToken 已失效，请从 Trae CN 重新导入");
		}
		if (!response.ok) {
			throw new UpstreamException("SERVER", `ExchangeToken HTTP ${response.status}`);
		}
		const parsed: unknown = await response.json().catch(() => null);
		const result =
			parsed !== null && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).Result === "object"
				? ((parsed as Record<string, unknown>).Result as ExchangeResult)
				: null;
		if (result === null) {
			throw new UpstreamException("SERVER", "ExchangeToken 未返回 Token");
		}
		const token = typeof result.Token === "string" ? result.Token.trim() : "";
		if (token.length === 0) {
			throw new UpstreamException("SERVER", "ExchangeToken 未返回 Token");
		}
		const next: Record<string, unknown> = { ...credentials, token };
		if (typeof result.RefreshToken === "string" && result.RefreshToken.trim().length > 0) {
			next.refreshToken = result.RefreshToken.trim();
		}
		if (result.TokenExpireAt !== null && result.TokenExpireAt !== undefined) {
			const stamp = new Date(result.TokenExpireAt as string | number);
			if (!Number.isNaN(stamp.getTime())) {
				next.expiredAt = stamp.toISOString();
			}
		}
		this.#accounts.updateFields(current.id, { credentials: next }, this.#now());
		const expires = traeTokenExpiresAt(next);
		if (expires !== null) {
			this.#accounts.patchState(current.id, { credentialExpiresAt: expires });
		}
		return token;
	}
}
