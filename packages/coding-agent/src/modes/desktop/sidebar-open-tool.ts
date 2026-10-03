/**
 * sidebar_open 工具 —— dsh-better-sidebar「为模型注入侧边栏打开工具」的对位。
 * 设置 owlSidebar.injectOpenTool 开启时由桥注入桌面会话（serve.ts 的
 * buildFactory），模型可在侧边工作台主动打开文件，用户立即可见。
 *
 * 路径约定与 fs 层同一围栏：只接受当前工作区内的文件（相对或绝对路径都收，
 * 解析后越出工作区就地拒绝），广播 sidebar.open（workspace 相对 POSIX 路径）
 * 由 UI 打开对应 viewer tab；预览卡片被停用时的回退（编辑器 ↔ 系统默认程序）
 * 由 UI 决定，工具只负责把合法请求送达。
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { DesktopServerMessage } from "./protocol.ts";
import { toWirePath } from "./sidebar-fs.ts";

export function createSidebarOpenTool(cwd: string, broadcast: (message: DesktopServerMessage) => void): ToolDefinition {
	const params = Type.Object({
		path: Type.String({
			description: "要打开的文件路径（当前工作区内；绝对路径或相对工作区的相对路径均可）",
		}),
	});
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	const tool: ToolDefinition<typeof params> = {
		name: "sidebar_open",
		label: "侧边栏：打开文件",
		description:
			"在桌面端侧边工作台打开一个文件（代码/文本进编辑器，图片进图片预览，用户立即可见）。" +
			"只支持当前工作区内的文件；要用它向用户展示代码、配置或产出物。",
		promptSnippet: "sidebar_open: 在侧边工作台打开工作区内的文件（用户可见）",
		parameters: params,
		execute: async (_id, p) => {
			const target = p.path.trim();
			if (!target) return text("缺少 path 参数。");
			const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
			const rel = relative(cwd, absolute);
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
				return text(`无法打开：${target} 在当前工作区之外，侧边栏只能打开工作区内的文件。`);
			}
			if (!existsSync(absolute)) return text(`文件不存在：${target}`);
			if (statSync(absolute).isDirectory()) {
				return text(`无法打开：${target} 是目录，侧边栏卡片只能打开文件。`);
			}
			const wire = rel.split(sep).join("/");
			broadcast({ type: "sidebar.open", cwd, path: toWirePath(cwd, absolute) });
			return text(`已在侧边栏打开 ${wire}。`);
		},
	};
	return tool;
}
