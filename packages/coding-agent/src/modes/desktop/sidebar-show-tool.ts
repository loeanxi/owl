/**
 * sidebar_show 工具 —— 模型主动指挥桌面端侧边工作台。
 *
 * 相对上一版只有「打开文件」一个动作，现在支持三种：
 *   file   打开工作区内的文件；带 line/endLine 时打开后定位并高亮那一行
 *   diff   打开「改动」卡片并选中该文件的差异
 *   review 打开「改动审批」卡片并定位该文件
 *
 * 关键变化是回执：工具先登记 requestId，等桌面端回一条 sidebar.show.ack，
 * 只有 delivered 才敢说「用户看到了」。ignored（界面在别的项目，面板没开）、
 * failed（目标打不开）、timeout（没有界面连着）都如实讲，模型不会假报成功。
 *
 * 路径约定与 fs 层同一围栏：只接受当前工作区内的文件（相对或绝对路径都收，
 * 解析后越出工作区就地拒绝），过线给 UI 的是 workspace 相对 POSIX 路径。
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { DesktopServerMessage, SidebarShowAction } from "./protocol.ts";
import type { SidebarAckQueue, SidebarShowAck } from "./sidebar-acks.ts";
import { toWirePath } from "./sidebar-fs.ts";

export interface SidebarShowToolOptions {
	/** 当前会话的工作区目录（围栏基准）。 */
	cwd: string;
	/** 广播给桌面端。 */
	broadcast: (message: DesktopServerMessage) => void;
	/** 回执队列：等 UI 确认送达。 */
	acks: SidebarAckQueue<SidebarShowAck>;
	/** 当前有没有界面连着桥（没有就别白等回执）。 */
	hasClients?: () => boolean;
}

let sequence = 0;

/** 行号钳到 1 起的整数；非法值（0、负数、非整数）当作没给。 */
function clampLine(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const line = Math.floor(value);
	return line >= 1 ? line : undefined;
}

export function createSidebarShowTool(options: SidebarShowToolOptions): ToolDefinition {
	const { cwd, broadcast, acks, hasClients } = options;
	const params = Type.Object({
		action: Type.Optional(
			Type.Union([Type.Literal("file"), Type.Literal("diff"), Type.Literal("review")], {
				description:
					"要做的动作：file=打开文件（默认）；diff=在「改动」卡片里看该文件的差异；review=在「改动审批」卡片里定位该文件。",
			}),
		),
		path: Type.String({
			description: "目标文件路径（当前工作区内；绝对路径或相对工作区的相对路径均可）",
		}),
		line: Type.Optional(
			Type.Number({ description: "1 起的行号：file 动作定位并高亮该行；diff 动作定位到差异里的该行" }),
		),
		endLine: Type.Optional(Type.Number({ description: "1 起的结束行：与 line 一起给出时高亮整段（仅 file 动作）" })),
		note: Type.Optional(Type.String({ description: "一句话说明：为什么把这个甩给用户看（会显示在侧边栏提示里）" })),
	});
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	const tool: ToolDefinition<typeof params> = {
		name: "sidebar_show",
		label: "侧边栏：展示",
		description:
			"在桌面端侧边工作台展示内容（用户立即可见）：打开工作区内的文件（可定位到行）、" +
			"在「改动」卡片里看某个文件的差异、或在「改动审批」卡片里定位某处改动。" +
			"只支持当前工作区内的文件；用它把要看的代码、配置或产出物摆到用户眼前。",
		promptSnippet: "sidebar_show: 在侧边工作台展示工作区内的文件（可带行号定位）、差异或待审改动（用户可见）",
		parameters: params,
		execute: async (_id, p) => {
			const target = p.path?.trim();
			if (!target) return text("缺少 path 参数。");
			const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
			const rel = relative(cwd, absolute);
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
				return text(`无法展示：${target} 在当前工作区之外，侧边栏只能展示工作区内的文件。`);
			}
			const action: SidebarShowAction = p.action ?? "file";
			const wire = rel.split(sep).join("/");
			if (action === "file") {
				if (!existsSync(absolute)) return text(`文件不存在：${target}`);
				if (statSync(absolute).isDirectory()) return text(`无法展示：${target} 是目录，侧边栏卡片只能打开文件。`);
			}
			const line = clampLine(p.line);
			const endLine = clampLine(p.endLine);
			const note = p.note?.trim();
			if (hasClients !== undefined && !hasClients()) {
				return text(
					"侧边栏没有连接到桌面界面（当前不在桌面端），无法把内容摆到用户眼前；请在回答里直接说明位置与内容。",
				);
			}
			sequence += 1;
			const requestId = `sbx-${Date.now().toString(36)}-${sequence.toString(36)}`;
			// 先登记再广播：界面可能瞬间回执，晚登记会漏掉这次回执。
			const pending = acks.wait(requestId, { status: "timeout" });
			broadcast({
				type: "sidebar.show",
				requestId,
				cwd,
				action,
				path: toWirePath(cwd, absolute),
				...(line !== undefined ? { line } : {}),
				...(endLine !== undefined ? { endLine } : {}),
				...(note !== undefined && note !== "" ? { note } : {}),
			});
			const ack = await pending;
			if (ack.status === "delivered") {
				if (action === "diff") return text(`已在侧边栏「改动」卡片打开 ${wire} 的差异。`);
				if (action === "review") return text(`已在侧边栏「改动审批」卡片打开 ${wire}。`);
				return text(line === undefined ? `已在侧边栏打开 ${wire}。` : `已在侧边栏打开 ${wire}（第 ${line} 行）。`);
			}
			if (ack.status === "ignored") {
				return text(`侧边栏没有接收（${ack.detail ?? "当前界面不在该项目"}）；请在回答里直接说明位置与内容。`);
			}
			if (ack.status === "failed") {
				return text(`侧边栏打开失败：${ack.detail ?? "目标打不开"}。`);
			}
			return text("侧边栏没有回执（界面未连接或版本不匹配）；请在回答里直接说明位置与内容。");
		},
	};
	return tool;
}
