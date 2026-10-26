/**
 * 脏草稿防线 —— 模型不许悄悄覆盖用户在侧边栏编辑器里没保存的修改。
 *
 * 侧边栏编辑器把用户改到一半的内容存成草稿（editor-drafts.ts，按账号隔离）。
 * 模型写文件走自己的 write/edit 工具，不看草稿：用户在编辑器里改了一半，模型
 * 按磁盘上的旧内容改完直接写回，用户的修改就被抹掉了，而模型还报「已写入」。
 *
 * 这里在工具执行前拦一道：命中脏草稿就挡住这次写入，并把原因讲清楚，让模型
 * 去问用户或换个做法，而不是假装写成功。读不到草稿（账号切换、目录异常）时
 * 放行——防线不能反过来把正常编辑卡死。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { EditorDraftStore } from "./editor-drafts.ts";

/** 只拦真正会写盘的两个工具。 */
const TRACKED_TOOLS = new Set(["write", "edit"]);

/** 内联扩展形态（带名字，便于扩展列表与诊断里认出来）。 */
export interface EditorDraftGuardExtension {
	name: string;
	factory: (pi: ExtensionAPI) => void;
}

export function createEditorDraftGuard(agentDir: string): EditorDraftGuardExtension {
	return {
		name: "owl-editor-draft-guard",
		factory: (pi) => {
			pi.on("tool_call", (event, ctx) => {
				if (!TRACKED_TOOLS.has(event.toolName)) return;
				const raw = (event.input as { path?: unknown } | undefined)?.path;
				if (typeof raw !== "string" || raw.trim() === "") return;
				try {
					const cwd = ctx.cwd;
					const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
					const relativePath = relative(cwd, absolute);
					// 工作区外没有侧边栏草稿，不用管。
					if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return;
					const drafts = new EditorDraftStore(agentDir, () => {});
					const result = drafts.get(cwd, relativePath.split(sep).join("/"));
					if (!result.draft) return;
					const minutes = Math.max(0, Math.round((Date.now() - result.draft.updatedAt) / 60000));
					const when = minutes < 1 ? "刚刚" : `${minutes} 分钟前`;
					return {
						block: true,
						reason:
							`${relativePath.split(sep).join("/")} 在桌面端侧边栏编辑器里有用户未保存的修改（${when}）。` +
							"直接写入会覆盖用户正在编辑的内容：请先让用户确认或保存，再改这个文件；不要绕过这个提示硬写。",
					};
				} catch {
					return;
				}
			});
		},
	};
}
