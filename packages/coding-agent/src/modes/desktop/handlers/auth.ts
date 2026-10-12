/**
 * owl desktop bridge — 认证域 handler（auth.providers / auth.login / prompt / cancel 与 Cursor 多账号）。
 *
 * 从 serve.ts 原样搬迁：进行中的登录状态随域外移为 AuthLoginState，
 * 共享闭包（reply / broadcast / defaultAgentDir / getListingServices）改为显式上下文注入，逻辑零改动。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { AgentSessionServices } from "../../../core/agent-session-services.ts";
import { AuthStorage } from "../../../core/auth-storage.ts";
import {
	credentialFromAccount,
	listCursorAccountsPublic,
	removeCursorAccount,
	switchCursorAccount,
	upsertCursorAccount,
} from "../cursor-accounts.ts";
import type { DesktopClientRequest, DesktopServerMessage } from "../protocol.ts";

type Reply = (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;

/** 进行中的登录（auth.login 长请求）与其待回答的界面提问；整个桥进程共享一份。 */
export interface AuthLoginState {
	activeLogin: { controller: AbortController } | null;
	pendingPrompt: {
		ask: { type: string; message?: string; placeholder?: string; options?: readonly { id: string; label: string }[] };
		resolve: (value: string) => void;
		reject: (error: Error) => void;
	} | null;
}

export function createAuthLoginState(): AuthLoginState {
	return { activeLogin: null, pendingPrompt: null };
}

export interface AuthHandlerContext {
	reply: Reply;
	broadcast: (message: DesktopServerMessage) => void;
	defaultAgentDir: () => string;
	getListingServices: () => Promise<AgentSessionServices>;
	login: AuthLoginState;
}

/** 打开系统默认浏览器（OAuth 授权用）。 */
function openInBrowser(url: string): void {
	try {
		spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// 打不开就让用户手动复制链接（URL 会通过事件广播给 UI）
	}
}

/** Auth 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type AuthRequest = Extract<
	DesktopClientRequest,
	{
		type:
			| "auth.providers"
			| "cursor.accounts.list"
			| "cursor.accounts.switch"
			| "cursor.accounts.remove"
			| "auth.login"
			| "auth.prompt.respond"
			| "auth.cancel";
	}
>;

export async function handleAuthRequest(ws: WebSocket, request: AuthRequest, ctx: AuthHandlerContext): Promise<void> {
	const login = ctx.login;
	switch (request.type) {
		case "auth.providers": {
			// 内置厂商目录（供桌面下拉选择）：id / 显示名 / 支持的认证方式
			const services = await ctx.getListingServices();
			const result = services.modelRuntime.getProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				oauth: Boolean(provider.auth?.oauth),
				apiKey: Boolean(provider.auth?.apiKey),
			}));
			ctx.reply(ws, request.id, { ok: true, result });
			return;
		}
		case "cursor.accounts.list": {
			ctx.reply(ws, request.id, { ok: true, result: listCursorAccountsPublic(ctx.defaultAgentDir()) });
			return;
		}
		case "cursor.accounts.switch": {
			try {
				const agentDir = ctx.defaultAgentDir();
				const account = switchCursorAccount(agentDir, request.accountId);
				const credential = credentialFromAccount(account);
				const storage = AuthStorage.create(join(agentDir, "auth.json"));
				await storage.modify("cursor", async () => credential);
				const services = await ctx.getListingServices();
				await services.modelRuntime.refresh({ providers: ["cursor"], allowNetwork: !process.env.PI_OFFLINE });
				ctx.reply(ws, request.id, { ok: true, result: listCursorAccountsPublic(agentDir) });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "cursor.accounts.remove": {
			try {
				const agentDir = ctx.defaultAgentDir();
				const next = removeCursorAccount(agentDir, request.accountId);
				const storage = AuthStorage.create(join(agentDir, "auth.json"));
				if (next.activeId) {
					const account = next.accounts.find((entry) => entry.id === next.activeId);
					if (account) {
						await storage.modify("cursor", async () => credentialFromAccount(account));
					}
				} else {
					await (await ctx.getListingServices()).modelRuntime.logout("cursor");
				}
				const services = await ctx.getListingServices();
				await services.modelRuntime.refresh({ providers: ["cursor"], allowNetwork: !process.env.PI_OFFLINE });
				ctx.reply(ws, request.id, { ok: true, result: listCursorAccountsPublic(agentDir) });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "auth.login": {
			// pi /login 的桌面版：oauth 走浏览器（notify 里开浏览器 + 广播进度），api_key 直接落 auth.json。
			// 流程中的提问（AuthPrompt）转发到界面，由 auth.prompt.respond 带回答案。
			// 用户换厂商重新登录 = 自动放弃上一个（否则旧回调服务器挂着，新流程会卡死）。
			if (login.activeLogin) {
				login.pendingPrompt?.reject(new Error("登录已取消"));
				login.pendingPrompt = null;
				login.activeLogin.controller.abort();
			}
			const services = await ctx.getListingServices();
			const controller = new AbortController();
			login.activeLogin = { controller };
			// GitHub Copilot 的第一个提问是「企业域名」：桌面默认替用户答空串（github.com）
			// 直接拉起浏览器；enterprise=true（界面勾选企业版）时才转发给界面。
			const enterpriseMode = request.enterprise === true;
			try {
				const credential = await services.modelRuntime.login(request.provider, request.authType, {
					signal: controller.signal,
					prompt: (ask) => {
						// 快捷接入贴了 API Key（authType=api_key）："Enter xxx key" 这类 secret 提问
						// 直接用贴的 Key 代答，不再转发界面让用户贴第二遍。
						if (request.authType === "api_key" && request.apiKey && ask.type === "secret") {
							return Promise.resolve(request.apiKey);
						}
						if (!enterpriseMode && ask.type === "text" && ask.message.includes("GitHub Enterprise")) {
							return Promise.resolve("");
						}
						// ask.signal 随 interaction.signal 中止：不接上的话，被替换/取消的流程
						// 会永远挂在 prompt 上，堵死 Models 的认证操作队列。
						const answer = new Promise<string>((resolve, reject) => {
							const onAbort = () => reject(new Error("登录已取消"));
							ask.signal?.addEventListener("abort", onAbort, { once: true });
							login.pendingPrompt = {
								ask,
								resolve: (value) => {
									ask.signal?.removeEventListener("abort", onAbort);
									resolve(value);
								},
								reject: (error) => {
									ask.signal?.removeEventListener("abort", onAbort);
									reject(error);
								},
							};
						});
						const cleanup = () => {
							login.pendingPrompt = null;
						};
						answer.then(cleanup, cleanup);
						ctx.broadcast({
							type: "event",
							sessionId: "",
							event: { type: "auth_prompt", ask },
						});
						return answer;
					},
					notify: (event) => {
						// auth_url（回调流）与 device_code（设备码流）都自动打开对应页面
						if (event.type === "auth_url") openInBrowser(event.url);
						if (event.type === "device_code") openInBrowser(event.verificationUri);
						ctx.broadcast({
							type: "event",
							sessionId: "",
							event: { type: "auth_notify", detail: event },
						});
					},
				});
				// Cursor 支持多账号：每次登录 upsert 到账号池，auth.json 的 cursor 槽保持当前活跃。
				if (request.provider === "cursor" && credential.type === "oauth") {
					upsertCursorAccount(ctx.defaultAgentDir(), credential);
				}
				ctx.reply(ws, request.id, { ok: true, result: { provider: request.provider, authType: request.authType } });
			} catch (error) {
				if (controller.signal.aborted) {
					// 被新登录/取消替换，静默结束，避免旧流程往界面甩报错
					ctx.reply(ws, request.id, { ok: false, error: "登录已取消" });
				} else {
					ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			} finally {
				// 只清理仍归属于本次流程的状态，别误伤替换进来的新登录
				if (login.activeLogin?.controller === controller) login.activeLogin = null;
			}
			return;
		}
		case "auth.prompt.respond": {
			if (!login.pendingPrompt) {
				ctx.reply(ws, request.id, { ok: false, error: "当前没有等待回答的登录提问" });
				return;
			}
			login.pendingPrompt.resolve(request.answer);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "auth.cancel": {
			login.activeLogin?.controller.abort();
			login.pendingPrompt?.reject(new Error("登录已取消"));
			login.pendingPrompt = null;
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
	}
}
