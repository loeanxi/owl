/**
 * WorkBuddy（CodeBuddy）每日签到 —— 移植自 manager
 * `checkin/provider/WorkBuddyApiClient` + `WorkBuddyCheckInProvider`。
 * 凭证：{"accessToken":"..."} 或 {"authFile":"C:/path/workbuddy-desktop.info"}
 * 流程：查状态 → 未签则领取；响应信封多形态，全部宽松解析。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { Account } from "../../account/types.ts";
import { asString, parseCredentials } from "../../account/types.ts";
import { envelopeCode, envelopeText, findDeep, hasFlag, hasText } from "../../common/json.ts";
import { describeUpstreamError, UpstreamHttpError } from "../../common/upstream.ts";
import type { Platform } from "../../platform.ts";
import type { CheckInProvider } from "../provider.ts";
import {
	type CheckInResult,
	checkInAlready,
	checkInAuthError,
	checkInFailed,
	checkInInactive,
	checkInSuccess,
} from "../types.ts";

const DEFAULT_BASE_URL = "https://copilot.tencent.com";
/** 官方桌面应用的凭据文件名：读取白名单的默认通道。 */
const ARTIFACT_FILE_NAME = "workbuddy-desktop.info";
const USER_AGENT = "ManagerCheckIn/0.1";

export interface WorkBuddyProviderOptions {
	/** 上游基址，默认 https://copilot.tencent.com。 */
	baseUrl?: string;
	/**
	 * authFile 读取白名单目录（对齐 manager.platform.workbuddy.auth-file-roots）：
	 * 仅接受官方文件名，或白名单目录内的文件——路径由管理员录入，
	 * 不加限制等于开放进程内任意文件读取。
	 */
	authFileRoots?: string[];
	fetchImpl?: typeof fetch;
}

/** 查询今日签到状态（只读）。 */
async function checkinStatus(options: ResolvedOptions, accessToken: string): Promise<unknown> {
	return postWithAuth(options, "/v2/billing/meter/checkin-activity-status", accessToken);
}

/** 领取每日签到积分（幂等：已签只会返回已签状态）。 */
async function dailyCheckIn(options: ResolvedOptions, accessToken: string): Promise<unknown> {
	return postWithAuth(options, "/v2/billing/meter/daily-checkin", accessToken);
}

interface ResolvedOptions {
	baseUrl: string;
	authFileRoots: string[];
	fetchImpl: typeof fetch;
}

function resolveOptions(options: WorkBuddyProviderOptions): ResolvedOptions {
	return {
		baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
		authFileRoots: (options.authFileRoots ?? []).map((root) => normalize(root)),
		fetchImpl: options.fetchImpl ?? fetch,
	};
}

/** 通用鉴权 POST；业务错误码也回 JSON（如 code=10001 今天已签到），交上层解析。 */
async function postWithAuth(options: ResolvedOptions, path: string, accessToken: string): Promise<unknown> {
	let response: Response;
	try {
		response = await options.fetchImpl(`${options.baseUrl}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
			},
			body: "{}",
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		if (error instanceof UpstreamHttpError) {
			throw error;
		}
		throw new Error(`WorkBuddy 请求失败: ${describeUpstreamError(error)}`);
	}
	const text = await response.text();
	if (!response.ok && text.trim().length === 0) {
		throw new UpstreamHttpError(response.status, `WorkBuddy HTTP ${response.status}`);
	}
	return parseBody(text);
}

function parseBody(text: string | null): unknown {
	if (text === null || text.trim().length === 0) {
		throw new Error("WorkBuddy 响应为空（可能被网关拦截或 token 无效）");
	}
	const trimmed = text.trim();
	if (trimmed.startsWith("<")) {
		const snippet = trimmed.replaceAll(/\s+/g, " ").slice(0, 160);
		throw new Error(`WorkBuddy 返回 HTML 而非 JSON（token 失效/被拦截）: ${snippet}`);
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		const snippet = trimmed.replaceAll(/\s+/g, " ").slice(0, 160);
		throw new Error(`WorkBuddy 响应解析失败: ${snippet}`);
	}
}

/**
 * 从本地 workbuddy-desktop.info 读取 accessToken（明文字段）。
 * 加密信封（$wbEncrypted 打头的字段）本版本不处理，返回 null 交由上层报 AUTH_ERROR。
 */
export function readAccessTokenFromFile(authFile: string, authFileRoots: string[] = []): string | null {
	const path = normalize(isAbsolute(authFile) ? authFile : join(process.cwd(), authFile));
	ensureAllowedLocation(path, authFileRoots);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`读取凭据文件失败: ${authFile}（${describeUpstreamError(error)}）`);
	}
	let root: unknown;
	try {
		root = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (root === null || typeof root !== "object") {
		return null;
	}
	const record = root as Record<string, unknown>;
	const direct = record.accessToken;
	if (typeof direct === "string" && direct.trim().length > 0 && !direct.startsWith("$")) {
		return direct;
	}
	// 兼容嵌套 session 结构
	const session = record.session;
	if (session !== null && typeof session === "object") {
		const nested = (session as Record<string, unknown>).accessToken;
		if (typeof nested === "string" && nested.trim().length > 0 && !nested.startsWith("$")) {
			return nested;
		}
	}
	return null;
}

/** 只放行官方凭据文件名或白名单目录内的路径。 */
function ensureAllowedLocation(path: string, authFileRoots: string[]): void {
	const lower = path.replaceAll("\\", "/").toLowerCase();
	if (lower.endsWith(`/${ARTIFACT_FILE_NAME}`) || lower === ARTIFACT_FILE_NAME) {
		return;
	}
	for (const root of authFileRoots) {
		const rel = relative(normalize(root), path);
		if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
			return;
		}
	}
	throw new Error(`凭据文件路径不被允许：${path}。仅接受 ${ARTIFACT_FILE_NAME}，或 authFileRoots 白名单目录内的文件`);
}

export class WorkBuddyCheckInProvider implements CheckInProvider {
	readonly #options: ResolvedOptions;

	constructor(options: WorkBuddyProviderOptions = {}) {
		this.#options = resolveOptions(options);
	}

	supports(): Platform {
		return "WORKBUDDY";
	}

	async checkIn(account: Account): Promise<CheckInResult> {
		const credentials = parseCredentials(account);
		const accessToken = this.resolveAccessToken(credentials);
		if (!accessToken) {
			return checkInAuthError("无法解析 accessToken（文件缺失、加密信封不支持或字段为空）");
		}
		try {
			const status = await checkinStatus(this.#options, accessToken);
			if (isAuthError(status)) {
				return checkInAuthError("WorkBuddy 会话无效或已过期");
			}
			if (alreadyCheckedIn(status)) {
				return checkInAlready("今日已签到", extractCredits(status));
			}
			if (isInactive(status)) {
				return checkInInactive("签到活动未开启");
			}

			const claim = await dailyCheckIn(this.#options, accessToken);
			if (isAuthError(claim)) {
				return checkInAuthError("WorkBuddy 会话无效或已过期");
			}
			if (alreadyCheckedIn(claim)) {
				return checkInAlready("今日已签到", extractCredits(claim));
			}
			if (isInactive(claim)) {
				return checkInInactive("签到活动未开启");
			}

			const credits = extractCredits(claim);
			const message = envelopeText(claim, ["message", "report", "msg"]) ?? null;
			if (isSuccess(claim)) {
				return checkInSuccess(message ?? "签到成功", credits);
			}
			return checkInFailed(message ?? "签到失败", JSON.stringify(claim));
		} catch (error) {
			return checkInFailed(`WorkBuddy 签到失败: ${describeUpstreamError(error)}`, null);
		}
	}

	private resolveAccessToken(credentials: Record<string, unknown>): string | null {
		const direct = asString(credentials.accessToken);
		if (direct && direct.trim().length > 0 && !direct.startsWith("$")) {
			return direct;
		}
		const file = asString(credentials.authFile);
		if (file && file.trim().length > 0) {
			return readAccessTokenFromFile(file, this.#options.authFileRoots);
		}
		return null;
	}
}

/** 401，或 403 且整体文本带鉴权关键字（移植 Java 的 401 || 403&&hasText 优先级）。 */
function isAuthError(node: unknown): boolean {
	const code = envelopeCode(node);
	return code === 401 || (code === 403 && hasText(node, ["unauthorized", "auth", "token"]));
}

function alreadyCheckedIn(node: unknown): boolean {
	if (
		hasFlag(node, ["already_checked_in", "alreadyCheckedIn", "checked_in", "checkedIn"]) &&
		!hasFlag(node, ["claimed", "success"])
	) {
		return true;
	}
	if (envelopeCode(node) === 10001) {
		return true;
	}
	const message = envelopeText(node, ["message", "report", "msg", "status"]);
	return message !== undefined && (message.includes("已签") || message.toLowerCase().includes("already"));
}

function isInactive(node: unknown): boolean {
	const message = envelopeText(node, ["message", "report", "msg"]);
	if (
		message !== undefined &&
		(message.includes("未开启") || message.includes("非签到") || message.toLowerCase().includes("inactive"))
	) {
		return true;
	}
	return envelopeCode(node) === 404;
}

function isSuccess(node: unknown): boolean {
	if (hasFlag(node, ["success", "claimed", "checked_in", "checkedIn"])) {
		return true;
	}
	const code = envelopeCode(node);
	return code === 0 || code === 200;
}

function extractCredits(node: unknown): number | null {
	const keys = ["credits", "credit", "points", "reward", "amount", "todayCredits"];
	for (const key of keys) {
		const value = findDeep(node, [key]);
		if (typeof value === "number") {
			return Math.trunc(value);
		}
		if (typeof value === "string") {
			const parsed = Number.parseInt(value.replace(/[^0-9-]/g, ""), 10);
			if (!Number.isNaN(parsed)) {
				return parsed;
			}
		}
	}
	return null;
}
