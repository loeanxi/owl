/**
 * 管理接口鉴权守卫 —— 移植自 manager `AdminAuthFilter` + `AdminGuard`（两层合一）。
 *
 * 覆盖 /api/**（/api/member/** 例外，成员域有独立鉴权）。校验顺序：
 * X-Admin-Key（常量时间比较，未配置视为不可用）→ 会话 Cookie。
 * 匿名白名单写死：login / logout / setup / session 四个精确匹配。
 * enabled=false 的本机自救模式：仅放行 TCP 对端为回环的请求（伪造转发头无效）。
 */
import type { IncomingMessage } from "node:http";
import { readCookie } from "../http/cookies.ts";
import type { AdminAuthService, AdminSecurityConfig, AdminSession } from "./admin-service.ts";
import { isLoopbackAddress } from "./client-ip.ts";
import { constantTimeEquals, sha256Hex } from "./crypto.ts";

/** 管理端匿名白名单（精确匹配，避免新增接口被误放行）。 */
const ANONYMOUS_ADMIN_ENDPOINTS = new Set([
	"/api/admin/login",
	"/api/admin/logout",
	"/api/admin/setup",
	"/api/admin/session",
]);

/** X-Admin-Key 伪造会话的短 TTL（对齐 Java：60 秒占位会话，仅用于本次请求）。 */
const API_KEY_SESSION_TTL_MS = 60_000;

export type AdminGuardResult =
	| { ok: true; admin: AdminSession | null }
	| { ok: false; status: number; code: string; error: string };

export interface AdminGuardOptions {
	config: AdminSecurityConfig;
	service: AdminAuthService;
}

export class AdminGuard {
	readonly #config: AdminSecurityConfig;
	readonly #service: AdminAuthService;

	constructor(options: AdminGuardOptions) {
		this.#config = options.config;
		this.#service = options.service;
	}

	/**
	 * 过滤器层：未通过返回错误（HTTP 层直接渲染）；通过返回已解析会话（可为 null，
	 * 表示匿名白名单端点或自救模式），供 Controller 层与业务读取。
	 */
	check(request: IncomingMessage, path: string): AdminGuardResult {
		if (!path.startsWith("/api/")) {
			return { ok: true, admin: null };
		}
		// 成员空间有独立鉴权；此处只跳过，绝不等同于匿名放行
		if (path.startsWith("/api/member/")) {
			return { ok: true, admin: null };
		}
		if (ANONYMOUS_ADMIN_ENDPOINTS.has(path)) {
			return { ok: true, admin: this.authenticate(request) };
		}
		if (!this.#config.enabled) {
			// 关闭鉴权仅作为本机自救通道：只看 TCP 对端地址
			if (isLoopbackAddress(request.socket.remoteAddress)) {
				return { ok: true, admin: null };
			}
			return {
				ok: false,
				status: 403,
				code: "admin.disabledLoopbackOnly",
				error: "管理端鉴权已关闭（admin.enabled=false），仅允许本机访问管理接口",
			};
		}
		const admin = this.authenticate(request);
		if (admin === null) {
			return {
				ok: false,
				status: 401,
				code: "admin.unauthenticated",
				error: "未认证：请先登录管理台（POST /api/admin/login）",
			};
		}
		return { ok: true, admin };
	}

	/**
	 * Controller 层兜底（纵深防御）：要求已认证会话；自救模式下放行回环对端。
	 * 过滤器已把 X-Admin-Key 解析成占位会话，这里同样放行。
	 */
	requireSession(request: IncomingMessage, admin: AdminSession | null): AdminSession {
		if (admin !== null) {
			return admin;
		}
		if (!this.#config.enabled && isLoopbackAddress(request.socket.remoteAddress)) {
			// 自救模式占位会话
			return {
				tokenHash: "self-rescue",
				username: this.#service.safeUsername(),
				createdAt: 0,
				expiresAt: 0,
				clientIp: "127.0.0.1",
			};
		}
		const error: Error & { code?: string } = new Error("未认证：请先登录");
		error.code = "admin.unauthenticated";
		throw error;
	}

	/** X-Admin-Key → 会话 Cookie，与 Java 过滤器同序。 */
	authenticate(request: IncomingMessage): AdminSession | null {
		return (
			this.authenticateApiKey(request) ?? this.#service.authenticate(readCookie(request, this.#config.cookieName))
		);
	}

	authenticateApiKey(request: IncomingMessage): AdminSession | null {
		const configured = this.#config.apiKey;
		if (configured === undefined || configured.length === 0) {
			return null;
		}
		const presented = request.headers["x-admin-key"];
		if (typeof presented !== "string" || presented.trim().length === 0) {
			return null;
		}
		if (!constantTimeEquals(configured, presented.trim())) {
			return null;
		}
		const now = Date.now();
		return {
			tokenHash: sha256Hex(configured),
			username: this.#service.safeUsername(),
			createdAt: now,
			expiresAt: now + API_KEY_SESSION_TTL_MS,
			clientIp: request.socket.remoteAddress ?? "unknown",
		};
	}
}
