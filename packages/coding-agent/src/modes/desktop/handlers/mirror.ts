/**
 * owl desktop bridge — Mirror 域 handler。
 *
 * 从 serve.ts 的 handleRequest 分组原样搬迁：共享闭包改为显式上下文注入，逻辑零改动。
 */

import type { WebSocket } from "ws";
import type { MirrorFrameDelivery } from "../mirror/frame-delivery.ts";
import type { MirrorProjectionAccess } from "../mirror/projection-access.ts";
import type { MirrorHub } from "../mirror-hub.ts";
import type { DesktopClientRequest, MirrorListResult } from "../protocol.ts";

type Reply = (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;

export interface MirrorHandlerContext {
	reply: Reply;
	mirror: MirrorHub;
	mirrorProjectionAccess: MirrorProjectionAccess;
	mirrorFrames: MirrorFrameDelivery;
	mirrorSubscriptions: WeakMap<WebSocket, Set<string>>;
}

/** ctx.mirror.* 域：原 handleRequest 的 ctx.mirror 分支原样搬迁，主 switch 只保留分组路由。 */
export type MirrorRequest = Extract<DesktopClientRequest, { type: `mirror.${string}` }>;

export async function handleMirrorRequest(
	ws: WebSocket,
	request: MirrorRequest,
	ctx: MirrorHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "mirror.list": {
			if (!ctx.mirror.isSupported()) {
				ctx.reply(ws, request.id, {
					ok: true,
					result: { windows: [], supported: false } satisfies MirrorListResult,
				});
				return;
			}
			try {
				const windows = await ctx.mirror.listWindows();
				ctx.reply(ws, request.id, { ok: true, result: { windows, supported: true } satisfies MirrorListResult });
			} catch (error) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		case "mirror.attach": {
			// 先记账再 attach：帧一到就按订阅表定向投递。同一连接重复 attach（前端
			// 3s 无帧重试）只在首次真正 hub.attach——hub 的 refs 是计数器，重复加
			// 而清理只有一份 detach，捕获进程就永远等不到回收。
			const owned = ctx.mirrorSubscriptions.get(ws) ?? new Set<string>();
			const firstClaim = !owned.has(request.windowId);
			owned.add(request.windowId);
			ctx.mirrorSubscriptions.set(ws, owned);
			if (!firstClaim) {
				ctx.reply(ws, request.id, { ok: true });
				return;
			}
			try {
				ctx.mirror.attach(request.windowId);
				ctx.mirrorFrames.subscribe(ws, request.windowId);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.mirrorSubscriptions.get(ws)?.delete(request.windowId);
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.detach": {
			if (ctx.mirrorSubscriptions.get(ws)?.delete(request.windowId)) {
				ctx.mirrorFrames.unsubscribe(ws, request.windowId);
				ctx.mirror.detach(request.windowId);
			}
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "mirror.project": {
			try {
				const geometry = await ctx.mirrorProjectionAccess.project(ws, request.windowId, request.visible !== false);
				ctx.reply(ws, request.id, { ok: true, result: geometry });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.input": {
			try {
				ctx.mirrorProjectionAccess.input(
					ws,
					request,
					ctx.mirrorSubscriptions.get(ws)?.has(request.windowId) === true,
				);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.restore": {
			try {
				ctx.mirrorProjectionAccess.assertOwnerOrUnclaimed(ws, request.windowId);
				await ctx.mirror.restore(request.windowId);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.launch": {
			try {
				await ctx.mirror.launchApp();
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.embed": {
			try {
				ctx.mirrorProjectionAccess.assertOwnerOrUnclaimed(ws, request.windowId);
				const parentHwnd =
					request.parentHwnd && request.parentHwnd > 0 ? request.parentHwnd : await ctx.mirror.findOwlParentHwnd();
				await ctx.mirror.embedWindow(request.windowId, parentHwnd, request.rect, {
					swallowMinimize: request.swallowMinimize === true,
				});
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.layout": {
			try {
				ctx.mirrorProjectionAccess.assertOwnerOrUnclaimed(ws, request.windowId);
				await ctx.mirror.layoutWindow(
					request.windowId,
					request.rect,
					request.visible,
					request.swallowMinimize === true,
				);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.fitowl": {
			try {
				await ctx.mirror.fitOwl(request.windowId, request.x, request.y, request.width, request.height);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "mirror.unembed": {
			try {
				if (ctx.mirrorProjectionAccess.hasClaim(request.windowId))
					await ctx.mirrorProjectionAccess.unembed(ws, request.windowId);
				else await ctx.mirror.unembedWindow(request.windowId);
				ctx.reply(ws, request.id, { ok: true });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
	}
}
