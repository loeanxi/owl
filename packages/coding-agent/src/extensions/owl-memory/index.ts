/**
 * owl 跨会话记忆扩展（内置）。
 *
 * - `remember` 工具：模型在了解到值得长期记住的信息时显式写入一条记忆；
 * - `before_agent_start`：把记忆投影（MEMORY.md）注入 system prompt 的
 *   `owl_memory` 分区——用户在桌面设置页「跨会话记忆」或 `/memory` 里看到的
 *   就是同一份条目，跨会话了什么一目了然；
 * - `agent_start`（每会话一次）：异步抽取同 cwd 尚未处理的历史会话（对标 Codex
 *   memories 的后台流水线，fire-and-forget，不阻塞交互）；
 * - `/memory` 命令：列出全部记忆（含来源与删除方法），支持 `forget <序号>` 与 `clear`。
 *
 * 开关：settings.json 的 `owlMemory.enabled`（默认 true），设置页有开关。
 */
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { extractMemoriesFromPreviousSessions } from "../../core/memory/extract.ts";
import {
	appendMemoryEntries,
	clearMemoryEntries,
	deleteMemoryEntry,
	readMemoryEntries,
	renderMemorySection,
} from "../../core/memory/store.ts";
import type { ExtensionFactory, InlineExtension } from "../../core/extensions/types.ts";

function memoryEnabled(pi: Parameters<ExtensionFactory>[0]): boolean {
	return pi.getSettings().owlMemory?.enabled !== false;
}

export function createOwlMemoryExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "remember",
			label: "记住",
			description:
				"把一条值得跨会话长期记住的稳定事实写入 Owl 跨会话记忆（用户偏好、项目约定、环境特点、重要长期决策）。" +
				"不要保存一次性任务细节、调试过程或任何密钥。用户可以在设置页「跨会话记忆」或 /memory 中查看和删除这些记忆。",
			promptSnippet: "remember: 把稳定事实写入跨会话记忆",
			parameters: Type.Object({
				content: Type.String({ description: "一条独立、具体、简短的记忆（第三人称，不超过 80 字）" }),
			}),
			async execute(_toolCallId, params) {
				const agentDir = getAgentDir();
				const added = appendMemoryEntries(agentDir, [{ content: params.content }]);
				return {
					content: [
						{
							type: "text",
							text: added.length
								? `已保存 ${added.length} 条跨会话记忆：${added.map((entry) => entry.content).join("；")}`
								: "未保存：内容为空、与已有记忆重复，或记忆条数已达上限（可在设置页清理）。",
						},
					],
					details: { saved: added.length },
				};
			},
		});

		pi.registerCommand("memory", {
			description: "查看跨会话记忆（/memory；forget <序号> 删除单条；clear 清空）",
			handler: async (args) => {
				const agentDir = getAgentDir();
				const sub = args.trim();
				if (sub === "clear" || sub === "清空") {
					clearMemoryEntries(agentDir);
					pi.sendMessage(
						{ customType: "owl-memory", content: "已清空全部跨会话记忆。", display: true },
						{ triggerTurn: false },
					);
					return;
				}
				const forgetMatch = sub.match(/^(?:forget|删除)\s+(\d+)$/);
				if (forgetMatch) {
					const entries = readMemoryEntries(agentDir);
					const index = Number(forgetMatch[1]) - 1;
					const target = entries[index];
					if (!target) {
						pi.sendMessage(
							{ customType: "owl-memory", content: `没有第 ${forgetMatch[1]} 条记忆（当前共 ${entries.length} 条）。`, display: true },
							{ triggerTurn: false },
						);
						return;
					}
					deleteMemoryEntry(agentDir, target.id);
					pi.sendMessage(
						{ customType: "owl-memory", content: `已删除：${target.content}`, display: true },
						{ triggerTurn: false },
					);
					return;
				}

				const entries = readMemoryEntries(agentDir);
				const content =
					entries.length === 0
						? "当前没有跨会话记忆。它们会在会话产生值得记住的稳定信息后自动积累（开关见设置页「跨会话记忆」）。"
						: `跨会话记忆（共 ${entries.length} 条，每轮注入系统提示词）：\n\n${entries
								.map((entry, index) => {
									const date = entry.createdAt.slice(0, 10);
									const source = entry.sourceCwd ? `\n   来源项目：${entry.sourceCwd}` : "";
									return `${index + 1}. ${entry.content}\n   （记录于 ${date}${source}；删除：/memory forget ${index + 1}）`;
								})
								.join("\n")}`;
				pi.sendMessage({ customType: "owl-memory", content, display: true }, { triggerTurn: false });
			},
		});

		pi.on("before_agent_start", (event) => {
			if (!memoryEnabled(pi)) return;
			const section = renderMemorySection(getAgentDir());
			if (section) event.systemPromptOptions.sections.owl_memory = section;
		});

		let extractionStarted = false;
		pi.on("agent_start", (_event, ctx) => {
			if (extractionStarted || !memoryEnabled(pi)) return;
			const model = ctx.model;
			if (!model) return;
			extractionStarted = true;
			const agentDir = getAgentDir();
			void extractMemoriesFromPreviousSessions({
				agentDir,
				cwd: ctx.cwd,
				model,
				modelRegistry: ctx.modelRegistry,
				currentSessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			}).catch(() => {
				// 记忆抽取是尽力而为的后台任务，失败不打扰会话
			});
		});
	};
}

export const owlMemoryExtension: InlineExtension = {
	name: "owl-memory",
	factory: createOwlMemoryExtension(),
	replaceable: true,
	builtin: true,
};
