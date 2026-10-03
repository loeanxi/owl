import { useId, useState } from "react";
import type { QuestionAnswerPayload, QuestionRequest } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";
import { renderMarkdown } from "./ChatStream.tsx";
import "./question-card.css";

/**
 * agent 提问答卷（ask_user_question 工具的桌面端交互面）。
 * 问题不整卷铺开，而是一题一张小卡、贴在输入框上方逐题弹出：答完当前题
 * 「下一题」，最后一张「提交回答」；可「上一题」回改。完整保真度：带描述
 * 的选项、单选/多选、「其他」自由文本、每题备注、选项 markdown 预览。
 * QuestionDock 按 requestId 挂载，切换会话保留草稿，新提问使用空白状态。
 */

/** 一题的本地作答状态。picked 在单选下最多 1 项；custom 非空即代表选了「其他」。 */
interface QuestionUiState {
	picked: Set<string>;
	custom: string;
	customOpen: boolean;
	note: string;
	noteOpen: boolean;
	previewOpen: Set<string>;
}

function initialState(): QuestionUiState {
	return { picked: new Set<string>(), custom: "", customOpen: false, note: "", noteOpen: false, previewOpen: new Set<string>() };
}

export function QuestionDialog({
	request,
	onAnswer,
}: {
	request: QuestionRequest;
	onAnswer: (answers: QuestionAnswerPayload[], cancelled: boolean) => void;
}): React.JSX.Element | null {
	const t = useT();
	const questionId = useId();
	const total = request.questions.length;
	const [states, setStates] = useState<QuestionUiState[]>(() => request.questions.map(initialState));
	const [current, setCurrent] = useState(0);
	const [missing, setMissing] = useState<Set<number>>(new Set());
	const [collapsed, setCollapsed] = useState(false);

	const isAnswered = (s: QuestionUiState) => s.picked.size > 0 || s.custom.trim() !== "";

	function patch(index: number, changes: Partial<QuestionUiState>): void {
		setStates((prev) => prev.map((s, i) => (i === index ? { ...s, ...changes } : s)));
		setMissing((prev) => {
			if (!prev.has(index)) return prev;
			const next = new Set(prev);
			next.delete(index);
			return next;
		});
	}

	function pick(index: number, label: string, multiSelect: boolean): void {
		setStates((prev) =>
			prev.map((s, i) => {
				if (i !== index) return s;
				const next = new Set(multiSelect ? s.picked : []);
				if (multiSelect && next.has(label)) next.delete(label);
				else next.add(label);
				return { ...s, picked: next, previewOpen: new Set<string>() };
			}),
		);
		patch(index, {});
	}

	function setCustom(index: number, text: string, multiSelect: boolean): void {
		patch(index, { custom: text, ...(multiSelect ? {} : { picked: new Set<string>(), previewOpen: new Set<string>() }) });
	}

	function togglePreview(index: number, label: string): void {
		setStates((prev) =>
			prev.map((s, i) => {
				if (i !== index) return s;
				const next = new Set(s.previewOpen);
				if (next.has(label)) next.delete(label);
				else next.add(label);
				return { ...s, previewOpen: next };
			}),
		);
	}

	function submit(): void {
		const unanswered = new Set<number>();
		states.forEach((s, i) => {
			if (!isAnswered(s)) unanswered.add(i);
		});
		if (unanswered.size > 0) {
			setMissing(unanswered);
			// 跳到第一道没答的题，让用户接着答
			setCurrent(unanswered.values().next().value ?? current);
			return;
		}
		const answers: QuestionAnswerPayload[] = states.map((s, i) => {
			const payload: QuestionAnswerPayload = { index: i };
			if (s.picked.size > 0) payload.selectedLabels = [...s.picked];
			if (s.custom.trim() !== "") payload.customText = s.custom.trim();
			if (s.note.trim() !== "") payload.note = s.note.trim();
			return payload;
		});
		onAnswer(answers, false);
	}

	/** 当前题已答 → 前进；没答 → 标红并停在原地。最后一张即提交。 */
	function advance(): void {
		const state = states[current];
		if (!state) return;
		if (!isAnswered(state)) {
			setMissing((prev) => new Set(prev).add(current));
			return;
		}
		if (current < total - 1) {
			setCurrent(current + 1);
			setMissing(new Set());
		} else {
			submit();
		}
	}

	const qi = current;
	const question = request.questions[qi];
	const state = states[qi];
	if (!question || !state) return null;
	const unanswered = missing.has(qi);
	const answeredCount = states.filter(isAnswered).length;
	const customVisible = state.customOpen || state.custom.trim() !== "";
	const noteVisible = state.noteOpen || state.note.trim() !== "";

	return (
		<section
			className="owl-question-card"
			data-collapsed={collapsed}
			aria-labelledby={questionId}
			onKeyDown={(event) => {
				// 快捷键只作用于提问卡，工作台和输入框保留各自的键盘行为。
				if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat) return;
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onAnswer([], true);
				} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					event.stopPropagation();
					if (!collapsed) advance();
				}
			}}
		>
			{/* 单题只显示计数；多题用短进度点导航，避免整条强调色压过问题。 */}
			<div className="owl-question-card__progress">
				<span className="owl-question-card__step">
					{t("question.progress", { i: qi + 1, n: total })}
				</span>
				{collapsed && <span className="owl-question-card__summary" title={question.question}>{question.question}</span>}
				<div hidden={collapsed || total < 2} className="owl-question-card__steps">
					{request.questions.map((q, i) => (
						<button
							key={i}
							type="button"
							title={q.header || q.question}
							aria-label={t("question.progress", { i: i + 1, n: total })}
							aria-current={i === qi ? "step" : undefined}
							className="owl-question-card__step-dot"
							data-answered={isAnswered(states[i])}
							onClick={() => {
								setCurrent(i);
								setMissing(new Set());
							}}
						/>
					))}
				</div>
				<span hidden={collapsed} className="owl-question-card__count" data-single={total < 2}>
					{t("question.answeredCount", { n: answeredCount, total })}
				</span>
				<button
					type="button"
					className="owl-question-card__collapse"
					aria-label={t(collapsed ? "common.expand" : "common.collapse")}
					aria-expanded={!collapsed}
					aria-controls={`${questionId}-body`}
					onClick={() => setCollapsed((value) => !value)}
				>
					{t(collapsed ? "common.expand" : "common.collapse")}
				</button>
			</div>
			<div id={`${questionId}-body`} hidden={collapsed} className="owl-question-card__body">
				<div className="owl-question-card__heading">
					{(question.header || question.multiSelect) && (
						<div className="owl-question-card__caption">
							{question.header && <span>{question.header}</span>}
							{question.multiSelect && <span>{t("question.multiSelectHint")}</span>}
						</div>
					)}
					<p id={questionId} className="owl-question-card__question">{question.question}</p>
				</div>
				{unanswered && <p className="mt-1 text-xs text-red-400">{t("question.missingWarning")}</p>}
				<div className="owl-question-card__options" role={question.multiSelect ? "group" : "radiogroup"} aria-labelledby={questionId}>
					{question.options.map((option) => {
						const picked = state.picked.has(option.label);
						const previewVisible =
							state.previewOpen.has(option.label) || (!question.multiSelect && picked && option.preview !== undefined);
						return (
							<div key={option.label} className="owl-question-card__option">
								<div
									role={question.multiSelect ? "checkbox" : "radio"}
									aria-label={option.label}
									aria-checked={picked}
									tabIndex={0}
									className="owl-question-card__choice"
									data-picked={picked}
									onClick={(event) => {
										event.currentTarget.focus({ preventScroll: true });
										pick(qi, option.label, question.multiSelect);
									}}
									onKeyDown={(event) => {
										if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.repeat) return;
										if (event.key !== " " && event.key !== "Enter") return;
										event.preventDefault();
										event.stopPropagation();
										pick(qi, option.label, question.multiSelect);
									}}
								>
									<span
										className={`owl-question-card__indicator mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[10px] text-white ${
											question.multiSelect ? "rounded-sm" : "rounded-full"
										} ${picked ? "border-owl-accent bg-owl-accent" : "border-owl-border"}`}
									>
										{picked ? (question.multiSelect ? "✓" : "●") : ""}
									</span>
									<span className="min-w-0 flex-1">
										<span className="owl-question-card__option-label block">{option.label}</span>
										{option.description && (
											<span className="owl-question-card__description block text-owl-muted">{option.description}</span>
										)}
									</span>
									{option.preview && (
										<button
											type="button"
										className="owl-question-card__preview-toggle shrink-0 rounded border border-owl-border px-1.5 py-0.5 text-[11px] text-owl-muted hover:bg-owl-hover hover:text-owl-text"
											onClick={(event) => {
												event.stopPropagation();
												togglePreview(qi, option.label);
											}}
										>
											{t("question.preview")}
										</button>
									)}
								</div>
								{option.preview && previewVisible && (
									<div
										className="owl-question-card__preview mt-1 max-h-44 overflow-y-auto rounded-lg border border-owl-border bg-owl-sidebar p-3 text-sm [&_code]:rounded [&_code]:bg-owl-panel [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-owl-border [&_pre]:bg-owl-panel [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs"
										// markdown-it html:false，预览内容按数据转义
										dangerouslySetInnerHTML={{ __html: renderMarkdown(option.preview) }}
									/>
								)}
							</div>
						);
					})}
				</div>
				<div hidden={!customVisible && !noteVisible} className="owl-question-card__extras">
					{/* 「其他」自由文本行：单选下输入即顶掉已选选项；多选下是额外一项 */}
					<div
						hidden={!customVisible}
						id={`${questionId}-custom`}
						className={`owl-question-card__custom flex cursor-pointer items-center gap-2 rounded-lg border transition-colors ${
							state.custom.trim() !== "" ? "border-owl-accent bg-owl-accent/10" : "border-owl-border hover:bg-owl-hover"
						}`}
						onClick={(event) => {
							const input = event.currentTarget.querySelector("input");
							input?.focus();
						}}
					>
						<span className="shrink-0 text-sm text-owl-muted">{t("question.other")}</span>
						<input
							value={state.custom}
							onChange={(event) => setCustom(qi, event.target.value, question.multiSelect)}
							placeholder={t("question.customPlaceholder")}
							className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-owl-muted/60"
						/>
					</div>
					{/* 每题备注 */}
					{noteVisible && (
						<textarea
							id={`${questionId}-note`}
							value={state.note}
							onChange={(event) => patch(qi, { note: event.target.value })}
							placeholder={t("question.notePlaceholder")}
							rows={2}
							className="w-full resize-y rounded-lg border border-owl-border bg-owl-sidebar px-2.5 py-1.5 text-xs outline-none placeholder:text-owl-muted/60 focus:border-owl-accent"
						/>
					)}
				</div>
			</div>
			<div hidden={collapsed} className="owl-question-card__footer">
				<div className="owl-question-card__secondary-actions">
					<button
						type="button"
						className="owl-question-card__extra-toggle"
						aria-expanded={customVisible}
						aria-controls={`${questionId}-custom`}
						onClick={() => patch(qi, { customOpen: !customVisible })}
					>
						{t("question.other")}
					</button>
					<button
						type="button"
						className="owl-question-card__extra-toggle"
						aria-expanded={noteVisible}
						aria-controls={`${questionId}-note`}
						onClick={() => patch(qi, { noteOpen: !noteVisible })}
					>
						{t("question.addNote")}
					</button>
				</div>
				<div className="owl-question-card__actions">
					<button
						type="button"
						className="owl-question-card__cancel"
						onClick={() => onAnswer([], true)}
					>
						{t("common.cancel")}
					</button>
					{qi > 0 && (
						<button
							type="button"
							className="rounded-lg border border-owl-border px-3 py-1.5 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
							onClick={() => {
								setCurrent(qi - 1);
								setMissing(new Set());
							}}
						>
							{t("question.prev")}
						</button>
					)}
					<button
						type="button"
						className="rounded-lg bg-owl-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-owl-accent-hover"
						onClick={advance}
					>
						{qi < total - 1 ? t("question.next") : t("question.submit")}
					</button>
				</div>
			</div>
		</section>
	);
}
