import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { resolvePath } from "../utils/paths.ts";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionManager,
} from "./session-manager.ts";

type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];

/** Serialize the current branch and optional export-only entries as JSONL. */
export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const entries: object[] = [header];
	let parentId: string | null = null;
	for (const entry of sessionManager.getBranch()) {
		entries.push({ ...entry, parentId });
		parentId = entry.id;
	}
	entries.push(...(createTrailingEntries?.(parentId, timestamp) ?? []));
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Write the current session branch and optional export-only entries as JSONL. */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: TrailingEntries,
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(filePath, serializeSessionBranch(sessionManager, createTrailingEntries));
	return filePath;
}

/** 清洗导出文件名：非法字符换成下划线，压到 80 字以内（与前端 blob 下载处同一套语义）。 */
export function sanitizeExportFilename(name: string): string {
	return name
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

/** 由会话显示名（缺失时用 id 前 8 位）+ 会话开始时间拼导出文件名。 */
export function buildSessionExportFilename(input: {
	sessionId: string;
	displayName?: string;
	startedAt?: string;
	ext: "jsonl" | "markdown";
}): string {
	const base = sanitizeExportFilename(input.displayName?.trim() || "") || input.sessionId.slice(0, 8);
	const date = input.startedAt ? new Date(input.startedAt) : undefined;
	let stamp = "";
	if (date && !Number.isNaN(date.getTime())) {
		const pad = (n: number): string => String(n).padStart(2, "0");
		stamp = `-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	}
	return `${base}${stamp}.${input.ext === "jsonl" ? "jsonl" : "md"}`;
}

/** 取会话显示名（最后一个 session_info 条目），缺失返回 undefined。 */
export function sessionDisplayName(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type === "session_info" && entry.name) return entry.name;
	}
	return undefined;
}

/** 一轮可勾选的会话历史：一条用户消息 + 其后到下一条用户消息前的全部条目。 */
export interface SessionTurnSummary {
	/** 该轮用户消息的条目 id（勾选导出时回传 turnEntryIds）。 */
	entryId: string;
	/** 用户消息纯文本预览（只拼 text 块；纯图片消息为空串，由 UI 兜底占位）。 */
	text: string;
	timestamp: string;
	/** 该轮包含的分支条目数（含用户消息自身），仅供 UI 展示。 */
	entryCount: number;
}

function textOfUserMessage(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text?: string } => (part as { type?: string })?.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** 按用户消息把当前分支切成轮次；用户消息前的序条（session_info 等）不属于任何轮。 */
export function listSessionTurns(entries: readonly SessionEntry[]): SessionTurnSummary[] {
	const turns: SessionTurnSummary[] = [];
	let current: SessionTurnSummary | undefined;
	for (const entry of entries) {
		const message = entry.type === "message" ? (entry.message as { role?: string; content?: unknown }) : undefined;
		if (message?.role === "user") {
			current = {
				entryId: entry.id,
				text: textOfUserMessage(message.content),
				timestamp: entry.timestamp,
				entryCount: 1,
			};
			turns.push(current);
			continue;
		}
		if (current) current.entryCount += 1;
	}
	return turns;
}

/**
 * 按勾选的轮次（用户消息条目 id）过滤分支条目：只保留被选轮次的成员，
 * 保持原有顺序；用户消息前的序条与未选轮次一律不进导出。
 */
export function filterEntriesToTurns(
	entries: readonly SessionEntry[],
	turnEntryIds: readonly string[],
): SessionEntry[] {
	const selected = new Set(turnEntryIds);
	const filtered: SessionEntry[] = [];
	let inTurn = false;
	for (const entry of entries) {
		const message = entry.type === "message" ? (entry.message as { role?: string }) : undefined;
		if (message?.role === "user") inTurn = selected.has(entry.id);
		if (inTurn) filtered.push(entry);
	}
	return filtered;
}

/** 从文件全量条目解析 header 与当前分支（leaf 取文件最后一条，沿 parentId 回溯到根）。 */
export function resolveCurrentBranch(fileEntries: readonly FileEntry[]): {
	header: SessionHeader;
	branch: SessionEntry[];
} {
	const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "",
		timestamp: "",
		cwd: "",
	};
	const byId = new Map<string, SessionEntry>();
	let leaf: SessionEntry | undefined;
	for (const entry of fileEntries) {
		if (entry.type === "session") continue;
		byId.set(entry.id, entry);
		leaf = entry;
	}
	const branch: SessionEntry[] = [];
	let current = leaf;
	while (current) {
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	return { header, branch };
}

function formatStamp(ts: string | number | undefined): string {
	if (ts === undefined) return "";
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 选一堵比正文里任何反引号串都长的围栏，避免内容提前闭合代码块。 */
function codeFence(text: string): string {
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

/** 纯文本/富文本统一成 markdown 正文；图片块不导出 base64，只留占位说明。 */
function renderContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) =>
			block.type === "text"
				? block.text
				: `[图片 ${block.mimeType} · ${Math.round((block.data.length * 3) / 4 / 1024)} KB]`,
		)
		.join("\n\n");
}

function renderUsage(usage: Usage | undefined): string {
	if (!usage) return "";
	const parts = [`输入 ${usage.input.toLocaleString("en-US")}`, `输出 ${usage.output.toLocaleString("en-US")}`];
	if (usage.cacheRead > 0) parts.push(`缓存读 ${usage.cacheRead.toLocaleString("en-US")}`);
	if (usage.cacheWrite > 0) parts.push(`缓存写 ${usage.cacheWrite.toLocaleString("en-US")}`);
	if (usage.cost.total > 0) parts.push(`成本 $${usage.cost.total.toFixed(4)}`);
	return `> 用量：${parts.join(" · ")}\n`;
}

function renderToolCall(call: ToolCall): string {
	const args = JSON.stringify(call.arguments, null, 2);
	const fence = codeFence(args);
	return `**🔧 工具调用 \`${call.name}\`**\n\n${fence}json\n${args}\n${fence}\n`;
}

function renderAssistantMessage(message: AssistantMessage): string {
	const lines: string[] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (!block.thinking.trim()) continue;
			lines.push(`<details><summary>思考过程</summary>\n\n${block.thinking.trim()}\n\n</details>\n`);
		} else if (block.type === "text") {
			if (block.text.trim()) lines.push(`${block.text.trim()}\n`);
		} else {
			lines.push(renderToolCall(block));
		}
	}
	const usage = renderUsage(message.usage);
	if (usage) lines.push(usage);
	if (message.stopReason === "error" && message.errorMessage) lines.push(`> ⚠️ 出错：${message.errorMessage}\n`);
	return lines.join("\n");
}

function renderToolResult(message: ToolResultMessage): string {
	const fence = codeFence(renderContent(message.content));
	const marker = message.isError ? " ❌" : "";
	return `**🔧 工具结果 · \`${message.toolName}\`${marker}**\n\n${fence}\n${renderContent(message.content).trim()}\n${fence}\n`;
}

/**
 * 把当前分支的会话条目排版成可读 Markdown 转录：
 * 会话信息头 → 逐条消息（thinking 收进 details、工具调用/结果成对、每条助手附用量）→ 尾部汇总。
 * 只收 message/model_change/compaction/branch_summary 等有叙事意义的条目，
 * 纯元数据（label/context_edit/usage 条目）不进正文，usage 只进汇总。
 * 勾选导出时条目是分支的子集，displayName 用来从完整分支补会话名。
 */
export function formatSessionMarkdown(
	header: SessionHeader,
	entries: readonly SessionEntry[],
	options?: { displayName?: string },
): string {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let compactions = 0;
	const totals = { input: 0, output: 0, total: 0, cost: 0 };
	const modelChanges: string[] = [];

	const body: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message as UserMessage | AssistantMessage | ToolResultMessage | { role: string };
			const stamp = formatStamp("timestamp" in message ? (message.timestamp as number) : entry.timestamp);
			if (message.role === "user") {
				userMessages += 1;
				body.push(`## 👤 用户 · ${stamp}\n\n${renderContent((message as UserMessage).content).trim()}\n`);
			} else if (message.role === "assistant") {
				assistantMessages += 1;
				const assistant = message as AssistantMessage;
				toolCalls += assistant.content.filter((block) => block.type === "toolCall").length;
				totals.input += assistant.usage?.input ?? 0;
				totals.output += assistant.usage?.output ?? 0;
				totals.total += assistant.usage?.totalTokens ?? 0;
				totals.cost += assistant.usage?.cost?.total ?? 0;
				body.push(`## 🤖 助手 · ${assistant.model} · ${stamp}\n\n${renderAssistantMessage(assistant)}`);
			} else if (message.role === "toolResult") {
				const result = message as ToolResultMessage;
				if (result.isError) toolErrors += 1;
				body.push(renderToolResult(result));
			} else if (message.role === "custom") {
				const custom = entry.message as { customType?: string; content?: string | (TextContent | ImageContent)[] };
				body.push(
					`## 🧩 ${custom.customType ?? message.role} · ${stamp}\n\n${renderContent(custom.content ?? "").trim()}\n`,
				);
			}
		} else if (entry.type === "model_change") {
			const label = `${entry.provider}/${entry.modelId}`;
			modelChanges.push(label);
			body.push(`> 🔀 切换模型：\`${label}\` · ${formatStamp(entry.timestamp)}\n`);
		} else if (entry.type === "compaction") {
			compactions += 1;
			body.push(
				`> 🗜 上下文压缩（压缩前 ${entry.tokensBefore.toLocaleString("en-US")} tokens）· ${formatStamp(entry.timestamp)}\n`,
			);
		} else if (entry.type === "branch_summary") {
			body.push(`> 🌿 分支摘要：${entry.summary.trim()}\n`);
		}
	}

	const head: string[] = [
		`# Owl 会话：${options?.displayName ?? (sessionDisplayName(entries) || header.id || "（未命名）")}`,
		"",
	];
	head.push(`- 会话 ID：\`${header.id}\``);
	if (header.cwd) head.push(`- 工作目录：\`${header.cwd}\``);
	head.push(`- 开始时间：${formatStamp(header.timestamp) || "未知"}`);
	if (modelChanges.length > 0) head.push(`- 模型：${[...new Set(modelChanges)].join(" → ")}`);
	head.push("", "---", "");

	const tail: string[] = ["---", "", "## 汇总", ""];
	tail.push(
		`- 用户消息 ${userMessages} 条 · 助手回复 ${assistantMessages} 条 · 工具调用 ${toolCalls} 次${toolErrors > 0 ? `（失败 ${toolErrors} 次）` : ""}${compactions > 0 ? ` · 上下文压缩 ${compactions} 次` : ""}`,
	);
	tail.push(
		`- Token：输入 ${totals.input.toLocaleString("en-US")} · 输出 ${totals.output.toLocaleString("en-US")} · 合计 ${totals.total.toLocaleString("en-US")}`,
	);
	if (totals.cost > 0) tail.push(`- 成本合计：$${totals.cost.toFixed(4)}`);
	tail.push("");

	return `${[...head, ...body, ...tail]
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}
