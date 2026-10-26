/**
 * sidebar_context 工具 —— 模型问侧栏「用户此刻在看什么」。
 *
 * 侧栏是用户真正待着的地方：他在看哪个文件、哪一行，哪些文件开着、哪些文件有
 * 未保存的修改。模型以前只能看到自己写过的对话，看不到这些，于是会出现「用户
 * 正在看第 42 行，模型却去改别的文件」这类对不上频道的情况。
 *
 * 这个工具把焦点问出来：模型发起请求 → 桌面端回一份焦点快照 → 工具把快照讲给
 * 模型。界面没连、在别的项目、或用户没在看任何文件时，如实说没有，不编。
 */
import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { DesktopServerMessage } from "./protocol.ts";
import type { SidebarAckQueue, SidebarContextAck } from "./sidebar-acks.ts";

export interface SidebarContextToolOptions {
	/** 当前会话的工作区目录（用于匹配界面所在项目）。 */
	cwd: string;
	/** 广播给桌面端。 */
	broadcast: (message: DesktopServerMessage) => void;
	/** 回执队列：等界面回焦点快照。 */
	acks: SidebarAckQueue<SidebarContextAck>;
	/** 当前有没有界面连着桥。 */
	hasClients?: () => boolean;
}

let sequence = 0;

/** 焦点快照 → 给模型看的一段话。 */
export function formatSidebarFocus(state: {
	tabKind?: string;
	path?: string;
	line?: number;
	openFiles?: string[];
	dirtyFiles?: string[];
	mirrorOpen?: boolean;
	pendingReview?: string[];
	decidedReview?: string[];
	terminalOutput?: string;
}): string {
	const lines: string[] = [];
	if (state.path !== undefined) {
		const where = state.line === undefined ? state.path : `${state.path}（第 ${state.line} 行）`;
		lines.push(`用户正在看：${where}`);
	} else if (state.tabKind !== undefined) {
		lines.push(`用户当前停留在侧边栏的「${state.tabKind}」卡片上（没有打开具体文件）。`);
	} else {
		lines.push("用户当前没有聚焦侧边栏里的任何文件。");
	}
	const open = state.openFiles ?? [];
	if (open.length > 0) lines.push(`侧边栏打开的文件：${open.join("、")}`);
	const dirty = state.dirtyFiles ?? [];
	if (dirty.length > 0) {
		lines.push(`有未保存修改的文件（用户正在编辑，改动前先问）：${dirty.join("、")}`);
	}
	if (state.mirrorOpen === true) lines.push("短剧面板开着（用户可能在看剧，而不是工作台）。");
	const pending = state.pendingReview ?? [];
	if (pending.length > 0) {
		lines.push(`你的改动还在等用户决定（改动审批卡片）：${pending.join("、")}`);
	}
	const decided = state.decidedReview ?? [];
	if (decided.length > 0) {
		lines.push(`用户已经处理过的改动：${decided.join("、")}`);
	}
	const terminal = state.terminalOutput?.trim() ?? "";
	if (terminal !== "") {
		lines.push(`用户在终端里刚跑出来的输出（模型自己没跑过）：\n${terminal.slice(-1500)}`);
	}
	return lines.join("\n");
}

export function createSidebarContextTool(options: SidebarContextToolOptions): ToolDefinition {
	const { cwd, broadcast, acks, hasClients } = options;
	const params = Type.Object({});
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	const tool: ToolDefinition<typeof params> = {
		name: "sidebar_context",
		label: "侧边栏：当前焦点",
		description:
			"问桌面端侧边栏「用户此刻在看什么」：正在看哪个文件的哪一行、哪些文件开着、" +
			"哪些文件有未保存的修改。用户说「这个」「这里」或让你先看看他手上的东西时，" +
			"先调用它确认目标，再动手。",
		promptSnippet: "sidebar_context: 问侧边栏用户当前在看什么（文件/行/未保存改动）",
		parameters: params,
		execute: async () => {
			if (hasClients !== undefined && !hasClients()) {
				return text("侧边栏没有连接到桌面界面（当前不在桌面端），拿不到用户的焦点；请直接问用户要看哪里。");
			}
			sequence += 1;
			const requestId = `sbctx-${Date.now().toString(36)}-${sequence.toString(36)}`;
			const pending = acks.wait(requestId, { detail: "侧边栏没有回焦点信息" });
			broadcast({ type: "sidebar.context", requestId, cwd });
			const ack = await pending;
			if (ack.state === undefined) {
				return text(`拿不到侧边栏焦点（${ack.detail ?? "界面未回"}）；请直接问用户要看哪里。`);
			}
			return text(formatSidebarFocus(ack.state));
		},
	};
	return tool;
}
