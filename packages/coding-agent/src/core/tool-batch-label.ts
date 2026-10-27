/**
 * 工具批次的模型撰写标题（Claude 的 `tool_use_summary`）。
 *
 * Claude Desktop 界面上，一个工具组的组头是一句**模型写的**标签
 * （"Searched code"），不是前端按参数拼出来的摘要。Claude Code 的做法是：
 * 一批工具跑完后，另起一次**不带任何工具**的模型请求，把这批工具的
 * 名字 / 入参 / 输出一并给它，只问一句 "Label:"，让它用一句话概括。
 * 回答就是组头，事件形状是 `{ summary, precedingToolUseIds }`。
 *
 * 证据（claude-code CLI bundle，逐字可查）：
 *  - 系统提示词 `Uc`：见 {@link TOOL_BATCH_LABEL_SYSTEM_PROMPT}。
 *  - 用户提示词：`User's intent (from assistant's last message): …`
 *    + `Tools completed:` + 每条 `Tool: / Input: / Output:` + `Label:`。
 *  - 入参 / 输出各截到 300 字符；回答取第一行（`vr()` 就是取首行）。
 *
 * owl 的对应实现就是本模块：一次独立的、tool-free 的模型调用。
 * 失败、超时、被中断一律返回 undefined —— 前端回退到按动词表合成的兜底标题。
 */

import type { AgentToolBatch, StreamFn } from "@earendil-works/pi-agent-core";
import { contentText, normalizeContext, type RetryPolicy } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSummarization } from "./compaction/compaction.ts";

/**
 * Claude Code 原文的系统提示词。
 *
 * 「过去时 + 最有辨识度的名词，先砍冠词、连词和冗长路径」是 Claude 标题的
 * 语法底色 —— 照抄，不要自己另立一套措辞。
 */
export const TOOL_BATCH_LABEL_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`;

/** 单个字段（入参 / 输出）的截断上限，与 Claude 一致。 */
const MAX_FIELD_CHARS = 300;

/** 用户意图的截断上限，与 Claude 一致。 */
const MAX_INTENT_CHARS = 200;

/** 标签的安全上限：模型偶尔会跑题，超长就砍掉（界面本身还会再截一次）。 */
const MAX_LABEL_CHARS = 80;

/** 把任意值序列化成一段可读的短文本。 */
function shortField(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = "[unserializable]";
	}
	if (text.length <= MAX_FIELD_CHARS) return text;
	return `${text.slice(0, MAX_FIELD_CHARS - 3)}...`;
}

/**
 * 组装用户提示词。
 *
 * 结构照搬 Claude：先说用户意图，再逐条列工具，最后一个 `Label:` 收尾。
 */
export function buildToolBatchLabelPrompt(batch: AgentToolBatch): string {
	const intent = batch.lastAssistantText?.trim();
	const tools = batch.toolCalls
		.map((call) => `Tool: ${call.name}\nInput: ${shortField(call.input)}\nOutput: ${shortField(call.output)}`)
		.join("\n\n");
	const intentBlock =
		intent === undefined || intent === ""
			? ""
			: `User's intent (from assistant's last message): ${intent.slice(0, MAX_INTENT_CHARS)}\n\n`;
	return `${intentBlock}Tools completed:\n\n${tools}\n\nLabel:`;
}

/**
 * 把模型的回答收拾成一行标签。
 *
 * Claude 的 `vr()` 就是「取首行」，这里额外去掉包裹的引号和多余空白。
 */
export function normalizeToolBatchLabel(raw: string): string | undefined {
	const firstLine = raw.split("\n").find((line) => line.trim() !== "");
	if (firstLine === undefined) return undefined;
	let label = firstLine.trim();
	if ((label.startsWith('"') && label.endsWith('"')) || (label.startsWith("'") && label.endsWith("'"))) {
		label = label.slice(1, -1).trim();
	}
	if (label.startsWith("`") && label.endsWith("`")) label = label.slice(1, -1).trim();
	if (label.length > MAX_LABEL_CHARS) label = `${label.slice(0, MAX_LABEL_CHARS - 1)}…`;
	return label === "" ? undefined : label;
}

export interface GenerateToolBatchLabelOptions {
	/** 生成标签用的模型（与当前会话同一个）。 */
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	sessionId?: string;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
}

/**
 * 为一批工具调用生成一句模型撰写的标题。
 *
 * 任何异常（网络、鉴权、超时、模型返回空）都吞掉并返回 undefined：
 * 组头只是锦上添花，不能因此影响主流程。
 */
export async function generateToolBatchLabel(
	batch: AgentToolBatch,
	options: GenerateToolBatchLabelOptions,
): Promise<string | undefined> {
	if (batch.toolCalls.length === 0) return undefined;
	const requestOptions: SimpleStreamOptions = {
		// 标签只有一行，几十个 token 足够；压低上限避免模型展开写。
		maxTokens: 128,
		signal: options.signal,
		apiKey: options.apiKey,
		headers: options.headers,
		env: options.env,
		sessionId: options.sessionId,
	};
	try {
		const response = await completeSummarization(
			options.model,
			normalizeContext({
				systemPrompt: TOOL_BATCH_LABEL_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildToolBatchLabelPrompt(batch) }],
						timestamp: Date.now(),
					},
				],
			}),
			requestOptions,
			options.streamFn,
			options.retry,
		);
		if (response.stopReason === "aborted") return undefined;
		return normalizeToolBatchLabel(contentText(response.content));
	} catch {
		return undefined;
	}
}
