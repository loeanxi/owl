/**
 * 管理员会话 REST —— 移植自 manager `security/admin/AdminAuthController`。
 * 首次设置 / 登录 / 退出 / 改密 / 会话查询；登录成功触发签到补签（不阻塞响应）。
 * 本组端点在守卫匿名白名单内，控制器内部自行做会话/前置状态校验。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CheckInService } from "owl-pool";
import type { AdminGuard } from "../security/admin-guard.ts";
import type { AdminAuthService, AdminSecurityConfig, AdminSession } from "../security/admin-service.ts";
import { isLoopbackAddress, resolveClientIp } from "../security/client-ip.ts";
import { readCookie, writeSessionCookie } from "./cookies.ts";
import { jsonRespond } from "./respond.ts";
import type { Router } from "./router.ts";

export interface AdminRoutesDeps {
	config: AdminSecurityConfig;
	service: AdminAuthService;
	guard: AdminGuard;
	checkin?: CheckInService;
	trustedProxyCount: number;
	logger?(line: string): void;
}

export function registerAdminRoutes(router: Router, deps: AdminRoutesDeps): void {
	const { service, config } = deps;
	const log = deps.logger ?? ((line: string) => console.log(`[admin-api] ${line}`));

	const clientIpOf = (request: IncomingMessage) => resolveClientIp(request, deps.trustedProxyCount);
	const secureOf = (request: IncomingMessage) =>
		config.requireHttps || String(request.headers["x-forwarded-proto"] ?? "").toLowerCase() === "https";
	const setCookie = (response: ServerResponse, token: string, maxAgeSeconds: number, secure: boolean) =>
		writeSessionCookie(response, config.cookieName, token, maxAgeSeconds, secure);

	const sessionBody = (session: AdminSession) => ({
		authenticated: true,
		setupRequired: false,
		username: session.username,
		expiresAt: String(session.expiresAt),
	});

	/** 当前状态：未登录也返回 200，前端据此显示「首次设置」还是「登录」表单；不回显真实用户名。 */
	router.get("/api/admin/session", async (ctx) => {
		const session = service.authenticate(readCookie(ctx.request, config.cookieName));
		const setupRequired = service.isSetupRequired();
		return {
			enabled: service.isEnabled(),
			authenticated: session !== null,
			setupRequired,
			setupTokenRequired: setupRequired && !isLoopbackRequest(ctx.request, deps.trustedProxyCount),
			username: session?.username ?? "",
			expiresAt: session === null ? "" : String(session.expiresAt),
		};
	});

	/** 首次设置管理员用户名与口令；成功后直接登录。 */
	router.post("/api/admin/setup", async (ctx) => {
		if (!service.isEnabled()) {
			respondFail(ctx.response, 400, "admin.disabled", "管理端鉴权未启用（admin.enabled=false）");
			return;
		}
		const clientIp = clientIpOf(ctx.request);
		if (!service.isSetupRequired()) {
			respondFail(ctx.response, 409, "admin.passwordAlreadySet", "管理员口令已设置过，请直接登录");
			return;
		}
		const body = await ctx.readBody<Record<string, unknown>>();
		// Docker 端口转发的 TCP 对端是网桥地址：远程仅凭预配置的高熵令牌完成首次向导
		if (
			!isLoopbackRequest(ctx.request, deps.trustedProxyCount) &&
			!service.isValidSetupToken(asString(body.setupToken))
		) {
			respondFail(
				ctx.response,
				403,
				"admin.setupTokenRequired",
				"请填写安装时生成的初始化令牌，或在服务所在机器通过 localhost 完成首次设置",
			);
			return;
		}
		const username = asString(body.username)?.trim() ?? "";
		if (username.length === 0) {
			respondFail(ctx.response, 400, "admin.usernameRequired", "用户名不能为空");
			return;
		}
		const password = asString(body.password) ?? "";
		if (asString(body.confirmPassword) === undefined || password !== (asString(body.confirmPassword) ?? "")) {
			respondFail(ctx.response, 400, "admin.passwordMismatch", "两次输入的口令不一致");
			return;
		}
		const problem = service.validatePassword(password, username);
		if (problem !== null) {
			respondFail(ctx.response, 400, "admin.passwordTooWeak", problem);
			return;
		}
		const issued = service.setup(username, password, clientIp);
		if (issued === null) {
			respondFail(ctx.response, 409, "admin.setupConflict", "设置失败：口令可能已被其他请求先行设置，请刷新后重试");
			return;
		}
		setCookie(ctx.response, issued.token, service.ttlSeconds(), secureOf(ctx.request));
		return sessionBody(issued.session);
	});

	/** 登录；成功触发补签（后台执行，不阻塞响应）。 */
	router.post("/api/admin/login", async (ctx) => {
		if (!service.isEnabled()) {
			respondFail(ctx.response, 400, "admin.disabled", "管理端鉴权未启用（admin.enabled=false）");
			return;
		}
		if (service.isSetupRequired()) {
			respondFail(ctx.response, 401, "admin.setupRequired", "尚未设置管理员口令，请先完成首次设置");
			return;
		}
		const body = await ctx.readBody<Record<string, unknown>>();
		const username = asString(body.username)?.trim() ?? "";
		const password = asString(body.password) ?? "";
		if (username.length === 0 || password.length === 0) {
			respondFail(ctx.response, 400, "admin.credentialsRequired", "用户名和口令不能为空");
			return;
		}
		const clientIp = clientIpOf(ctx.request);
		const issued = service.login(username, password, clientIp);
		if (issued === null) {
			respondFail(ctx.response, 401, "admin.loginFailed", "用户名或口令错误，或失败次数过多已被临时锁定");
			return;
		}
		setCookie(ctx.response, issued.token, service.ttlSeconds(), secureOf(ctx.request));
		const responseBody = sessionBody(issued.session) as Record<string, unknown>;
		// 登录补签：只统计并后台执行；0 表示没有待补签账号（对齐 Java：>0 才进响应）
		if (deps.checkin !== undefined) {
			try {
				const pending = deps.checkin.countUnsigned();
				if (pending > 0) {
					void deps.checkin.catchUpUnsigned();
					responseBody.catchUpPending = pending;
				}
			} catch (error) {
				log(`登录补签触发失败（忽略）：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return responseBody;
	});

	router.post("/api/admin/logout", async (ctx) => {
		const token = readCookie(ctx.request, config.cookieName);
		const removed = service.logout(token);
		setCookie(ctx.response, "", 0, secureOf(ctx.request));
		log(`管理端退出 removed=${removed}`);
		return { authenticated: false };
	});

	/** 改密（需已登录）；旧会话全部失效并换发新会话。 */
	router.post("/api/admin/password", async (ctx) => {
		const admin = deps.guard.authenticate(ctx.request);
		const session = admin ?? service.authenticate(readCookie(ctx.request, config.cookieName));
		if (session === null) {
			respondFail(ctx.response, 401, "admin.unauthenticated", "未认证：请先登录");
			return;
		}
		const body = await ctx.readBody<Record<string, unknown>>();
		const currentPassword = asString(body.currentPassword);
		const newPassword = asString(body.newPassword);
		if (currentPassword === undefined || newPassword === undefined) {
			respondFail(ctx.response, 400, "admin.passwordFieldsRequired", "请填写当前口令与新口令");
			return;
		}
		const confirmPassword = asString(body.confirmPassword);
		if (confirmPassword !== undefined && newPassword !== confirmPassword) {
			respondFail(ctx.response, 400, "admin.newPasswordMismatch", "两次输入的新口令不一致");
			return;
		}
		const issued = service.changePassword(currentPassword, newPassword, clientIpOf(ctx.request));
		if (issued === null) {
			respondFail(ctx.response, 401, "admin.changePasswordFailed", "修改失败：当前口令不正确，或新口令不符合要求");
			return;
		}
		setCookie(ctx.response, issued.token, service.ttlSeconds(), secureOf(ctx.request));
		return sessionBody(issued.session);
	});
}

function respondFail(response: ServerResponse, status: number, code: string, error: string): void {
	jsonRespond(response, status, { ok: false, error, code });
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** 回环判定对齐 Java：先过 ClientIpResolver（可信代链条下取转发头），再看是否回环。 */
function isLoopbackRequest(request: IncomingMessage, trustedProxyCount: number): boolean {
	return isLoopbackAddress(resolveClientIp(request, trustedProxyCount));
}
