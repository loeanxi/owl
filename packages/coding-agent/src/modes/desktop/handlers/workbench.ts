/**
 * owl desktop bridge — 工作台域 handler（diffApproval / permission+question 应答 / schedule）。
 *
 * 从 serve.ts 的 handleRequest 分组原样搬迁：共享闭包改为显式上下文注入，逻辑零改动。
 */

import type { WebSocket } from "ws";
import { getWorkspaceDiffApprovalStore } from "../../../core/diff-approval/registry.ts";
import { resolveQuestion } from "../../../core/question-channel.ts";
import type { DesktopPermissionQueue } from "../permission-queue.ts";
import type {
	DesktopClientRequest,
	DiffApprovalClearResult,
	DiffApprovalDiffResult,
	DiffApprovalListResult,
	DiffApprovalResolveResult,
} from "../protocol.ts";
import type { ScheduleService } from "../schedule-service.ts";

type Reply = (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;

export interface WorkbenchHandlerContext {
	reply: Reply;
	defaultAgentDir: () => string;
	pendingPermissions: DesktopPermissionQueue;
	schedule: ScheduleService;
}

/** DiffApproval 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type DiffApprovalRequest = Extract<
	DesktopClientRequest,
	{ type: "diffApproval.list" | "diffApproval.diff" | "diffApproval.resolve" | "diffApproval.clear" }
>;

export async function handleDiffApprovalRequest(
	ws: WebSocket,
	request: DiffApprovalRequest,
	ctx: WorkbenchHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "diffApproval.list": {
			try {
				const store = getWorkspaceDiffApprovalStore(ctx.defaultAgentDir(), request.cwd);
				const files = store.list(request.cwd);
				ctx.reply(ws, request.id, { ok: true, result: { files } satisfies DiffApprovalListResult });
			} catch (error) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		case "diffApproval.diff": {
			try {
				const store = getWorkspaceDiffApprovalStore(ctx.defaultAgentDir(), request.cwd);
				const result: DiffApprovalDiffResult = store.diff(request.entryId);
				ctx.reply(ws, request.id, { ok: true, result });
			} catch (error) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		case "diffApproval.resolve": {
			try {
				const store = getWorkspaceDiffApprovalStore(ctx.defaultAgentDir(), request.cwd);
				const result: DiffApprovalResolveResult = store.resolve(request.entryIds, request.action);
				ctx.reply(ws, request.id, { ok: true, result });
			} catch (error) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		case "diffApproval.clear": {
			try {
				const store = getWorkspaceDiffApprovalStore(ctx.defaultAgentDir(), request.cwd);
				const result: DiffApprovalClearResult = { removed: store.clearResolved() };
				ctx.reply(ws, request.id, { ok: true, result });
			} catch (error) {
				ctx.reply(ws, request.id, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
	}
}
/** Schedule 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type ScheduleRequest = Extract<DesktopClientRequest, { type: `schedule.${string}` }>;

export async function handleScheduleRequest(
	ws: WebSocket,
	request: ScheduleRequest,
	ctx: WorkbenchHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "schedule.list": {
			ctx.reply(ws, request.id, { ok: true, result: ctx.schedule.list() });
			return;
		}
		case "schedule.create": {
			const task = ctx.schedule.create({
				name: request.name,
				...(request.emoji !== undefined ? { emoji: request.emoji } : {}),
				prompt: request.prompt,
				sessionId: request.sessionId,
				targetLabel: request.targetLabel,
				repeat: request.repeat,
				...(request.missed !== undefined ? { missed: request.missed } : {}),
			});
			ctx.reply(ws, request.id, { ok: true, result: { task } });
			return;
		}
		case "schedule.update": {
			const { taskId, type: _type, id: _id, ...rest } = request;
			const task = ctx.schedule.update({ id: taskId, ...rest });
			ctx.reply(ws, request.id, { ok: true, result: { task } });
			return;
		}
		case "schedule.delete": {
			ctx.schedule.remove(request.taskId);
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "schedule.run": {
			ctx.reply(ws, request.id, { ok: true, result: { run: await ctx.schedule.runNow(request.taskId) } });
			return;
		}
		case "schedule.history": {
			ctx.reply(ws, request.id, { ok: true, result: { runs: ctx.schedule.history(request.taskId) } });
			return;
		}
	}
}
/** Dialog 域：原 handleRequest 的对应分支原样搬迁，主 switch 只保留分组路由。 */
export type DialogRequest = Extract<DesktopClientRequest, { type: "permission.response" | "question.response" }>;

export async function handleDialogRequest(
	ws: WebSocket,
	request: DialogRequest,
	ctx: WorkbenchHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "permission.response": {
			if (!ctx.pendingPermissions.resolve(request.requestId, request.approved)) {
				ctx.reply(ws, request.id, { ok: false, error: `Unknown permission request: ${request.requestId}` });
				return;
			}
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
		case "question.response": {
			const resolved = resolveQuestion(request.requestId, {
				cancelled: request.cancelled === true,
				answers: request.answers ?? [],
			});
			if (!resolved) {
				ctx.reply(ws, request.id, { ok: false, error: `Unknown question request: ${request.requestId}` });
				return;
			}
			ctx.reply(ws, request.id, { ok: true });
			return;
		}
	}
}
