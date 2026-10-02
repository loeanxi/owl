/**
 * owl 桌面桥的「向用户提问」扩展（ask_user_question 工具）。
 *
 * 由 @juicesharp/rpiv-ask-user-question 重写而来：原插件的终端渲染层构建在
 * pi-tui overlay 之上（owl 已移除 TUI），这里只移植它的纯逻辑层——参数
 * schema、归一化/校验、回答→LLM 的结果信封；交互层改为镜像 owl-permissions
 * 的 WebSocket 往返：broadcast question_request 给桌面 UI，挂起 Promise 等
 * question.response（或 abort/会话卸载时取消）。
 */

import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import type { InlineExtension } from "../../core/extensions/index.ts";
import type { DesktopServerMessage, QuestionAnswerPayload, QuestionPayload } from "./protocol.ts";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * 保留标签：UI 会自动给每题追加「其他」自由文本行，这些标签留给运行时
 * 哨兵行（以及 CC 习惯里的 "Other"），模型自定义同名 option 会被校验拒绝。
 */
export const RESERVED_LABELS = ["Other", "Type something.", "Next", "其他"] as const;

// ---------------------------------------------------------------------------
// 参数 schema（字段说明直接指导模型怎么出题）
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: MAX_LABEL_LENGTH,
		description: `最长 ${MAX_LABEL_LENGTH} 字符——硬限制，超限会被拒绝。选项的显示文本，用户看到并点选的就是它。要简短（1-5 个词）且说清这个选项是什么。`,
	}),
	description: Type.String({
		description:
			"说明这个选项的含义、选了会发生什么，或它的代价/权衡。给用户做决定提供上下文。",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"可选。选中/聚焦该选项时渲染的预览内容（markdown）。只用于用户需要直观对比的具体产物：界面原型、代码片段、示意图、配置示例。",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'要问用户的完整问题。要清晰、具体，以问号结尾。例："日期格式化用哪个库？"multiSelect 为 true 时相应改写措辞，如"要启用哪些功能？"',
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: `最长 ${MAX_HEADER_LENGTH} 字符——硬限制，超限会被拒绝。问题旁的极短标签/分组名。例："认证方式"、"选库"、"方案"。`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"这个问题的可选答案，2-4 个。每个选项应是互不相同的选择（开了 multiSelect 才可多选）。「其他」自由输入行由界面自动追加，不要自己写。",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description: "true 表示允许用户勾选多个选项（选项间不互斥时用）。",
		}),
	),
});

const AskUserQuestionParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: `要问用户的问题（1-${MAX_QUESTIONS} 个，一次打包问完，别连问多次）`,
	}),
});

type QuestionData = Static<typeof QuestionSchema>;
type AskUserQuestionParams = Static<typeof AskUserQuestionParamsSchema>;

// ---------------------------------------------------------------------------
// 校验（schema 之外的第二道防线，错误信息回给模型）
// ---------------------------------------------------------------------------

const ERROR_NO_QUESTIONS = "错误：至少需要一个问题";
const ERROR_TOO_MANY_QUESTIONS = `错误：一次调用最多 ${MAX_QUESTIONS} 个问题`;
const ERROR_DUPLICATE_QUESTION = "错误：同一调用内问题文本不能重复";
const ERROR_TOO_FEW_OPTIONS = `错误：每个问题至少需要 ${MIN_OPTIONS} 个选项`;
const ERROR_RESERVED_LABEL = `错误：选项标签是保留字（${RESERVED_LABELS.join("、")}），换一个标签`;
const ERROR_DUPLICATE_OPTION_LABEL = "错误：同一问题内选项标签不能重复";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

type QuestionnaireError =
	| "no_questions"
	| "too_many_questions"
	| "duplicate_question"
	| "empty_options"
	| "reserved_label"
	| "duplicate_option_label"
	| "no_ui";

type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireError; message: string };

/** reserved_label 必须先于 duplicate_option_label 判（否则保留字重复时报错语义错位）。 */
export function validateQuestionnaire(questions: QuestionData[]): ValidationResult {
	if (questions.length === 0) return { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS };
	if (questions.length > MAX_QUESTIONS) {
		return { ok: false, error: "too_many_questions", message: ERROR_TOO_MANY_QUESTIONS };
	}

	const seenQuestions = new Set<string>();
	for (const q of questions) {
		if (seenQuestions.has(q.question)) {
			return { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION };
		}
		seenQuestions.add(q.question);
	}

	for (const q of questions) {
		if (q.options.length < MIN_OPTIONS) {
			return { ok: false, error: "empty_options", message: ERROR_TOO_FEW_OPTIONS };
		}
		const seenLabels = new Set<string>();
		for (const o of q.options) {
			if (RESERVED_LABEL_SET.has(o.label)) {
				return { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL };
			}
			if (seenLabels.has(o.label)) {
				return { ok: false, error: "duplicate_option_label", message: ERROR_DUPLICATE_OPTION_LABEL };
			}
			seenLabels.add(o.label);
		}
	}

	return { ok: true };
}

// ---------------------------------------------------------------------------
// 归一化：模型可能在字符串参数里序列化出裸 \r（游标控制字节，不是文本）
// ---------------------------------------------------------------------------

function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function normalizeStringFields<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
	const out = { ...obj };
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string") out[key] = normalizeLineTerminators(value) as T[typeof key];
	}
	return out;
}

/** 归一化全部用户可见文本字段；必须在校验前跑（"其他\r" 不能绕过保留字检查）。 */
export function normalizeQuestionParams(params: AskUserQuestionParams): AskUserQuestionParams {
	return {
		...params,
		questions: params.questions.map((q) => ({
			...normalizeStringFields(q, ["question", "header"]),
			options: q.options.map((o) => normalizeStringFields(o, ["label", "description", "preview"])),
		})),
	};
}

// ---------------------------------------------------------------------------
// 结果信封（回答 → LLM 可读文本）
// ---------------------------------------------------------------------------

const DECLINE_MESSAGE =
	"用户没有回答这些问题（取消了提问）。不要当作拒绝，也不要自行猜测：用普通文本说明你需要哪个决策，等用户在后续消息里回答。";
const ENVELOPE_PREFIX = "用户已回答你的问题：";
const ENVELOPE_SUFFIX = "请根据用户的回答继续。";
const NO_INPUT_PLACEHOLDER = "（未作答）";

/** 一题的结构化答案（放进 details，信封文本由它投影）。 */
export interface AskUserAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	/** 单选题命中的选项若带 preview，原样回显给模型。 */
	preview?: string;
}

export interface AskUserDetails {
	answers: AskUserAnswer[];
	cancelled: boolean;
	error?: QuestionnaireError | "aborted" | "invalid_params";
}

function formatAnswerScalar(a: AskUserAnswer): string {
	switch (a.kind) {
		case "multi":
			return a.selected && a.selected.length > 0 ? a.selected.join("、") : NO_INPUT_PLACEHOLDER;
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
	}
}

function buildAnswerSegment(a: AskUserAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a)}"`];
	if (a.preview && a.preview.length > 0) parts.push(`已选预览: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`用户备注: ${a.notes}`);
	return parts.join("；");
}

function toolResult(text: string, details: AskUserDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function declineResult(answers: AskUserAnswer[] = [], error?: AskUserDetails["error"]) {
	return toolResult(DECLINE_MESSAGE, { answers, cancelled: true, ...(error ? { error } : {}) });
}

// ---------------------------------------------------------------------------
// 扩展本体
// ---------------------------------------------------------------------------

/** 桥端挂起的一次提问；question.response / abort / 会话卸载都会落到 resolve。 */
export interface PendingQuestion {
	sessionId: string;
	toolCallId: string;
	resolve: (outcome: QuestionOutcome) => void;
}

export type QuestionOutcome = { cancelled: boolean; answers: QuestionAnswerPayload[] };

export interface AskUserQuestionDeps {
	broadcast: (message: DesktopServerMessage) => void;
	/** 没有任何桌面 UI 连着时提问必然无人应答，工具要在出发前就报错。 */
	hasConnectedClients: () => boolean;
	getSessionId: () => string;
	pendingQuestions: Map<string, PendingQuestion>;
}

/** 取消某会话的全部挂起提问（会话删除/卸载时调用，别把工具永远挂死）。 */
export function cancelPendingQuestionsForSession(
	pending: Map<string, PendingQuestion>,
	sessionId: string,
): void {
	for (const [requestId, entry] of pending) {
		if (entry.sessionId !== sessionId) continue;
		pending.delete(requestId);
		entry.resolve({ cancelled: true, answers: [] });
	}
}

const NO_UI_MESSAGE =
	"错误：当前没有已连接的桌面界面，用户看不到这次提问。请不要把它当作拒绝：改用普通文本向用户提出你的问题，等用户在后续消息里回答。";

/**
 * 创建「向用户提问」内联扩展。只在桌面桥挂载会话时注入，因此 print/-p 等
 * 无 UI 模式天然不含此工具。
 */
export function createAskUserQuestionExtension(deps: AskUserQuestionDeps): InlineExtension {
	return {
		name: "owl-ask-user",
		factory: (pi) => {
			pi.registerTool({
				name: "ask_user_question",
				label: "向用户提问",
				description:
					"只在你确实被一个属于用户的决定卡住、无法从需求/代码/合理默认值中解决时使用：向用户打包提出 1-4 个带选项的问题。" +
					"每个问题带 2-4 个写清含义的选项，用户在桌面界面里作答，答案以结构化数据返回。能在合理默认值内解决的普通选择不要用它。",
				promptSnippet: "ask_user_question: 打包向用户提出 1-4 个带选项的问题，等用户作答后继续",
				promptGuidelines: [
					"只在被真正属于用户的决定卡住时提问；能自行解决的不要问。",
					"用户始终可以选「其他」自由输入，无需为开放性答案单独设选项。",
					"如果你推荐某个选项，把它放第一位并在标签末尾加「（推荐）」。",
					"preview 只用于用户需要直观对比的具体产物（原型图、代码、示意图、配置）；偏好类问题不要附预览。",
				],
				parameters: AskUserQuestionParamsSchema,
				execute: async (toolCallId, rawParams, signal) => {
					const params = normalizeQuestionParams(rawParams as AskUserQuestionParams);
					const validation = validateQuestionnaire(params.questions);
					if (!validation.ok) {
						return toolResult(validation.message, {
							answers: [],
							cancelled: true,
							error: "invalid_params",
						});
					}
					if (!deps.hasConnectedClients()) {
						return toolResult(NO_UI_MESSAGE, { answers: [], cancelled: true, error: "no_ui" });
					}

					const requestId = randomUUID();
					const sessionId = deps.getSessionId();
					const questions: QuestionPayload[] = params.questions.map((q) => ({
						question: q.question,
						header: q.header,
						multiSelect: q.multiSelect === true,
						options: q.options.map((o) => ({
							label: o.label,
							description: o.description,
							...(o.preview !== undefined ? { preview: o.preview } : {}),
						})),
					}));

					let outcome: QuestionOutcome;
					try {
						outcome = await new Promise<QuestionOutcome>((resolve) => {
							deps.pendingQuestions.set(requestId, { sessionId, toolCallId, resolve });
							deps.broadcast({ type: "question_request", requestId, sessionId, toolCallId, questions });
							if (signal) {
								if (signal.aborted) resolve({ cancelled: true, answers: [] });
								else signal.addEventListener("abort", () => resolve({ cancelled: true, answers: [] }), { once: true });
							}
						});
					} finally {
						deps.pendingQuestions.delete(requestId);
					}

					if (outcome.cancelled) return declineResult();

					const answers: AskUserAnswer[] = [];
					const segments: string[] = [];
					for (let i = 0; i < params.questions.length; i++) {
						const q = params.questions[i];
						const raw = outcome.answers.find((a) => a.index === i);
						if (!raw) continue;
						const note = raw.note?.trim();
						const custom = raw.customText?.trim();
						// 回传的 label 按原选项对账，界面脏数据/错位 label 直接丢弃
						const labels = (raw.selectedLabels ?? []).filter((l) => q.options.some((o) => o.label === l));

						let entry: AskUserAnswer | undefined;
						if (!q.multiSelect) {
							// 单选：填了「其他」就是 custom 答案，否则是命中的选项（回显其预览）
							if (custom) {
								entry = {
									questionIndex: i,
									question: q.question,
									kind: "custom",
									answer: custom,
									...(note ? { notes: note } : {}),
								};
							} else if (labels.length > 0) {
								const matched = q.options.find((o) => o.label === labels[0]);
								entry = {
									questionIndex: i,
									question: q.question,
									kind: "option",
									answer: labels[0],
									...(matched?.preview ? { preview: matched.preview } : {}),
									...(note ? { notes: note } : {}),
								};
							}
						} else {
							// 多选：「其他」自由文本当作多选集里的额外一项，和勾选项合并回给模型
							const all = [...labels, ...(custom ? [custom] : [])];
							if (all.length > 0) {
								entry = {
									questionIndex: i,
									question: q.question,
									kind: "multi",
									answer: null,
									selected: all,
									...(note ? { notes: note } : {}),
								};
							}
						}
						if (!entry) continue;
						answers.push(entry);
						segments.push(buildAnswerSegment(entry));
					}

					if (segments.length === 0) return declineResult(answers);
					return toolResult(`${ENVELOPE_PREFIX}\n${segments.join("\n")}\n${ENVELOPE_SUFFIX}`, {
						answers,
						cancelled: false,
					});
				},
			});
		},
	};
}
