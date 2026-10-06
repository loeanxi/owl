/**
 * Trae 每日积分签到 —— 移植自 manager
 * `checkin/provider/TraeApiClient` + `TraeCheckInProvider`。
 * 凭证：{"session":"<X-Cloudide-Session>","deviceId":"<可选 16 位数字>"}
 * 流程：Cookie 换 JWT → JWT 调积分领取；命中 9074 风控换随机设备号重试（最多 5 次）。
 */
import type { Account } from "../../account/types.ts";
import { asInt, asString, parseCredentials } from "../../account/types.ts";
import { randomInt, sleep } from "../../common/business-time.ts";
import { describeUpstreamError, UpstreamHttpError } from "../../common/upstream.ts";
import type { Platform } from "../../platform.ts";
import type { CheckInProvider } from "../provider.ts";
import { type CheckInResult, checkInAlready, checkInAuthError, checkInFailed, checkInSuccess } from "../types.ts";

const DEFAULT_BASE_URL = "https://api.trae.cn";
/** 9074 风控重试上限（含首次）。 */
const MAX_RISK_RETRY = 5;
const USER_AGENT = "ManagerCheckIn/0.1";

export interface TraeProviderOptions {
	/** 上游基址，默认 https://api.trae.cn。 */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** 可注入随机源（测试用）。 */
	randomDeviceIdImpl?: () => string;
	/** 可注入 sleep（测试不等真实退避）。 */
	sleepImpl?: (ms: number) => Promise<void>;
}

interface ResolvedTraeOptions {
	baseUrl: string;
	fetchImpl: typeof fetch;
	randomDeviceIdImpl: () => string;
	sleepImpl: (ms: number) => Promise<void>;
}

/** 16 位随机数字设备号（对齐 Java randomDeviceId：1e15 + nextLong(9e15)）。 */
export function randomDeviceId(): string {
	return String(BigInt(1_000_000_000_000_000) + BigInt(Math.floor(Math.random() * 9_000_000_000_000_000)));
}

export class TraeCheckInProvider implements CheckInProvider {
	readonly #options: ResolvedTraeOptions;

	constructor(options: TraeProviderOptions = {}) {
		this.#options = {
			baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
			fetchImpl: options.fetchImpl ?? fetch,
			randomDeviceIdImpl: options.randomDeviceIdImpl ?? randomDeviceId,
			sleepImpl: options.sleepImpl ?? sleep,
		};
	}

	supports(): Platform {
		return "TRAE";
	}

	async checkIn(account: Account): Promise<CheckInResult> {
		const credentials = parseCredentials(account);
		const session = asString(credentials.session);
		if (!session || session.trim().length === 0) {
			return checkInAuthError("缺少 session（X-Cloudide-Session）");
		}
		const deviceId = asString(credentials.deviceId)?.trim() || this.#options.randomDeviceIdImpl();
		try {
			const jwt = await this.exchangeToken(session);
			try {
				const body = await this.claimWithRiskRetry(jwt, deviceId);
				return this.interpret(body);
			} catch (error) {
				const msg = describeUpstreamError(error);
				return checkInFailed(`Trae 签到失败: ${msg}`, msg);
			}
		} catch (error) {
			const msg = describeUpstreamError(error);
			const authRejected = error instanceof UpstreamHttpError && (error.status === 401 || error.status === 403);
			return authRejected
				? checkInAuthError("Trae 登录已失效，请在账号行点击「重新登录」")
				: checkInFailed(`Trae 登录令牌获取失败: ${msg}`, msg);
		}
	}

	/** 会话 Cookie 换 Cloud-IDE-JWT。 */
	private async exchangeToken(session: string): Promise<string> {
		const body = await this.postRaw(
			"/cloudide/api/v3/common/GetUserToken",
			{
				Cookie: `X-Cloudide-Session=${session}`,
				Referer: "https://www.trae.cn/",
				Origin: "https://www.trae.cn",
				Accept: "application/json, text/plain, */*",
			},
			"",
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(body === "" ? "{}" : body) as unknown;
		} catch {
			throw new Error(`GetUserToken 响应解析失败: ${truncate(body, 200)}`);
		}
		const token = findToken(parsed);
		if (typeof token === "string" && token.trim().length > 0) {
			return token;
		}
		throw new Error(`GetUserToken 未返回 Token: ${truncate(body, 200)}`);
	}

	/** 领取积分，返回原始 JSON（含 code / checked_in / credits / message）。 */
	private async claimCheckIn(jwt: string, deviceId: string): Promise<Record<string, unknown>> {
		const body = await this.postRaw(
			"/trae/api/v2/ug/checkin_credits/claim",
			{
				Authorization: `Cloud-IDE-JWT ${jwt}`,
				"X-User-Region": "cn",
				"x-device-id": deviceId,
			},
			"{}",
		);
		try {
			const parsed = JSON.parse(body === "" ? "{}" : body) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			throw new Error(`签到响应解析失败: ${truncate(body, 200)}`);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("签到响应解析失败")) {
				throw error;
			}
			throw new Error(`签到响应解析失败: ${truncate(body, 200)}`);
		}
	}

	/** 命中 9074 风控换设备号重试，最多 MAX_RISK_RETRY 次；结果带 _deviceIdUsed。 */
	private async claimWithRiskRetry(jwt: string, deviceId: string): Promise<Record<string, unknown>> {
		let currentDevice = deviceId;
		let result = await this.claimCheckIn(jwt, currentDevice);
		let attempt = 1;
		while (isRiskCode(result) && attempt < MAX_RISK_RETRY) {
			currentDevice = this.#options.randomDeviceIdImpl();
			attempt++;
			await this.#options.sleepImpl(800 + randomInt(0, 700));
			result = await this.claimCheckIn(jwt, currentDevice);
		}
		return { ...result, _deviceIdUsed: currentDevice };
	}

	private async postRaw(path: string, headers: Record<string, string>, body: string): Promise<string> {
		let response: Response;
		try {
			response = await this.#options.fetchImpl(`${this.#options.baseUrl}${path}`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json", "User-Agent": USER_AGENT },
				body,
				signal: AbortSignal.timeout(20_000),
			});
		} catch (error) {
			if (error instanceof UpstreamHttpError) {
				throw error;
			}
			throw new Error(describeUpstreamError(error));
		}
		// Java 侧 RestClient 对非 2xx 直接抛异常（无 body 回退），这里保持一致
		if (!response.ok) {
			throw new UpstreamHttpError(response.status, `Trae HTTP ${response.status}（${path}）`);
		}
		return response.text();
	}

	/** 判定领取结果（移植 Java interpret；注意 code==0 优先于「已签无积分」的 already 分支）。 */
	private interpret(body: Record<string, unknown>): CheckInResult {
		const code = asInt(body.code, -1);
		const checkedIn = body.checked_in === true;
		const credits = body.credits === null || body.credits === undefined ? null : asInt(body.credits, 0);
		const message = asString(body.message) ?? null;

		if (code === 0 || checkedIn) {
			if (checkedIn && (credits === null || credits === 0) && code !== 0) {
				return checkInAlready("今日已签到", credits);
			}
			return checkInSuccess(message ?? "签到成功", credits);
		}
		if (code === 9074) {
			return checkInFailed(
				"命中风控 9074（参与用户太多），可稍后再试或更换 deviceId",
				truncate(JSON.stringify(body), 400),
			);
		}
		return checkInFailed(message ?? `签到失败 code=${code}`, truncate(JSON.stringify(body), 400));
	}
}

function findToken(node: unknown): unknown {
	if (node === null || typeof node !== "object") {
		return undefined;
	}
	const record = node as Record<string, unknown>;
	const result = record.Result;
	if (result !== null && typeof result === "object") {
		return (result as Record<string, unknown>).Token;
	}
	return undefined;
}

/** Java 侧用字符串比较风控码（上游可能回字符串 code）。 */
function isRiskCode(result: Record<string, unknown>): boolean {
	const code = result.code;
	return code !== null && code !== undefined && String(code) === "9074";
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}
