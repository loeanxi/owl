/**
 * Claude 的提问卡（AskUserQuestion 原生形态）。
 *
 * 规格来源：Claude Desktop 打包渲染层 `c05b96c7f-DklIyA-P.js` 的
 * `Qc`（卡片）/ `Jc`（选项行）/ `qc`（"其他"行）/ `Yc`（响应列表）：
 *
 *   等待态（Qc）：
 *     ┌──────────────────────────────────┐
 *     │ 计费实体要落在哪个包？      1/2   │ ← 问题（primary）+ 进度计数
 *     │ ┌──────────────────────────────┐ │
 *     │ │ gateway/domain          [1]  │ │ ← 选项盒：一个圆角边框容器，
 *     │ │ 独立 billing 包         [2]  │ │    行间 border-t 分隔
 *     │ │ Type something else...  [3]  │ │ ← "其他"自由填写行
 *     │ └──────────────────────────────┘ │
 *     │ Back   Skip                      │ ← 多题时的页脚
 *     └──────────────────────────────────┘
 *   已回答（Yc）：整卡换成响应列表 —— 问题（次级色）+ 答案（主色），
 *   未作答显示 "Not answered"。
 *
 * owl 的差异只有一处：交互仍由 QuestionDialog（浮层）驱动 ——
 * 这里渲染的是 Claude 的卡片形态本身，选项行不接管回答。
 */

import type { ToolCard } from "../hooks/transcript.ts";

type AskOption = { label?: unknown; description?: unknown };
type AskQuestion = { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
/** 解析后的题目：字段都收成确定类型。 */
type ParsedQuestion = { question: string; header: string; options: AskOption[]; multiSelect: boolean };

function argsOf(args: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(args);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** 从工具入参里读出问题列表；读不到就是空数组。 */
export function askQuestionsOf(card: ToolCard): ParsedQuestion[] {
	const raw = argsOf(card.args).questions;
	if (!Array.isArray(raw)) return [];
	const out: ParsedQuestion[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const question = item as AskQuestion;
		const options: AskOption[] = Array.isArray(question.options)
			? question.options.filter((option): option is AskOption => option !== null && typeof option === "object")
			: [];
		out.push({
			question: text(question.question),
			header: text(question.header),
			options,
			multiSelect: question.multiSelect === true,
		});
	}
	return out;
}

/** 提问卡的当前状态。 */
export type AskCardState = "waiting" | "answered" | "cancelled" | "failed";

/** 从工具卡的状态推断提问的进展。 */
export function askCardState(card: ToolCard): AskCardState {
	if (card.status === "error") return "failed";
	if (card.status === "cancelled") return "cancelled";
	if (card.status === "running" || card.status === "pending") return "waiting";
	return "answered";
}

/**
 * 提问卡：等待态渲染原生卡形态，收口后渲染响应列表（Yc）。
 */
export function ClaudeQuestionCard({ card }: { card: ToolCard }): React.JSX.Element | null {
	const questions = askQuestionsOf(card);
	if (questions.length === 0) return null;
	const state = askCardState(card);
	const answers = card.output?.questionAnswers;
	// 收口态：有答案数据（或明确取消）→ Claude 的响应列表；
	// 旧会话没有 details.answers → 退回静态卡片形态。
	if (state !== "waiting" && (answers !== undefined || state === "cancelled")) {
		const byQuestion = new Map((answers ?? []).map((entry) => [entry.question, entry.response]));
		return (
			<div className="owl-claude-question owl-claude-question-responses" data-claude-question-state={state}>
				{questions.map((question, index) => (
					<div className="owl-claude-question-response" key={index}>
						<span className="owl-claude-question-response-q">{question.question}</span>
						<span className="owl-claude-question-response-a">
							{byQuestion.get(question.question) ?? "Not answered"}
						</span>
					</div>
				))}
			</div>
		);
	}
	return (
		<div className="owl-claude-question" data-claude-question-state={state}>
			{questions.map((question, questionIndex) => (
				<div className="owl-claude-question-item" key={questionIndex}>
					<div className="owl-claude-question-head">
						<span className="owl-claude-question-text">
							{question.question !== "" ? question.question : question.header}
						</span>
						{questions.length > 1 && (
							<span className="owl-claude-question-count">
								{questionIndex + 1}/{questions.length}
							</span>
						)}
					</div>
					{question.options.length > 0 && (
						<div className="owl-claude-question-options">
							{question.options.map((option, optionIndex) => (
								<div className="owl-claude-question-option" key={optionIndex}>
									<div className="owl-claude-question-option-body">
										<span className="owl-claude-question-option-label">{text(option.label)}</span>
										{text(option.description) !== "" && (
											<span className="owl-claude-question-option-desc">{text(option.description)}</span>
										)}
									</div>
									<span className="owl-claude-question-option-badge">{optionIndex + 1}</span>
								</div>
							))}
							<div className="owl-claude-question-option owl-claude-question-option-other">
								<div className="owl-claude-question-option-body">
									<span className="owl-claude-question-option-label">Type something else...</span>
								</div>
								<span className="owl-claude-question-option-badge">{question.options.length + 1}</span>
							</div>
						</div>
					)}
				</div>
			))}
		</div>
	);
}
