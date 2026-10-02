import type { ServerEventMessage } from "../bridge/protocol.ts";
import { summarizeToolCall } from "./summarize.ts";

export type ToolStatus = "running" | "ok" | "error";

/** 工具结果里的图片内容块（base64；如 browser_screenshot 的返回）。 */
export type ToolResultImage = { data: string; mimeType: string };

/** 工具输出：已从 content 解码成纯文本，不再是 JSON 字符串。 */
export type ToolOutput = {
	text: string;
	totalLines: number;
	images?: ToolResultImage[];
	/** bash 等超限截断时，服务端把全文写入的临时文件路径（details.fullOutputPath）。 */
	fullPath?: string;
};

export type ToolCard = {
	id: string;
	name: string;
	/** 原始参数 JSON（todo 清单解析等仍需要）。 */
	args: string;
	/** 人话摘要（动词 + 关键参数），替代裸 JSON 上屏。 */
	summary: string;
	/** 展开后的参数细节（完整命令/完整路径）。 */
	detail?: string;
	status: ToolStatus;
	/** 工具结果；流式期间尚无，agent_end 重建后由 toolResult 挂上。 */
	output?: ToolOutput;
};

export type ChatEntry =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; thinking: string; tools: ToolCard[]; error?: string }
	/** 仅防御性保留：结果找不到所属工具卡时的兜底行（如会话恢复失败）。 */
	| { kind: "toolResult"; toolName: string; ok: boolean; brief: string };

type AnyEvent = Record<string, any>; // wire events are forward-compat; render defensively

/**
 * 把供应商错误整理成可读中文。OpenAI 兼容 SDK 的报错形如
 * `429: {"code":"1308","message":"已达到 5 小时的使用上限。…"}`，
 * 裸上屏是一坨 JSON —— 这里解析出状态码与 message 再映射；解析不出就原样放行。
 */
export function formatProviderError(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const match = raw.match(/^\s*(\d{3})\s*[:\-]\s*(\{[\s\S]*\})\s*$/);
	if (match) {
		const status = match[1]!;
		let message = "";
		try {
			const body = JSON.parse(match[2]!) as { message?: string; error?: { message?: string } };
			message = body.message ?? body.error?.message ?? "";
		} catch {
			// body 不是 JSON：走下面的兜底文案
		}
		if (status === "429") return `额度或限流：${message || "请求过于频繁或额度已用尽，请稍后再试。"}`;
		if (status === "401" || status === "403") return `API 密钥无效或无权限：${message || raw}`;
		if (status.startsWith("5")) return `模型服务暂时不可用（HTTP ${status}）：${message || "请稍后重试。"}`;
		if (message) return `${message}（HTTP ${status}）`;
	}
	return raw;
}

function lastAssistant(entries: ChatEntry[]): (ChatEntry & { kind: "assistant" }) | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "assistant") return entry;
		if (entry.kind === "user") return undefined;
	}
	return undefined;
}

/** Apply one bridge event to the transcript. Returns a new array (immutably). */
export function applyEvent(entries: ChatEntry[], message: ServerEventMessage): ChatEntry[] {
	const event = message.event as AnyEvent;
	switch (event.type) {
		case "message_start": {
			// system/user 消息由 sendPrompt 或 rebuild 负责入列，这里只给 assistant 建流式气泡，
			// 否则每轮会多出带空"思考过程"的空气泡。
			const message = event.message as AnyEvent | undefined;
			if (!message || message.role !== "assistant") return entries;
			return [...entries, { kind: "assistant", text: "", thinking: "", tools: [] }];
		}
		case "message_update": {
			const ae = event.assistantMessageEvent as AnyEvent | undefined;
			if (!ae) return entries;
			const current = lastAssistant(entries);
			if (!current) return entries;
			const index = entries.indexOf(current);
			switch (ae.type) {
				case "text_delta":
					current.text += ae.delta ?? "";
					break;
				case "thinking_delta":
					current.thinking += ae.delta ?? "";
					break;
				case "toolcall_start": {
					const toolCall = ae.partial?.content?.[ae.contentIndex];
					current.tools.push({
						id: ae.toolCall?.id ?? `tool-${ae.contentIndex}`,
						name: ae.toolCall?.toolName ?? toolCall?.name ?? "tool",
						args: "",
						summary: ae.toolCall?.toolName ?? toolCall?.name ?? "tool",
						status: "running",
					});
					break;
				}
				case "toolcall_end": {
					const card = current.tools.find((tool) => tool.id === ae.toolCall?.id);
					if (card) {
						// 结果要等 agent_end 重建才回来，这里先把参数落上、换成人话摘要；
						// status 保持 running（结果未知，不假装完成）。
						card.args = JSON.stringify(ae.toolCall?.arguments ?? {});
						const summarized = summarizeToolCall(card.name, ae.toolCall?.arguments);
						card.summary = summarized.summary;
						card.detail = summarized.detail;
					}
					break;
				}
				default:
					break;
			}
			return [...entries.slice(0, index), { ...current }, ...entries.slice(index + 1)];
		}
		case "message_end": {
			const message = event.message as AnyEvent | undefined;
			if (!message || message.role !== "assistant") return entries;
			const current = lastAssistant(entries);
			if (!current) return entries;
			const index = entries.indexOf(current);
			const text = (message.content ?? [])
				.filter((part: AnyEvent) => part.type === "text")
				.map((part: AnyEvent) => part.text)
				.join("\n");
			return [
				...entries.slice(0, index),
				{ ...current, text: text || current.text },
				...entries.slice(index + 1),
			];
		}
		case "agent_end": {
			// Authoritative rebuild: messages include tool results the stream didn't show.
			// 注意 event.messages 只含"本轮" agent run（从本次 user 消息起），不含更早轮次——
			// 整表替换会把历史覆盖掉（表现为"一回答完，前面的对话全没了"）。
			// 因此只重建最后一条用户消息之后的部分，之前的转录原样保留。
			const messages = (event.messages ?? []) as AnyEvent[];
			const rebuilt = rebuild(messages);
			let lastUser = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].kind === "user") {
					lastUser = i;
					break;
				}
			}
			if (lastUser === -1) return entries.length > 0 ? entries : rebuilt;
			return [...entries.slice(0, lastUser), ...rebuilt];
		}
		default:
			return entries;
	}
}

/** Rebuild the transcript from a full AgentMessage[] snapshot. */
export function rebuild(messages: AnyEvent[]): ChatEntry[] {
	const entries: ChatEntry[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			entries.push({ kind: "user", text: textOf(message.content) });
		} else if (message.role === "assistant") {
			const tools: ToolCard[] = (message.content ?? [])
				.filter((part: AnyEvent) => part.type === "toolCall")
				.map((part: AnyEvent) => ({
					id: part.id,
					name: part.name,
					args: JSON.stringify(part.arguments ?? {}),
					...summarizeToolCall(part.name, part.arguments),
					// 失败结果随后由 toolResult 覆盖；先按成功占位
					status: "ok" as const,
				}));
			entries.push({
				kind: "assistant",
				text: textOf(message.content),
				thinking: (message.content ?? [])
					.filter((part: AnyEvent) => part.type === "thinking")
					.map((part: AnyEvent) => part.thinking ?? "")
					.join("\n"),
				tools,
				error:
					message.stopReason === "error" || message.stopReason === "aborted"
						? formatProviderError(message.errorMessage)
						: undefined,
			});
		} else if (message.role === "toolResult") {
			// 结果不再单独成行：挂回对应工具卡（时间轴按「工具」组织，成败随之）
			const output = toolOutputOf(message);
			const card = findToolCard(entries, message.toolCallId);
			if (card) {
				card.status = message.isError ? "error" : "ok";
				card.output = output;
			} else {
				// 找不到所属调用（防御）：退回独立的兜底行
				entries.push({
					kind: "toolResult",
					toolName: message.toolName ?? "tool",
					ok: !message.isError,
					brief: firstTextLine(output.text) || `（${message.isError ? "失败" : "完成"}，无文本输出）`,
				});
			}
		}
	}
	return entries;
}

/** 按 toolCallId 向前找所属工具卡（结果总在调用之后）。 */
function findToolCard(entries: ChatEntry[], toolCallId: unknown): ToolCard | undefined {
	if (typeof toolCallId !== "string") return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "user") return undefined;
		if (entry.kind !== "assistant") continue;
		const card = entry.tools.find((tool) => tool.id === toolCallId);
		if (card) return card;
	}
	return undefined;
}

/** 把 toolResult 消息解码成结构化输出：纯文本拼接（不再 stringify 数组）、图片、全文路径。 */
function toolOutputOf(message: AnyEvent): ToolOutput {
	const content = (message.content ?? []) as AnyEvent[];
	const text = content
		.filter((part: AnyEvent) => part.type === "text")
		.map((part: AnyEvent) => part.text ?? "")
		.join("\n");
	const images = content
		.filter((part: AnyEvent) => part.type === "image" && part.data)
		.map((part: AnyEvent) => ({ data: part.data, mimeType: part.mimeType ?? "image/png" }));
	const details = (message.details ?? {}) as AnyEvent;
	return {
		text,
		totalLines: text === "" ? 0 : text.split("\n").length,
		...(images.length > 0 ? { images } : {}),
		...(typeof details.fullOutputPath === "string" ? { fullPath: details.fullOutputPath } : {}),
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function firstTextLine(text: string): string {
	return text.split("\n").find((part) => part.trim() !== "") ?? "";
}
