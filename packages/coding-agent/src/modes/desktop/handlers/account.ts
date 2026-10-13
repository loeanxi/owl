/**
 * owl desktop bridge — 账号域 handler（account.current / list / create / switch）。
 *
 * 应用用户账号（区别于 auth.ts 的模型厂商账号）：一个账号一个 agentDir。
 * 切换 = 写注册表 currentId + 壳重启桥进程（带新 OWL_CODING_AGENT_DIR），
 * 这里只负责注册表读写，不触碰运行中的 SessionManager 等状态。
 */

import type { WebSocket } from "ws";
import {
	avatarPath,
	createDesktopAccount,
	desktopAccountStatus,
	listDesktopAccounts,
	readAvatar,
	removeAvatar,
	switchDesktopAccount,
	writeAvatar,
} from "../account-store.ts";
import type {
	AccountAvatarGetRequest,
	AccountAvatarPutRequest,
	AccountAvatarRemoveRequest,
	AccountCreateRequest,
	AccountCurrentRequest,
	AccountListRequest,
	AccountSwitchRequest,
} from "../protocol.ts";

type Reply = (ws: WebSocket, id: string, result: { ok: boolean; result?: unknown; error?: string }) => void;

export interface AccountHandlerContext {
	reply: Reply;
	/** 当前账号的 agentDir（头像落盘位置；壳经 env 注入）。 */
	defaultAgentDir: () => string;
}

export type AccountRequest =
	| AccountCurrentRequest
	| AccountListRequest
	| AccountCreateRequest
	| AccountSwitchRequest
	| AccountAvatarGetRequest
	| AccountAvatarPutRequest
	| AccountAvatarRemoveRequest;

export async function handleAccountRequest(
	ws: WebSocket,
	request: AccountRequest,
	ctx: AccountHandlerContext,
): Promise<void> {
	switch (request.type) {
		case "account.current": {
			ctx.reply(ws, request.id, { ok: true, result: desktopAccountStatus() });
			return;
		}
		case "account.list": {
			const status = desktopAccountStatus();
			ctx.reply(ws, request.id, { ok: true, result: { accounts: listDesktopAccounts(), ...status } });
			return;
		}
		case "account.create": {
			try {
				const account = createDesktopAccount(request.name, request.password);
				ctx.reply(ws, request.id, { ok: true, result: { account } });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "account.switch": {
			try {
				const account = switchDesktopAccount(request.accountId, request.password);
				ctx.reply(ws, request.id, { ok: true, result: { account, restartRequired: true } });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "account.avatar.get": {
			ctx.reply(ws, request.id, { ok: true, result: { data: readAvatar(ctx.defaultAgentDir()) } });
			return;
		}
		case "account.avatar.put": {
			try {
				writeAvatar(ctx.defaultAgentDir(), request.data);
				ctx.reply(ws, request.id, { ok: true, result: { path: avatarPath(ctx.defaultAgentDir()) } });
			} catch (error) {
				ctx.reply(ws, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		case "account.avatar.remove": {
			removeAvatar(ctx.defaultAgentDir());
			ctx.reply(ws, request.id, { ok: true, result: {} });
			return;
		}
	}
}
