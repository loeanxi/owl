/**
 * 四个上下文管理工具 — 参照 billion-context-pi 的 compress-tool / decompress-tool /
 * search-tool / status-tool（MIT）重写，按 owl 的 ToolDefinition 形状注册。
 *
 * 相比上游裁掉：message-ref 级 decompress（只留块级）、会话树/祖先日志回退、
 * 死引用重复熔断、prompt pack 覆盖、symlink 加固的 toFile 白名单（用固定
 * 安全目录代替）。
 */

import type { AgentToolResult, ExtensionContext, SessionEntry, ToolDefinition } from "@owl/owl-coding-agent";
import { type Static, Type } from "typebox";
import { assertNotAborted } from "./abort.js";
import { getSystemPromptText } from "./compat.js";
import {
	blockDocs,
	type CompressionBlock,
	type CompressionCore,
	type CompressionState,
	type CompressParseDiagnostics,
	type Config,
	collectBlockContent,
	formatRanges,
	type NudgeDecision,
	parseBlockIdArg,
	parseCompressArgs,
	searchBlocks,
	viableRanges,
} from "./kernel.js";
import type { entriesToCoreMessages } from "./messages.js";
import type { SessionStateStore } from "./state.js";
import {
	adjustedTokenCount,
	collectCoveredMessageIds,
	collectImageTokens,
	estimateTokens,
	modelSupportsImages,
} from "./tokens.js";

// ---------------------------------------------------------------------------
// 运行时接口（由 index.ts 提供）
// ---------------------------------------------------------------------------

export interface BiliRuntime {
	core: CompressionCore;
	store: SessionStateStore;
	stateFor(ctx: ExtensionContext): Promise<{
		state: CompressionState;
		coreMessages: ReturnType<typeof entriesToCoreMessages>;
		entries: SessionEntry[];
	}>;
	save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
	configFor(ctx: ExtensionContext): Config;
	nudgeOf(ctx: ExtensionContext): Promise<NudgeDecision | undefined>;
	/** 本轮 compress 失败/空转计数；达到上限返回 cappedNow=true。 */
	noteCompressOutcome(
		sid: string,
		turnKey: string,
		outcome: { isError: boolean; success: boolean; noop: boolean },
	): { count: number; cappedNow: boolean };
	compressRetryCappedFor(sid: string, turnKey: string): boolean;
}

// ---------------------------------------------------------------------------
// 共用小件
// ---------------------------------------------------------------------------

export function formatK(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function paddedRef(n: number): string {
	return `m${String(n).padStart(5, "0")}`;
}

/** issue #376：报告每个新块的实际覆盖 span（内核保护排除/完整性收缩可能
 *  事后收窄区间），`*` 标记 span 里有存在但未被覆盖的 ref；tier≥2 带标记。 */
export function blockSpanLabel(block: CompressionBlock, state: CompressionState): string {
	const nums: number[] = [];
	for (const id of block.effectiveMessageIds) {
		const ref = state.messageRefs.byRaw[id];
		if (!ref || !ref.startsWith("m")) continue;
		const n = Number(ref.slice(1));
		if (Number.isInteger(n) && n > 0) nums.push(n);
	}
	const tierMark = block.tier >= 2 ? `(T${block.tier})` : "";
	if (nums.length === 0) return `${block.blockId}${tierMark}`;
	let lo = Infinity;
	let hi = -Infinity;
	for (const n of nums) {
		if (n < lo) lo = n;
		if (n > hi) hi = n;
	}
	const present = new Set(nums);
	let star = "";
	for (let n = lo; n <= hi; n++) {
		if (!present.has(n) && state.messageRefs.byRef[paddedRef(n)] !== undefined) {
			star = "*";
			break;
		}
	}
	const span = lo === hi ? paddedRef(lo) : `${paddedRef(lo)}–${paddedRef(hi)}`;
	return `${block.blockId}${tierMark}=${span}${star}`;
}

/** 面板块数（成功/空转判定的极简版）：`▣ ACP | …, N blocks)` 或 span 列表。 */
export function compressPanelBlocks(text: string): number {
	if (!text.trimStart().startsWith("▣ ACP |")) return -1;
	const m = text.match(/, (\d+) blocks?\)/);
	if (m) return Number(m[1]);
	const idx = text.indexOf(", blocks: ");
	if (idx === -1) return -1;
	const header = text.slice(idx).split("\n", 1)[0] ?? "";
	return header.match(/\bb\d+(?:\(T\d+\))?=/g)?.length ?? 0;
}

export function isCompressSuccessText(text: string): boolean {
	return compressPanelBlocks(text) > 0;
}

export function isCompressNoopText(text: string): boolean {
	return compressPanelBlocks(text) === 0;
}

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

const RangeSpec = Type.Object({
	startId: Type.String({ description: 'Message ref, e.g. "m00005" (from the acp tag), or a block id "b3".' }),
	endId: Type.String({ description: "Inclusive end ref. Must be at or after startId." }),
	summary: Type.String({
		description:
			"Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.).",
	}),
	topic: Type.Optional(
		Type.String({
			description:
				"Short label (3-5 words) for THIS range. Give each unrelated range its own topic for better quality.",
		}),
	),
});

const CompressParams = Type.Object({
	topic: Type.Optional(Type.String({ description: "Fallback topic for entries without their own." })),
	content: Type.Union([
		Type.Array(RangeSpec),
		Type.String({
			description:
				"JSON-encoded array of ranges — accepted because non-strict-tool providers sometimes stringify array arguments; parsed automatically.",
		}),
	]),
	summaryMaxChars: Type.Optional(
		Type.Number({ description: "Override max summary length (default max: 20000 chars)." }),
	),
});

type CompressArgs = Static<typeof CompressParams>;
type RangeEntry = Static<typeof RangeSpec>;

// 非严格工具调用的模型会把 content 序列化成各种坏形状 —— 内核宽松解析器
// 兜底之前先做两种确定性修复（上游 #480 裸对象、字符串尾断括号）。
function repairContentTail(args: CompressArgs): CompressArgs {
	if (typeof args.content !== "string") return args;
	const t = args.content.trimEnd();
	if (!t.endsWith("]")) return args;
	const body = t.slice(0, -1).trimEnd();
	if (!body.endsWith('"')) return args;
	const candidate = `${body}}]`;
	try {
		if (Array.isArray(JSON.parse(candidate))) return { ...args, content: candidate };
	} catch {
		// 不是缺右括号的情形
	}
	return args;
}

function repairBareRangeObjects(args: CompressArgs): CompressArgs {
	if (typeof args.content !== "string") return args;
	const objects: Record<string, unknown>[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = -1;
	const s = args.content;
	for (let i = 0; i < s.length; i++) {
		const ch = s.charAt(i);
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" && depth === 0 && start === -1) start = i;
		if (ch === "{" || ch === "[") depth++;
		if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0 && start !== -1) {
				const candidate = s.slice(start, i + 1);
				try {
					const o = JSON.parse(candidate) as Record<string, unknown>;
					const hasStart = typeof o.startId === "string" || typeof o.startRef === "string";
					const hasEnd = typeof o.endId === "string" || typeof o.endRef === "string";
					if (hasStart && hasEnd && typeof o.summary === "string" && o.summary.length > 0) objects.push(o);
				} catch {
					// 跳过非 range 形状的段
				}
				start = -1;
			}
			if (depth < 0) {
				depth = 0;
				start = -1;
			}
		}
	}
	if (objects.length === 0) return args;
	return { ...args, content: JSON.stringify(objects) };
}

function describeDiagnostics(diagnostics: CompressParseDiagnostics, content: CompressArgs["content"]): string {
	const shape =
		typeof content === "string"
			? "a JSON-encoded string (non-strict-tool providers stringify array arguments)"
			: content === null
				? "null"
				: `a ${typeof content}`;
	const base = `Invalid compress content (${diagnostics.kind}): got ${shape}`;
	if (diagnostics.invalidItems > 0) {
		return `${base}; ${diagnostics.invalidItems} entr${diagnostics.invalidItems === 1 ? "y was" : "ies were"} dropped as invalid. Each range must be an object with string fields startId, endId, summary.`;
	}
	return `${base}. content must be an ARRAY of {startId, endId, summary} objects.`;
}

export function normalizeRanges(args: CompressArgs): RangeEntry[] | string {
	const effective = repairBareRangeObjects(repairContentTail(args));
	const { ranges, diagnostics } = parseCompressArgs(effective);
	if (ranges.length === 0) {
		if (Array.isArray(effective.content) && effective.content.length === 0) return [];
		return describeDiagnostics(diagnostics, effective.content);
	}
	return ranges.map((r) => ({ startId: r.startRef, endId: r.endRef, summary: r.summary, topic: r.topic }));
}

function cappedRejectionText(snapshot: string, maxAttempts: number): string {
	return [
		"▣ ACP | 0 → 0 tokens (~0 reclaimed, 0 blocks)",
		`[ACP] PAUSED — ${maxAttempts} compress attempts already failed this turn; further compress calls are rejected until the next user message.`,
		"",
		"Current compressible ranges (use these refs exactly as listed):",
		snapshot,
		"",
		"Continue the task; compress becomes available again on the next user message.",
	].join("\n");
}

export const MAX_COMPRESS_ATTEMPTS = 3;

function estimateCharsTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** 当前 user turn 的稳定 key（最后一条 user 条目 id）——compress 失败计数的
 *  作用域键：新用户消息自然重置，轮内多次 LLM 调用共享同一 key。 */
function lastUserTurnKey(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "message" && entry.message.role === "user") return entry.id;
	}
	return ctx.sessionManager.getSessionId();
}

export function makeCompressTool(runtime: BiliRuntime): ToolDefinition<typeof CompressParams> {
	return {
		name: "compress",
		label: "Compress",
		description:
			"Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary.",
		promptSnippet: "compress({ content: [{ startId, endId, summary }] }) or batch multiple ranges",
		promptGuidelines: [
			"Each message has an acp tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
			"Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
			"Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
			"Never compress content the current step is actively using.",
		],
		parameters: CompressParams,
		execute: async (_toolCallId, rawParams, signal, _onUpdate, ctx): Promise<AgentToolResult> => {
			assertNotAborted(signal);
			const args = rawParams as CompressArgs;
			const sid = ctx.sessionManager.getSessionId();
			const turnKey = lastUserTurnKey(ctx);
			const { state: initialState, coreMessages, entries } = await runtime.stateFor(ctx);
			const config = runtime.configFor(ctx);
			const systemPromptText = getSystemPromptText(ctx);
			const systemPromptTokens = systemPromptText ? estimateCharsTokens(systemPromptText) : 0;
			const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
			const sentTokens =
				estimateTokens(coreMessages, collectCoveredMessageIds(initialState), imageTokens) + systemPromptTokens;
			const tokenCount = adjustedTokenCount(
				runtime.core,
				coreMessages,
				initialState,
				config,
				sentTokens,
				imageTokens,
				systemPromptTokens,
			);

			// 先跑一轮 processTurn：拿当前 nudge（其 compressibleRanges 就是可压清单，
			// 同时让 emergency-truncate 在必要时先收紧工具输出）。
			const turn = runtime.core.processTurn({ messages: coreMessages, state: initialState, config, tokenCount });
			await runtime.save(turn.state, ctx);

			// 参数解析失败必须 THROW（owl 只对 throw 置 isError:true，失败计数依赖它）。
			const maybeRanges = normalizeRanges(args);
			if (typeof maybeRanges === "string") throw new Error(maybeRanges);
			const ranges = maybeRanges;
			if (ranges.length === 0)
				return { details: undefined, content: [{ type: "text", text: "No ranges provided." }] };

			if (runtime.compressRetryCappedFor(sid, turnKey)) {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: cappedRejectionText(
								formatRanges(viableRanges(turn.nudge?.compressibleRanges ?? []), []),
								MAX_COMPRESS_ATTEMPTS,
							),
						},
					],
				};
			}

			const applied = runtime.core.applyCompression({
				ranges: ranges.map((r) => ({
					startRef: r.startId,
					endRef: r.endId,
					summary: r.summary,
					...(r.topic || args.topic ? { topic: r.topic ?? args.topic } : {}),
					...(args.summaryMaxChars !== undefined ? { summaryMaxChars: args.summaryMaxChars } : {}),
				})),
				messages: coreMessages,
				state: turn.state,
				config,
			});
			await runtime.save(applied.state, ctx);

			const { blocksCreated, tokensCompressed, errors, warnings } = applied.result;
			const outcomeText = buildCompressReceipt(applied.state, { blocksCreated, tokensCompressed, errors, warnings });
			runtime.noteCompressOutcome(sid, turnKey, {
				isError: false,
				success: isCompressSuccessText(outcomeText),
				noop: isCompressNoopText(outcomeText),
			});
			return { details: { blocksCreated, tokensCompressed }, content: [{ type: "text", text: outcomeText }] };
		},
	};
}

function buildCompressReceipt(
	state: CompressionState,
	result: { blocksCreated: number; tokensCompressed: number; errors: string[]; warnings: string[] },
): string {
	const active = state.blocks.filter((b) => b.active);
	const summaryTokens = active.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
	const lines = [
		`▣ ACP | ${formatK(result.tokensCompressed)} → ${formatK(summaryTokens)} tokens (~${formatK(Math.max(0, result.tokensCompressed - summaryTokens))} reclaimed, ${result.blocksCreated} blocks)`,
	];
	const newBlocks = state.blocks.slice(-result.blocksCreated);
	if (newBlocks.length > 0) {
		lines.push(`New blocks: ${newBlocks.map((b) => blockSpanLabel(b, state)).join(", ")}`);
	}
	for (const w of result.warnings) lines.push(`⚠️ ${w}`);
	if (result.errors.length > 0) {
		lines.push("", `Errors (${result.errors.length}):`);
		for (const e of result.errors) lines.push(`- ${e}`);
		lines.push("", "Re-issue the rejected ranges in a new compress call (other ranges in this call were applied).");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// decompress
// ---------------------------------------------------------------------------

const DecompressParams = Type.Object({
	blockId: Type.String({ description: 'Block id to restore, e.g. "b5".' }),
	full: Type.Optional(
		Type.Boolean({
			description: "If true, recurse through all nested blocks to original messages. Default: false (one tier up).",
		}),
	),
	inline: Type.Optional(
		Type.Boolean({
			description:
				"If true, return content inline as this tool's result. Default: false — content is written to a file to avoid context bloat.",
		}),
	),
});

type DecompressArgs = Static<typeof DecompressParams>;

export function makeDecompressTool(runtime: BiliRuntime): ToolDefinition<typeof DecompressParams> {
	return {
		name: "decompress",
		label: "Decompress",
		description:
			"Read back a previously compressed block's content by block id (see acp_status / nudge for block ids). The block STAYS compressed — context and cache prefix are not disrupted. By DEFAULT the content is written to a file (blocks can be large); use the read tool to view it, or pass inline:true to return it in this tool's result. full:true recurses to original messages.",
		promptSnippet: 'decompress({ blockId: "b5" }) or decompress({ blockId: "b5", inline: true })',
		promptGuidelines: [
			"Decompress when you need exact details lost in compression (file contents, error messages, signatures).",
			"Use search_context first to find the right block.",
			"Block decompress writes to a file by default; inline:true only for small content you accept adding to context.",
		],
		parameters: DecompressParams,
		execute: async (_toolCallId, rawParams, signal, _onUpdate, ctx): Promise<AgentToolResult> => {
			assertNotAborted(signal);
			const args = rawParams as DecompressArgs;
			const blockId = parseBlockIdArg(args.blockId);
			if (!blockId) throw new Error(`Invalid blockId: ${args.blockId}. Use a block id like "b5" (see acp_status).`);
			const { state, coreMessages } = await runtime.stateFor(ctx);
			const block = state.blocks.find((b) => b.blockId === blockId);
			if (!block)
				throw new Error(`Block ${blockId} does not exist in this session. Call acp_status for the block list.`);
			const collected = collectBlockContent(state, block, coreMessages, { full: args.full === true });
			if (collected.count === 0)
				return {
					details: undefined,
					content: [{ type: "text", text: `Block ${blockId} has no restorable content.` }],
				};

			if (args.inline !== true) {
				const { writeFile, mkdir } = await import("node:fs/promises");
				const { join } = await import("node:path");
				const { homedir, tmpdir } = await import("node:os");
				// 尊重 owl 改造版的配置目录隔离（OWL_CODING_AGENT_DIR），默认 ~/.owl。
				const agentDir = process.env.OWL_CODING_AGENT_DIR || join(homedir() || tmpdir(), ".owl");
				const dir = join(agentDir, "billion-context", "decompress");
				await mkdir(dir, { recursive: true });
				const file = join(dir, `${blockId}-${Date.now()}.txt`);
				await writeFile(file, collected.text, { encoding: "utf8", mode: 0o600 });
				return {
					details: { file, count: collected.count },
					content: [
						{
							type: "text",
							text: `Block ${blockId} (${collected.count} item(s), ${formatK(collected.text.length)} chars) written to ${file}. The block stays compressed — use the read tool to view it.`,
						},
					],
				};
			}
			return {
				details: { count: collected.count },
				content: [{ type: "text", text: `[Decompressed ${blockId} — still folded]\n\n${collected.text}` }],
			};
		},
	};
}

// ---------------------------------------------------------------------------
// search_context
// ---------------------------------------------------------------------------

const SearchParams = Type.Object({
	query: Type.String({ description: "Keywords to locate detail folded into compressed summaries." }),
	limit: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
});

type SearchArgs = Static<typeof SearchParams>;

export function makeSearchTool(runtime: BiliRuntime): ToolDefinition<typeof SearchParams> {
	return {
		name: "search_context",
		label: "Search Context",
		description:
			"Search compressed block summaries by keyword. Use to cheaply locate which block holds detail before decompressing. Returns block ids with topic/summary previews.",
		promptSnippet: 'search_context({ query: "auth token" })',
		promptGuidelines: [
			"Search locates detail folded into summaries — cheaper than decompressing blind.",
			"Each result shows a block id; decompress that block for full content.",
		],
		parameters: SearchParams,
		execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult> => {
			const args = rawParams as SearchArgs;
			const { state } = await runtime.stateFor(ctx);
			// BM25 引擎（与上游 search-tool 同源），对块 topic+summary 建档。
			const hits = searchBlocks(blockDocs(state), args.query, { limit: args.limit ?? 8 });
			const limit = args.limit ?? 8;
			if (hits.length === 0) {
				return {
					details: undefined,
					content: [
						{ type: "text", text: `No matches for "${args.query}" across ${state.blocks.length} block(s).` },
					],
				};
			}
			const lines = [
				`Found ${Math.min(hits.length, limit)} match(es) for "${args.query}" (searched ${state.blocks.length} blocks):`,
			];
			for (const hit of hits.slice(0, limit)) {
				const b = state.blocks.find((blk) => blk.blockId === hit.blockId);
				if (!b) continue;
				const summary = (b.summary || "").replace(/\s+/g, " ").slice(0, 200);
				lines.push(
					"",
					`${b.blockId} (T${b.tier}${b.topic ? `, "${b.topic}"` : ""}, score ${hit.score.toFixed(2)}) — ${b.effectiveMessageIds.length} msgs`,
					`  ${summary}${(b.summary || "").length > 200 ? "…" : ""}`,
				);
			}
			return { details: undefined, content: [{ type: "text", text: lines.join("\n") }] };
		},
	};
}

// ---------------------------------------------------------------------------
// acp_status
// ---------------------------------------------------------------------------

const StatusParams = Type.Object({});

export function makeStatusTool(runtime: BiliRuntime): ToolDefinition<typeof StatusParams> {
	return {
		name: "acp_status",
		label: "ACP Status",
		description:
			"Context status: token usage, active compression blocks, and the current list of compressible ranges (with their mNNNNN refs and sizes). Call with no args.",
		promptSnippet: "acp_status({})",
		promptGuidelines: [
			"Call for a quick overview of context usage and compressible ranges.",
			"Use the reported refs exactly in your next compress call.",
		],
		parameters: StatusParams,
		execute: async (_toolCallId, _rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult> => {
			const { state, coreMessages } = await runtime.stateFor(ctx);
			const config = runtime.configFor(ctx);
			const systemPromptText = getSystemPromptText(ctx);
			const systemPromptTokens = systemPromptText ? estimateCharsTokens(systemPromptText) : 0;
			const sentTokens = estimateTokens(coreMessages, collectCoveredMessageIds(state)) + systemPromptTokens;
			const tokenCount = adjustedTokenCount(runtime.core, coreMessages, state, config, sentTokens);
			const report = runtime.core.status(state, tokenCount, config);
			const nudge = await runtime.nudgeOf(ctx);
			const ranges = viableRanges(nudge?.compressibleRanges ?? []);
			const lines = [
				`▣ ACP context status`,
				`Tokens: ${formatK(tokenCount)} / ${formatK(config.modelContextLimit)} (${Math.round(report.contextUsage * 100)}%)`,
				`Blocks: ${report.activeBlocks} active / ${report.totalBlocks} total · ${formatK(report.tokensCompressed)} tokens compressed so far`,
				`Breakdown: ${Object.entries(report.breakdown)
					.filter(([, v]) => v > 0)
					.map(([k, v]) => `${formatK(v)} ${k}`)
					.join(" | ")}`,
				"",
				"Compressible ranges (refs as listed):",
				ranges.length > 0
					? formatRanges(ranges, nudge?.protectedRanges ?? [])
					: "(none — nothing worth compressing right now)",
			];
			return { details: undefined, content: [{ type: "text", text: lines.join("\n") }] };
		},
	};
}
