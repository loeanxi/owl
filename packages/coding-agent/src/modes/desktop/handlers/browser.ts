/**
 * owl desktop bridge — Iab 域 handler。
 *
 * 从 serve.ts 的 handleRequest 分组原样搬迁：共享闭包改为显式上下文注入，逻辑零改动。
 */

import type { WebSocket } from "ws";
import type { BrowserHub } from "../browser-hub.ts";
import type { DesktopClientRequest, IabOpenResult, IabStateResult } from "../protocol.ts";

type Reply = (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;

export interface BrowserHandlerContext {
	reply: Reply;
	iab: BrowserHub;
	iabSubscriptions: WeakMap<WebSocket, Set<string>>;
}

/** Iab 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type IabRequest = Extract<DesktopClientRequest, { type: `iab.${string}` }>;

export async function handleIabRequest(ws: WebSocket, request: IabRequest, ctx: BrowserHandlerContext): Promise<void> {
	switch (request.type) {
		case "iab.open": {
			// 绑定/打开页面：pageId 只绑定，url 按 URL 复用或新建，双给 = 导航既有页
			try {
				const page = await ctx.iab.open({
					...(request.pageId !== undefined ? { pageId: request.pageId } : {}),
					...(request.url !== undefined ? { url: request.url } : {}),
					...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
				});
				ctx.reply(ws, request.id, { ok: true, result: { page } satisfies IabOpenResult });
			} catch (error) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		case "iab.nav": {
			try {
				await ctx.iab.nav(request.pageId, request.action);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "iab.viewport": {
			try {
				await ctx.iab.setViewport(request.pageId, request.width, request.height);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "iab.input": {
			try {
				await ctx.iab.input(request.pageId, request.input);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "iab.attach": {
			// 先记账再抓首帧：保证首帧一定送到这条连接（screencast 只推增量）
			const owned = ctx.iabSubscriptions.get(ws) ?? new Set<string>();
			owned.add(request.pageId);
			ctx.iabSubscriptions.set(ws, owned);
			await ctx.iab.captureFrame(request.pageId);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "iab.detach": {
			ctx.iabSubscriptions.get(ws)?.delete(request.pageId);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "iab.close": {
			await ctx.iab.closePage(request.pageId);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "iab.state": {
			ctx.reply(ws, request.id, { ok: true, result: { pages: ctx.iab.listPages() } satisfies IabStateResult });
			return;
		}
		case "iab.fileResponse": {
			try {
				await ctx.iab.fileResponse(request.pageId, request.paths);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
	}
}
