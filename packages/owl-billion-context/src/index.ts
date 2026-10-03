/**
 * owl-billion-context — 扩展入口。
 *
 * 把 acp-kernel（billion-context 的模型驱动折叠式压缩内核）接入 owl：
 *  - context 事件：条目 → 内核 → 折叠视图（摘要原位替换 + mNNNNN 引用标签）
 *    + 增速门 nudge 注入（每轮去重、紧急绕过、增量再注入）；
 *  - before_agent_start：追加压缩哲学系统提示；
 *  - session_before_compact：取消 owl 原生阈值 compaction（本插件接管）；
 *  - 四个工具：compress / decompress / search_context / acp_status；
 *  - 状态按会话 sidecar 持久化（<sessionFile>.acp.json，与上游互通）。
 *
 * 移植自 ranxianglei/billion-context-pi（MIT），按 owl 扩展 API 重写。
 * 未移植的子系统见 README。
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@owl/owl-coding-agent";
import {
	createCore,
	defaultCountTokens,
	defaultPrompts,
	formatRanges,
	renderNudgeText,
	resolvePrompts,
	viableRanges,
	type CompressionCore,
	type CompressionState,
	type Config,
	type NudgeDecision,
	type Prompts,
} from "./kernel.js";
import { resolveConfig } from "./config.js";
import { SessionStateStore } from "./state.js";
import {
	collectOriginals,
	coreOutToAgentMessages,
	entriesToCoreMessages,
	extractText,
	ACP_NUDGE_CUSTOM_TYPE,
	type AcpNudgeRecord,
} from "./messages.js";
import { collectCoveredMessageIds, collectImageTokens, estimateTokens, modelSupportsImages } from "./tokens.js";
import { applyStrictReasoningGate, dropCompressReasoning, resolveReasoningDrop, countThinkingChars, type CompressReasoningConfig } from "./reasoning-drop.js";
import { sanitizeToolPairing } from "./tool-pair-sanitizer.js";
import { carryHostSystemMessages } from "./system-passthrough.js";
import { buildAcpSystemPrompt } from "./system-prompt.js";
import { getSystemPromptText } from "./compat.js";
import { makeCompressTool, makeDecompressTool, makeSearchTool, makeStatusTool, isCompressSuccessText, isCompressNoopText, MAX_COMPRESS_ATTEMPTS, type BiliRuntime } from "./tools.js";

// ---------------------------------------------------------------------------
// 运行时：每插件实例一份内核 + 状态存储 + 进程内记账
// ---------------------------------------------------------------------------

function createRuntime() {
	const core: CompressionCore = createCore({ countTokens: defaultCountTokens });
	const store = new SessionStateStore();
	let prompts: Prompts = defaultPrompts;

	// nudge 每轮去重 / 紧急绕过 / 增量再注入（issue #269 的简化版）。
	const nudgeShownTurns = new Map<string, Set<string>>();
	const nudgeShownTokens = new Map<string, Map<string, number>>();
	// compress 失败熔断（issue #6 的简化版）：同一 user turn 内失败/空转
	// 达到 MAX_COMPRESS_ATTEMPTS 后停止注入 nudge。
	const compressFails = new Map<string, { turnKey: string; count: number }>();

	function turnKeyOf(ctx: ExtensionContext): string {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.type === "message" && entry.message.role === "user") return entry.id;
		}
		return ctx.sessionManager.getSessionId();
	}

	function markNudgeShown(sid: string, turnKey: string, tokenCount: number): void {
		let turns = nudgeShownTurns.get(sid);
		if (!turns) {
			turns = new Set();
			nudgeShownTurns.set(sid, turns);
		}
		turns.add(turnKey);
		let toks = nudgeShownTokens.get(sid);
		if (!toks) {
			toks = new Map();
			nudgeShownTokens.set(sid, toks);
		}
		toks.set(turnKey, tokenCount);
	}

	function nudgeShownFor(sid: string, turnKey: string): boolean {
		return nudgeShownTurns.get(sid)?.has(turnKey) ?? false;
	}

	function nudgeShownTokensFor(sid: string, turnKey: string): number | undefined {
		return nudgeShownTokens.get(sid)?.get(turnKey);
	}

	const runtime: BiliRuntime & {
		turnKeyOf(ctx: ExtensionContext): string;
		markNudgeShown(sid: string, turnKey: string, tokenCount: number): void;
		nudgeShownFor(sid: string, turnKey: string): boolean;
		nudgeShownTokensFor(sid: string, turnKey: string): number | undefined;
		setPrompts(p: Prompts): void;
		prompts(): Prompts;
	} = {
		core,
		store,
		prompts: () => prompts,
		setPrompts: (p) => {
			prompts = p;
		},
		stateFor: async (ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			const state = await store.load(sessionFile, sessionId);
			const entries: SessionEntry[] = ctx.sessionManager.buildContextEntries();
			const coreMessages = entriesToCoreMessages(entries);
			return { state, coreMessages, entries };
		},
		save: async (state, ctx) => {
			await store.save(state, ctx.sessionManager.getSessionFile() ?? undefined, ctx.sessionManager.getSessionId());
		},
		configFor: (ctx) => {
			const usage = ctx.getContextUsage?.();
			const window2 = usage?.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : (ctx.model?.contextWindow ?? 0);
			return resolveConfig(window2);
		},
		// 内核 recommend 阶段已经算好可压清单 —— 独立再跑一轮 processTurn 拿它
		// （工具路径使用，与 context 路径同源）。
		nudgeOf: async (ctx) => {
			const { state, coreMessages } = await runtime.stateFor(ctx);
			const config = runtime.configFor(ctx);
			const sentTokens = estimateTokens(coreMessages, collectCoveredMessageIds(state));
			const turn = core.processTurn({ messages: coreMessages, state, config, tokenCount: sentTokens });
			return turn.nudge;
		},
		noteCompressOutcome: (sid, turnKey, outcome) => {
			let slot = compressFails.get(sid);
			if (!slot || slot.turnKey !== turnKey) {
				slot = { turnKey, count: 0 };
				compressFails.set(sid, slot);
			}
			if (outcome.isError || outcome.noop) slot.count += 1;
			else if (outcome.success) slot.count = 0;
			return { count: slot.count, cappedNow: slot.count >= MAX_COMPRESS_ATTEMPTS };
		},
		compressRetryCappedFor: (sid, turnKey) => {
			const slot = compressFails.get(sid);
			return slot !== undefined && slot.turnKey === turnKey && slot.count >= MAX_COMPRESS_ATTEMPTS;
		},
		turnKeyOf,
		markNudgeShown,
		nudgeShownFor,
		nudgeShownTokensFor,
	};
	return runtime;
}

type Runtime = ReturnType<typeof createRuntime>;

// ---------------------------------------------------------------------------
// nudge 消息体
// ---------------------------------------------------------------------------

function nudgeMessageText(nudge: NudgeDecision, blocks: { blockId: string; tier: number; summary: string; compressedTokens: number }[], prompts: Prompts): string {
	const rendered = renderNudgeText(nudge, prompts);
	const lines = [rendered.text];
	if (blocks.length > 0) {
		const totalSummary = blocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
		const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
		const tierCounts: Record<number, number> = {};
		for (const b of blocks) tierCounts[b.tier ?? 1] = (tierCounts[b.tier ?? 1] ?? 0) + 1;
		const tierStr = Object.keys(tierCounts)
			.map(Number)
			.sort()
			.map((t) => `T${t}:${tierCounts[t]}`)
			.join(" ");
		const ids = blocks.slice(0, 10).map((b) => b.blockId).join(", ");
		const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
		lines.push("", `Compressed blocks: ${blocks.length} active (${tierStr}) — ${formatK2(totalSummary)} summary, ${formatK2(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`);
	}
	return lines.join("\n");
}

function formatK2(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const runtime = createRuntime();

	// 压缩哲学 + 工具说明进系统提示（before_agent_start 支持整轮替换）。
	pi.on("before_agent_start", (event, ctx) => {
		// 哲学文本每次会话启动按内核默认刷新（上游支持用户覆盖，这里未移植）。
		runtime.setPrompts(resolvePrompts({}, { acknowledgeRisk: true }));
		const acp = buildAcpSystemPrompt(runtime.prompts());
		return { systemPrompt: `${event.systemPrompt}\n\n${acp}` };
		void ctx;
	});

	// owl 原生阈值 compaction 与折叠压缩互斥：接管压缩后取消原生路径，
	// 防止两套机制轮番改写上下文。
	pi.on("session_before_compact", () => ({ cancel: true }));

	// 会话切换/关闭：丢弃该会话的进程内状态槽与 nudge 记账。
	pi.on("session_shutdown", (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile() ?? undefined;
		runtime.store.drop(file, sid);
	});

	// 每轮 LLM 调用前的上下文改写（主路径）。
	pi.on("context", async (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const { state, coreMessages, entries } = await runtime.stateFor(ctx);
		const config = runtime.configFor(ctx);
		const systemPromptText = getSystemPromptText(ctx);
		const systemPromptTokens = systemPromptText ? Math.ceil(systemPromptText.length / 4) : 0;
		const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));

		// 占用计量：发送视图估算，下限锚定 provider 上报的真实 prompt 大小
		// （有 anchor 时）。上游的校准/发散监测未移植，见 README。
		const coveredIds = collectCoveredMessageIds(state);
		const sentTokens = estimateTokens(coreMessages, coveredIds, imageTokens) + systemPromptTokens;
		const hostTokens = ctx.getContextUsage?.()?.tokens ?? 0;
		let tokenCount = Math.max(sentTokens, hostTokens > 0 ? hostTokens : 0);
		// 有活跃块时用真实发送视图重测（上游 issue #289：原始视图会把每轮
		// 被剪掉的消息永远计入，把占用钉死在紧急区）。
		if (state.blocks.some((b) => b.active && b.effectiveMessageIds.length > 0)) {
			const { sentViewTokenCount } = await import("./tokens.js");
			const view = sentViewTokenCount(runtime.core, coreMessages, state, config, tokenCount, imageTokens, systemPromptTokens);
			if (view.drifted) tokenCount = Math.max(view.viewTokens, hostTokens > 0 ? hostTokens : 0);
		}

		const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
		await runtime.save(turn.state, ctx);

		const originalById = collectOriginals(entries);
		let rebuilt = coreOutToAgentMessages(turn.messages, originalById);

		// compress round 的 thinking 丢弃（默认开；DeepSeek 等严格回显上游自动关）。
		const reasoningCfg: Required<CompressReasoningConfig> = applyStrictReasoningGate(
			resolveReasoningDrop(undefined),
			(ctx.model as { provider?: string } | undefined)?.provider,
			(ctx.model as { baseUrl?: string } | undefined)?.baseUrl,
		);
		rebuilt = dropCompressReasoning(rebuilt, reasoningCfg);
		void countThinkingChars;

		// 回带宿主 system 消息（toolsLoaded 等字段只在 event.messages 上）。
		rebuilt = carryHostSystemMessages(rebuilt, event.messages) ?? rebuilt;

		// 孤儿 toolResult 兜底（折叠吞掉配对 call 时防上游 400）。
		if (turn.state.blocks.length > 0) {
			const sanitized = sanitizeToolPairing(rebuilt);
			if (sanitized.droppedResults.length > 0) {
				rebuilt = sanitized.messages;
				console.warn(`[owl-billion-context] dropped ${sanitized.droppedResults.length} orphaned tool result(s): ${sanitized.droppedResults.join(", ")}`);
			}
		}

		// nudge 注入：context 通道每轮重建，不会永久占用上下文。
		if (turn.nudge?.shouldInject) {
			const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
			turn.nudge.compressibleRanges = viableRanges(turn.nudge.compressibleRanges);
			const turnKey = runtime.turnKeyOf(ctx);
			const adaptiveGrowth =
				!config.modelContextLimit || config.modelContextLimit <= 0
					? config.nudge.growthFloor
					: Math.min(config.nudge.growthCap, Math.max(config.nudge.growthFloor, Math.round(config.modelContextLimit * config.nudge.growthRatio)));
			const reInjectFloor = Math.max(config.nudge.minGrowthFloor, config.nudge.minGrowthRatio * adaptiveGrowth);
			let shownAt = runtime.nudgeShownTokensFor(sid, turnKey);
			if (shownAt !== undefined && tokenCount < shownAt - adaptiveGrowth) {
				// 压缩成功后基线坍缩：增速锚点从新基线重开，而不是旧峰值。
				shownAt = tokenCount;
				runtime.markNudgeShown(sid, turnKey, tokenCount);
			}
			const retryCapped = runtime.compressRetryCappedFor(sid, turnKey);
			const reInjectReady = shownAt === undefined || tokenCount - shownAt >= reInjectFloor;
			const alreadyShown = retryCapped || (!emergency && runtime.nudgeShownFor(sid, turnKey) && !reInjectReady);
			if (!alreadyShown) {
				const text = nudgeMessageText(turn.nudge, turn.state.blocks.filter((b) => b.active), runtime.prompts());
				rebuilt.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as (typeof rebuilt)[number]);
				if (!emergency) runtime.markNudgeShown(sid, turnKey, tokenCount);
				// 展示型持久记录（type:"custom" 条目不进模型上下文）。
				try {
					pi.appendEntry(ACP_NUDGE_CUSTOM_TYPE, {
						text: `[ACP nudge]${emergency ? " EMERGENCY" : ""} ${Math.round(turn.nudge.contextUsage * 100)}% · T${turn.nudge.tier ?? 1}` as AcpNudgeRecord["text"],
					} satisfies { text: string });
				} catch {
					// 尽力而为
				}
			}
		}

		// 有块时始终返回改写后的数组（每条消息都要打引用标签，没有"无变化"捷径）。
		return { messages: rebuilt };
	});

	// 四个上下文管理工具。
	pi.registerTool(makeCompressTool(runtime));
	pi.registerTool(makeDecompressTool(runtime));
	pi.registerTool(makeSearchTool(runtime));
	pi.registerTool(makeStatusTool(runtime));
}
