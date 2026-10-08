/**
 * owl desktop bridge — Term 域 handler。
 *
 * 从 serve.ts 的 handleRequest 分组原样搬迁：共享闭包改为显式上下文注入，逻辑零改动。
 */

import type { WebSocket } from "ws";
import type { DesktopClientRequest, TermDataMessage, TermExitMessage } from "../protocol.ts";
import type { TerminalManager } from "../terminals.ts";

type Reply = (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;

export interface TerminalHandlerContext {
	reply: Reply;
	terminals: TerminalManager;
	wsTerms: WeakMap<WebSocket, Set<string>>;
}

/** Term 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type TermRequest = Extract<DesktopClientRequest, { type: `term.${string}` }>;

export async function handleTermRequest(
	ws: WebSocket,
	request: TermRequest,
	ctx: TerminalHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "term.create": {
			// 输出定向回创建它的连接（不广播）；连接记账，断线时统一回收
			const owned = ctx.wsTerms.get(ws) ?? new Set<string>();
			ctx.wsTerms.set(ws, owned);
			const { termId, shell } = ctx.terminals.create(request.cwd, request.cols, request.rows, {
				onData: (id, data) => {
					if (ws.readyState !== ws.OPEN) return;
					const message: TermDataMessage = { type: "term.data", termId: id, data };
					ws.send(JSON.stringify(message));
				},
				onExit: (id, exitCode) => {
					owned.delete(id);
					if (ws.readyState !== ws.OPEN) return;
					const message: TermExitMessage = { type: "term.exit", termId: id, exitCode };
					ws.send(JSON.stringify(message));
				},
			});
			owned.add(termId);
			ctx.reply(ws, request.id, { ok: true, result: { termId, shell } });
			return;
		}
		case "term.input": {
			ctx.terminals.write(request.termId, request.data);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "term.resize": {
			ctx.terminals.resize(request.termId, request.cols, request.rows);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "term.kill": {
			ctx.wsTerms.get(ws)?.delete(request.termId);
			ctx.terminals.kill(request.termId);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
	}
}
