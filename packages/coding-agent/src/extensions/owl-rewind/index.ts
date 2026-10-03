/**
 * owl-rewind 扩展（内置）：会话回退 + 工作区文件检查点。
 *
 * - 写前备份：write/edit 工具执行前捕获文件「写之前」的字节状态
 *   （tool_call 暂存 → tool_result 成功才落库），对齐 Claude Code 检查点语义；
 * - 边界重扫：每轮用户消息开始时重扫全部已追踪文件，bash / 手动编辑造成的
 *   外部改动同样进备份记录，回退时一并还原；
 * - /rewind 命令：`/rewind` 列出候选（当前分支上的用户消息，1 = 最近一条），
 *   `/rewind <序号>` 仅回退对话，`/rewind <序号> code` 连文件一起还原。
 *   桌面端的消息气泡 ↶ 按钮走桥协议 rewind.*，与本命令共用同一引擎。
 *
 * 回退本体 = AgentSession.navigateTree（owl 会话树原生能力：leaf 指针前移 +
 * 被撤回内容留在日志里可审计），外加 owl-rewind 的文件还原与叶子钉住标记。
 *
 * 开关：settings.json 的 `owlRewind.enabled`（默认 true）；`-builtin:owl-rewind`
 * 可整体停用。追踪边界与安全模型见 DEV-README「会话回退」一节。
 */
import { getAgentDir } from "../../config.ts";
import type { ExtensionFactory, InlineExtension } from "../../core/extensions/types.ts";
import { listRewindTargets } from "../../core/rewind/engine.ts";
import { getSessionRewindTracker } from "../../core/rewind/registry.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";

const MARKER_ENTRY_TYPE = "owl-rewind";

export function createOwlRewindExtension(): ExtensionFactory {
	return (pi) => {
		const agentDir = getAgentDir();
		// owl-memory 同款纪律：getSettings 只能在事件处理器/命令 handler 里读
		//（工厂执行期 actions 还没接线），所以开关与上限都在这里惰性解析。
		const settingsOf = (): { enabled: boolean; maxFileBytes: number | undefined } => {
			const owlRewind = pi.getSettings().owlRewind;
			return {
				enabled: owlRewind?.enabled !== false,
				maxFileBytes:
					typeof owlRewind?.maxFileBytes === "number" && owlRewind.maxFileBytes > 0
						? owlRewind.maxFileBytes
						: undefined,
			};
		};
		const trackerFor = (sessionId: string): ReturnType<typeof getSessionRewindTracker> | null => {
			if (!settingsOf().enabled) return null;
			return getSessionRewindTracker(agentDir, sessionId, { maxFileBytes: settingsOf().maxFileBytes });
		};

		pi.on("before_agent_start", (_event, ctx) => {
			trackerFor(ctx.sessionManager.getSessionId())?.stageBoundaryRescan();
		});

		pi.on("agent_start", (_event, ctx) => {
			trackerFor(ctx.sessionManager.getSessionId())?.ensureBoundaryCommitted(ctx.sessionManager);
		});

		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "write" && event.toolName !== "edit") return;
			const path = (event.input as { path?: unknown } | undefined)?.path;
			if (typeof path !== "string" || !path.trim()) return;
			trackerFor(ctx.sessionManager.getSessionId())?.stageCapture(
				event.toolCallId,
				resolveToCwd(path, ctx.cwd),
				ctx.sessionManager,
			);
		});

		pi.on("tool_result", (event, ctx) => {
			// 只处理 write/edit 的结果；其余工具没有暂存，直接空转
			if (event.toolName !== "write" && event.toolName !== "edit") return;
			const tracker = trackerFor(ctx.sessionManager.getSessionId());
			if (!tracker) return;
			tracker.commitCapture(event.toolCallId, event.isError === true);
			tracker.prune();
		});

		pi.registerCommand("rewind", {
			description:
				"回退到更早的用户消息（/rewind 列出候选；/rewind <序号> 仅回退对话；/rewind <序号> code 连文件一起还原）",
			handler: async (argsText, ctx) => {
				const sessionManager = ctx.sessionManager;
				const send = (text: string): void => {
					void pi.sendMessage(
						{ customType: MARKER_ENTRY_TYPE, content: text, display: true },
						{ triggerTurn: false },
					);
				};
				const projection = sessionManager.buildSessionProjection();
				const targets = listRewindTargets(projection.entries.map((entry) => entry.sourceEntry));

				const args = argsText.trim().split(/\s+/).filter(Boolean);
				const sendTargetList = (): void => {
					if (targets.length === 0) {
						send("当前会话还没有可回退的用户消息。");
						return;
					}
					const lines = targets
						.map((target, index) => {
							const firstLine = target.text.split("\n").find((line) => line.trim() !== "") ?? "";
							const brief = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
							return `${index + 1}. ${brief}`;
						})
						.reverse()
						.join("\n");
					send(
						`可回退到以下用户消息（1 = 最近一条）：\n${lines}\n\n用 /rewind <序号> 回退（加 code 参数连文件一起还原）。桌面端也可以直接点消息旁的 ↶ 按钮。`,
					);
				};

				if (args.length === 0) {
					sendTargetList();
					return;
				}
				const ordinal = Number.parseInt(args[0] ?? "", 10);
				if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > targets.length) {
					send(`序号无效：${args[0]}。有效范围 1–${targets.length}。`);
					return;
				}
				// 序号从最近一条往前数
				const target = targets[targets.length - ordinal]!;
				const modeBoth = (args[1] ?? "") === "code" || (args[1] ?? "") === "文件";

				await ctx.waitForIdle();
				let restoreNote = "";
				if (modeBoth) {
					const rewindTracker = trackerFor(sessionManager.getSessionId());
					const plan = rewindTracker?.planRestore(
						{ entryId: target.entryId, time: target.timestamp },
						sessionManager,
					);
					if (rewindTracker && plan && plan.actions.length > 0) {
						const result = rewindTracker.applyRestore(plan);
						restoreNote = `；文件已还原 ${result.restored} 个、删除 ${result.deleted} 个${
							result.skipped.length > 0
								? `（跳过 ${result.skipped.length} 个：${result.skipped.map((s) => s.reason).join("、")}）`
								: ""
						}`;
					} else {
						restoreNote = "；没有需要还原的文件改动";
					}
				}
				const navigation = await ctx.navigateTree(target.entryId);
				if (navigation.cancelled) {
					send("回退已被取消。");
					return;
				}
				// navigateTree 把 leaf 移到目标消息的 parent；追加一条 custom 条目把新
				// 分支钉住（否则重启后 leaf 会回落到文件末尾，回退悄悄失效），
				// 同时充当审计标记。custom 条目不进模型上下文、桌面转录不渲染。
				// 命令 ctx 的 sessionManager 是只读视图，落条目走 pi.appendEntry。
				pi.appendEntry(MARKER_ENTRY_TYPE, {
					target: target.entryId,
					mode: modeBoth ? "both" : "conversation",
					via: "command",
					time: new Date().toISOString(),
				});
				trackerFor(sessionManager.getSessionId())?.prune();
				const brief = target.text.split("\n").find((line) => line.trim() !== "") ?? "";
				send(
					`已回退到：${brief.slice(0, 60)}${brief.length > 60 ? "…" : ""}${restoreNote}。请重新编辑并发送这条消息。`,
				);
			},
		});
	};
}

export const owlRewindExtension: InlineExtension = {
	name: "owl-rewind",
	factory: createOwlRewindExtension(),
	replaceable: true,
	builtin: true,
};

/** 会话日志里 owl-rewind 钉住标记的 customType（投影/转录都不渲染它）。 */
export const OWL_REWIND_MARKER_TYPE = MARKER_ENTRY_TYPE;
