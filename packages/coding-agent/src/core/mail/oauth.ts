import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { GoogleClient } from "./store.ts";
import type { MailAccount, MailAuthStart, MailAuthStatus } from "./types.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export class MailOAuthError extends Error {}

interface AuthorizationSession {
	id: string;
	expiresAt: number;
	status: MailAuthStatus;
	server: Server;
	timer: ReturnType<typeof setTimeout>;
	consumed: boolean;
}

interface AuthorizationOptions {
	client: GoogleClient;
	scopes: string[];
	loginHint?: string;
	authorize: (code: string, redirectUri: string, verifier: string, isActive: () => boolean) => Promise<MailAccount>;
}

export class GoogleMailOAuth {
	private readonly sessions = new Map<string, AuthorizationSession>();
	private readonly now: () => number;
	private readonly ttl: number;

	constructor(now: () => number = Date.now, ttl = 5 * 60_000) {
		this.now = now;
		this.ttl = ttl;
	}

	async start(options: AuthorizationOptions): Promise<MailAuthStart> {
		for (const session of this.sessions.values()) this.expire(session);
		if ([...this.sessions.values()].filter((session) => session.status.state === "pending").length >= 10) {
			throw new Error("请先完成或取消已有邮箱授权。");
		}
		if (this.sessions.size > 100) {
			for (const [id, session] of this.sessions) {
				if (session.status.state !== "pending") this.sessions.delete(id);
				if (this.sessions.size <= 100) break;
			}
		}
		const id = randomUUID();
		const state = randomBytes(32).toString("base64url");
		const verifier = randomBytes(48).toString("base64url");
		const expiresAt = this.now() + this.ttl;
		let redirectUri = "";
		const server = createServer(async (request, response) => {
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("X-Content-Type-Options", "nosniff");
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (request.method !== "GET" || url.pathname !== "/oauth2callback") {
				response.writeHead(404).end("Not found");
				return;
			}
			const session = this.sessions.get(id);
			if (!session) {
				response.writeHead(410).end("Authorization expired");
				return;
			}
			this.expire(session);
			if (url.searchParams.get("state") !== state) {
				response.writeHead(400).end("Invalid authorization state");
				return;
			}
			if (session.status.state !== "pending" || session.consumed) {
				response.writeHead(410).end("Authorization already completed");
				return;
			}
			const code = url.searchParams.get("code");
			if (url.searchParams.has("error") || !code) {
				this.finish(session, { state: "failed", error: "Google 授权未完成，请重新连接邮箱。" });
				response.writeHead(400).end("授权未完成，请返回 OWL 重新连接。");
				return;
			}
			session.consumed = true;
			try {
				const account = await options.authorize(
					code,
					redirectUri,
					verifier,
					() => session.status.state === "pending" && this.now() < session.expiresAt,
				);
				if (session.status.state !== "pending" || this.now() >= session.expiresAt) {
					this.expire(session);
					response.writeHead(410).end("授权已取消或过期，请返回 OWL。");
					return;
				}
				this.finish(session, { state: "complete", account });
				response.end("邮箱已连接，可以关闭此页面并返回 OWL。");
			} catch (error) {
				if (session.status.state === "pending") {
					this.finish(session, {
						state: "failed",
						error: error instanceof MailOAuthError ? error.message : "邮箱授权失败，请检查 Google 配置后重试。",
					});
				}
				response.writeHead(400).end("邮箱连接失败，请返回 OWL 查看提示。");
			}
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", () => reject(new Error("无法启动本机邮箱授权监听器。")));
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("无法获取本机邮箱授权地址。");
		}
		redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
		const session: AuthorizationSession = {
			id,
			expiresAt,
			status: { state: "pending" },
			server,
			consumed: false,
			timer: setTimeout(
				() => this.finish(session, { state: "failed", error: "授权链接已过期，请重新连接邮箱。" }),
				this.ttl,
			),
		};
		session.timer.unref();
		server.unref();
		this.sessions.set(id, session);
		const authorizationUrl = new URL(GOOGLE_AUTH_URL);
		authorizationUrl.search = new URLSearchParams({
			client_id: options.client.clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: [...new Set(options.scopes)].join(" "),
			state,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			access_type: "offline",
			prompt: "consent select_account",
			...(options.loginHint ? { login_hint: options.loginHint } : {}),
		}).toString();
		return {
			authId: id,
			authorizationUrl: authorizationUrl.toString(),
			expiresAt: new Date(expiresAt).toISOString(),
		};
	}

	status(id: string): MailAuthStatus {
		const session = this.sessions.get(id);
		if (!session) throw new Error("邮箱授权请求不存在，请重新连接。");
		this.expire(session);
		return structuredClone(session.status);
	}

	cancel(id: string): MailAuthStatus {
		const session = this.sessions.get(id);
		if (!session) throw new Error("邮箱授权请求不存在。");
		if (session.status.state === "pending") this.finish(session, { state: "cancelled" });
		return structuredClone(session.status);
	}

	async dispose(): Promise<void> {
		await Promise.all(
			[...this.sessions.values()].map(async (session) => {
				clearTimeout(session.timer);
				if (session.status.state === "pending") session.status = { state: "cancelled" };
				session.server.closeAllConnections();
				if (session.server.listening) await new Promise<void>((resolve) => session.server.close(() => resolve()));
			}),
		);
		this.sessions.clear();
	}

	private expire(session: AuthorizationSession): void {
		if (session.status.state === "pending" && this.now() >= session.expiresAt) {
			this.finish(session, { state: "failed", error: "授权链接已过期，请重新连接邮箱。" });
		}
	}

	private finish(session: AuthorizationSession, status: MailAuthStatus): void {
		if (session.status.state !== "pending") return;
		session.status = status;
		clearTimeout(session.timer);
		session.server.close();
		session.server.closeIdleConnections();
	}
}
