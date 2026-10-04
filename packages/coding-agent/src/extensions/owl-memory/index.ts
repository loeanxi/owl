/**
 * owl 跨会话记忆扩展（内置）。
 *
 * - `remember` 工具：用户明确要求时写入一条长期记忆（可标 scope）；
 * - `recall` 工具：模型按关键词按需检索记忆（hindsight recall 的理念、词面匹配实现）；
 * - `before_agent_start`：把记忆投影注入 system prompt 的 `owl_memory` 分区——按项目
 *   过滤 + 证据/新近排序 + 预算化装填，用户在桌面设置页「跨会话记忆」或 `/memory`
 *   里看到的就是同一份条目；
 * - `agent_start`（每会话一次）：异步抽取同 cwd 尚未处理的历史会话（对标 Codex
 *   memories 的后台流水线），抽取有产出时接一次归并（hindsight observations 的
 *   本地化：模型判合近似重复、证据计数累加）；
 * - `/memory` 命令：列出全部记忆，支持 `forget <序号>`、`merge`（手动归并）、`clear`。
 *
 * 开关：settings.json 的 `owlMemory.enabled`（默认 true），设置页有开关。
 */
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionFactory, InlineExtension } from "../../core/extensions/types.ts";
import { consolidateMemories, extractMemoriesFromPreviousSessions } from "../../core/memory/extract.ts";
import {
	appendMemoryEntries,
	clearMemoryEntries,
	deleteMemoryEntry,
	readMemoryEntries,
	renderMemorySection,
	searchMemoryEntries,
} from "../../core/memory/store.ts";
import { MEMORY_WRITE_GUIDANCE, memoryWriteDenial } from "../../core/memory/write-policy.ts";

function memoryEnabled(pi: Parameters<ExtensionFactory>[0]): boolean {
	return pi.getSettings().owlMemory?.enabled !== false;
}

function renderEntryList(agentDir: string, cwd: string): string {
	const entries = readMemoryEntries(agentDir);
	if (entries.length === 0) {
		return "当前没有跨会话记忆。它们会在会话产生值得记住的稳定信息后自动积累（开关见设置页「跨会话记忆」）。";
	}
	const current = cwd.toLowerCase();
	const lines = entries.map((entry, index) => {
		const date = entry.createdAt.slice(0, 10);
		const proofs = (entry.proofCount ?? 1) > 1 ? ` · 证据×${entry.proofCount}` : "";
		const isCurrent = entry.sourceCwd && entry.sourceCwd.toLowerCase() === current;
		const scope = entry.scope === "global" ? "全局" : isCurrent ? "本项目" : (entry.sourceCwd ?? "全局");
		const note = entry.scope === "global" || isCurrent ? "" : "（不注入本项目会话，recall 全库可查）";
		return `${index + 1}. [${scope}${proofs}] ${entry.content}\n   （记录于 ${date}${note ? `；${note}` : ""}；删除：/memory forget ${index + 1}）`;
	});
	return `跨会话记忆（共 ${entries.length} 条；「本项目/全局」条目注入系统提示词，其它项目的条目只入库存档）：\n\n${lines.join("\n")}`;
}

export function createOwlMemoryExtension(): ExtensionFactory {
	return (pi) => {
		let currentPrompt = "";
		// Steering/follow-up messages do not start a new run. Only delivered user messages
		// may change authorization; merely queued messages must not grant it early.
		pi.on("message_start", (event) => {
			if (event.message.role !== "user") return;
			const content = event.message.content;
			currentPrompt =
				typeof content === "string"
					? content
					: content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
		});
		pi.on("tool_call", (event) => {
			if (event.toolName !== "remember" && event.toolName !== "update_user_impression") return;
			const reason = memoryWriteDenial(currentPrompt, memoryEnabled(pi));
			if (reason) return { block: true, reason };
		});
		pi.registerTool({
			name: "remember",
			label: "记住",
			description:
				"仅在用户本轮明确要求记住或保存长期记忆时，保存一条已确认的稳定事实。" +
				'scope 选 "global" 表示跨项目有效的用户偏好/环境特点；"project" 表示只对当前项目有效的事实（默认）。' +
				"功能需求、截图目标和待办不是现有事实；先完成当前任务，不要用记忆操作替代交付。" +
				"不要保存一次性任务细节、调试过程或任何密钥。记忆在设置页或 /memory 中管理。",
			promptSnippet: "remember: 应用户明确要求保存一条长期记忆",
			promptGuidelines: [MEMORY_WRITE_GUIDANCE],
			parameters: Type.Object({
				content: Type.String({ description: "一条独立、具体、简短的记忆（第三人称，不超过 80 字）" }),
				scope: Type.Optional(
					Type.Union([Type.Literal("project"), Type.Literal("global")], {
						description: "global = 跨项目有效（用户偏好、本机环境）；project = 只对当前项目有效（默认）",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const agentDir = getAgentDir();
				const { added, strengthened } = appendMemoryEntries(agentDir, [
					{
						content: params.content,
						...(params.scope ? { scope: params.scope } : {}),
						...(ctx?.cwd ? { sourceCwd: ctx.cwd } : {}),
						...(ctx?.sessionManager.getSessionFile()
							? { sourceSession: ctx.sessionManager.getSessionFile() }
							: {}),
					},
				]);
				const parts: string[] = [];
				if (added.length > 0) {
					parts.push(
						`已保存跨会话记忆：${added.map((entry) => `${entry.content}（${entry.scope === "global" ? "全局" : "本项目"}）`).join("；")}`,
					);
				}
				if (strengthened > 0) {
					const proof =
						readMemoryEntries(agentDir).find((entry) => entry.content === params.content.trim())?.proofCount ?? 1;
					parts.push(`与已有记忆重复，已把其证据计数提升到 ×${proof}`);
				}
				if (parts.length === 0) {
					parts.push("未保存：内容为空或记忆条数已达上限（可在设置页清理）。");
				}
				return {
					content: [{ type: "text", text: parts.join("；") }],
					details: { saved: added.length, strengthened },
				};
			},
		});

		pi.registerTool({
			name: "recall",
			label: "查记忆",
			description:
				'按关键词检索 Owl 的跨会话记忆库（当前项目 + 全局条目）。当用户提到"之前/上次/我记得"或当前任务可能与历史会话相关时使用。' +
				"留空 query 则返回最近的记忆。检索范围包含其它项目的存档条目（它们不注入系统提示词，只有通过这里才能查到）。",
			promptSnippet: "recall: 按关键词检索跨会话记忆",
			parameters: Type.Object({
				query: Type.Optional(
					Type.String({ description: "关键词（空格分隔多词，任一命中即计分）；留空返回最近记忆" }),
				),
				limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 10" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const agentDir = getAgentDir();
				const hits = searchMemoryEntries(
					agentDir,
					ctx?.cwd ?? "",
					params.query ?? "",
					Math.min(Math.max(params.limit ?? 10, 1), 50),
				);
				if (hits.length === 0) {
					return {
						content: [{ type: "text", text: params.query ? "记忆库中没有命中的条目。" : "记忆库还是空的。" }],
						details: { hits: 0 },
					};
				}
				const lines = hits.map(({ entry }) => {
					const proofs = (entry.proofCount ?? 1) > 1 ? ` · 证据×${entry.proofCount}` : "";
					const scope = entry.scope === "global" ? "全局" : (entry.sourceCwd ?? "全局");
					return `- ${entry.content}（${scope}${proofs} · ${entry.createdAt.slice(0, 10)}）`;
				});
				return {
					content: [{ type: "text", text: `命中 ${hits.length} 条：\n${lines.join("\n")}` }],
					details: { hits: hits.length },
				};
			},
		});

		pi.registerCommand("memory", {
			description: "查看跨会话记忆（/memory；forget <序号> 删除；merge 归并近似重复；clear 清空）",
			handler: async (args, ctx) => {
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
							{
								customType: "owl-memory",
								content: `没有第 ${forgetMatch[1]} 条记忆（当前共 ${entries.length} 条）。`,
								display: true,
							},
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
				if (sub === "merge" || sub === "归并") {
					const model = ctx?.model;
					if (!model) {
						pi.sendMessage(
							{
								customType: "owl-memory",
								content: "当前没有可用模型，无法归并（归并需要一次模型调用）。",
								display: true,
							},
							{ triggerTurn: false },
						);
						return;
					}
					pi.sendMessage(
						{ customType: "owl-memory", content: "正在归并近似重复的记忆…", display: true },
						{ triggerTurn: false },
					);
					const result = await consolidateMemories({ agentDir, model, modelRegistry: ctx.modelRegistry });
					pi.sendMessage(
						{
							customType: "owl-memory",
							content:
								result.mergesApplied > 0
									? `归并完成：合并了 ${result.mergesApplied} 组近似重复记忆。`
									: "没有发现可合并的近似重复。",
							display: true,
						},
						{ triggerTurn: false },
					);
					return;
				}
				pi.sendMessage(
					{ customType: "owl-memory", content: renderEntryList(agentDir, ctx?.cwd ?? ""), display: true },
					{ triggerTurn: false },
				);
			},
		});

		pi.on("before_agent_start", (event) => {
			currentPrompt = event.prompt;
			event.systemPromptOptions.sections.owl_memory_usage = MEMORY_WRITE_GUIDANCE;
			if (!memoryEnabled(pi)) return;
			const section = renderMemorySection(getAgentDir(), event.systemPromptOptions.cwd);
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
			})
				.then((result) => {
					// 抽取有产出（新增或强化）才值得花一次归并调用
					if (result.memoriesAdded > 0 || result.memoriesStrengthened > 0) {
						return consolidateMemories({ agentDir, model, modelRegistry: ctx.modelRegistry });
					}
					return undefined;
				})
				.catch(() => {
					// 记忆抽取/归并是尽力而为的后台任务，失败不打扰会话
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
