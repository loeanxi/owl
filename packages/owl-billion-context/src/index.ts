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
import { getSystemPromptText } from "./compat.js";
import { resolveConfig } from "./config.js";
import {
	type CompressionCore,
	type CompressionState,
	type Config,
	createCore,
	defaultCountTokens,
	defaultPrompts,
	formatRanges,
	type NudgeDecision,
	type Prompts,
	renderNudgeText,
	resolvePrompts,
	viableRanges,
} from "./kernel.js";
import {
	ACP_NUDGE_CUSTOM_TYPE,
	type AcpNudgeRecord,
	collectOriginals,
	coreOutToAgentMessages,
	entriesToCoreMessages,
	extractText,
} from "./messages.js";
import {
	applyStrictReasoningGate,
	type CompressReasoningConfig,
	countThinkingChars,
	dropCompressReasoning,
	resolveReasoningDrop,
} from "./reasoning-drop.js";
import { SessionStateStore } from "./state.js";
import { carryHostSystemMessages } from "./system-passthrough.js";
import { buildAcpSystemPrompt } from "./system-prompt.js";
import { collectCoveredMessageIds, collectImageTokens, estimateTokens, modelSupportsImages } from "./tokens.js";
import { sanitizeToolPairing } from "./tool-pair-sanitizer.js";
import {
	type BiliRuntime,
	isCompressNoopText,
	isCompressSuccessText,
	MAX_COMPRESS_ATTEMPTS,
	makeCompressTool,
	makeDecompressTool,
	makeSearchTool,
	makeStatusTool,
} from "./tools.js";

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
			const window2 =
				usage?.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : (ctx.model?.contextWindow ?? 0);
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

function nudgeMessageText(
	nudge: NudgeDecision,
	blocks: { blockId: string; tier: number; summary: string; compressedTokens: number }[],
	prompts: Prompts,
): string {
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
		const ids = blocks
			.slice(0, 10)
			.map((b) => b.blockId)
			.join(", ");
		const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
		lines.push(
			"",
			`Compressed blocks: ${blocks.length} active (${tierStr}) — ${formatK2(totalSummary)} summary, ${formatK2(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`,
		);
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

	// ---------------------------------------------------------------------------
	// 原生能力保障：接管是**有条件的**，任何异常路径都让路给 owl 原生 compaction。
	//
	// - 手动 /compact（reason === "manual"）：永远放行——用户的显式请求必须生效，
	//   投影层已能消化原生 compaction 条目（见 messages.ts 的 nativeSummaryText）。
	// - 本会话 context 改写抛过错（degraded）：放行，原生阈值/溢出兜底重新生效。
	// - 内核报告 terminalEscape（压缩与截断都救不了，#300 信号）：放行，让原生
	//   compaction 救场。
	// - 原生 compaction 实际跑完（session_compact）：清除降级/终局标记，插件复位
	//   重新接管；若故障是持续性的会立刻再次降级（每次都记日志）。
	// - 插件整体停用时本模块不会被加载，任何钩子都不存在，原生行为零改动。
	// ---------------------------------------------------------------------------
	const degraded = new Set<string>();
	const terminalEscapeSeen = new Set<string>();

	// 压缩哲学 + 工具说明进系统提示（before_agent_start 支持整轮替换）。
	pi.on("before_agent_start", (event) => {
		// 哲学文本按内核默认刷新（上游支持用户覆盖，这里未移植）。
		runtime.setPrompts(resolvePrompts({}, { acknowledgeRisk: true }));
		const acp = buildAcpSystemPrompt(runtime.prompts());
		return { systemPrompt: `${event.systemPrompt}\n\n${acp}` };
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason === "manual") return undefined;
		const sid = ctx.sessionManager.getSessionId();
		if (degraded.has(sid) || terminalEscapeSeen.has(sid)) return undefined;
		return { cancel: true };
	});

	// 原生 compaction 实际发生（手动放行或降级兜底）：复位标记，插件重新接管。
	pi.on("session_compact", (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		degraded.delete(sid);
		terminalEscapeSeen.delete(sid);
	});

	// 会话切换/关闭：丢弃该会话的进程内状态槽与记账。
	pi.on("session_shutdown", (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile() ?? undefined;
		runtime.store.drop(file, sid);
		degraded.delete(sid);
		terminalEscapeSeen.delete(sid);
	});

	// 每轮 LLM 调用前的上下文改写（主路径）。整体故障开放：抛错 → 标记降级 +
	// 返回 undefined（宿主按原消息发送，原生 compaction 兜底重新生效），
	// 绝不阻塞会话。
	pi.on("context", async (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		try {
			return await transformContext(pi, runtime, { degraded, terminalEscapeSeen }, event, ctx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`[owl-billion-context] context transform FAILED for session ${sid} — 本轮按原上下文发送，原生 compaction 兜底重新生效: ${message}`,
			);
			degraded.add(sid);
			return undefined;
		}
	});

	// 四个上下文管理工具。
	pi.registerTool(makeCompressTool(runtime));
	pi.registerTool(makeDecompressTool(runtime));
	pi.registerTool(makeSearchTool(runtime));
	pi.registerTool(makeStatusTool(runtime));
}

// ---------------------------------------------------------------------------
// context 改写主体（整体 try/catch 的保护对象）
// ---------------------------------------------------------------------------

type Flags = { degraded: Set<string>; terminalEscapeSeen: Set<string> };

async function transformContext(
	pi: ExtensionAPI,
	runtime: Runtime,
	flags: Flags,
	event: { type: "context"; messages: unknown[] },
	ctx: ExtensionContext,
): Promise<{ messages: ReturnType<typeof coreOutToAgentMessages> } | undefined> {
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
		const view = sentViewTokenCount(
			runtime.core,
			coreMessages,
			state,
			config,
			tokenCount,
			imageTokens,
			systemPromptTokens,
		);
		if (view.drifted) tokenCount = Math.max(view.viewTokens, hostTokens > 0 ? hostTokens : 0);
	}

	const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
	await runtime.save(turn.state, ctx);

	// 内核终局信号（#300）：压缩与截断都救不了 → 本会话放行原生 compaction。
	if (turn.terminalEscape) {
		if (!flags.terminalEscapeSeen.has(sid)) {
			flags.terminalEscapeSeen.add(sid);
			console.warn(
				`[owl-billion-context] terminal escape (stuck ${turn.terminalEscape.stuckEvents} turns at ${Math.round(turn.terminalEscape.usage * 100)}%) — native compaction will take over for this session`,
			);
		}
	} else {
		flags.terminalEscapeSeen.delete(sid);
	}

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

	// 宿主 system 消息回带（防御式：owl 的 context 事件已滤掉 system、由
	// runner 的 restoreSystemMessages 回填，此处对无 system 的输入是 no-op）。
	rebuilt = carryHostSystemMessages(rebuilt, event.messages as never[]) ?? rebuilt;

	// 孤儿 toolResult 兜底（折叠吞掉配对 call 时防上游 400）。
	if (turn.state.blocks.length > 0) {
		const sanitized = sanitizeToolPairing(rebuilt);
		if (sanitized.droppedResults.length > 0) {
			rebuilt = sanitized.messages;
			console.warn(
				`[owl-billion-context] dropped ${sanitized.droppedResults.length} orphaned tool result(s): ${sanitized.droppedResults.join(", ")}`,
			);
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
				: Math.min(
						config.nudge.growthCap,
						Math.max(config.nudge.growthFloor, Math.round(config.modelContextLimit * config.nudge.growthRatio)),
					);
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
			const text = nudgeMessageText(
				turn.nudge,
				turn.state.blocks.filter((b) => b.active),
				runtime.prompts(),
			);
			rebuilt.push({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			} as (typeof rebuilt)[number]);
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
}
