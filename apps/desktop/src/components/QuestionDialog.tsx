import { useEffect, useState } from "react";
import type { QuestionAnswerPayload, QuestionRequest } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";
import { renderMarkdown } from "./ChatStream.tsx";

/**
 * agent 提问答卷（ask_user_question 工具的桌面端交互面）。
 * 问题不整卷铺开，而是一题一张小卡、贴在输入框上方逐题弹出：答完当前题
 * 「下一题」，最后一张「提交回答」；可「上一题」回改。完整保真度：带描述
 * 的选项、单选/多选、「其他」自由文本、每题备注、选项 markdown 预览。
 * App 用 key={request.requestId} 挂载，每次新提问都拿到全新的空白状态。
 */

/** 一题的本地作答状态。picked 在单选下最多 1 项；custom 非空即代表选了「其他」。 */
interface QuestionUiState {
	picked: Set<string>;
	custom: string;
	note: string;
	noteOpen: boolean;
	previewOpen: Set<string>;
}

function initialState(): QuestionUiState {
	return { picked: new Set<string>(), custom: "", note: "", noteOpen: false, previewOpen: new Set<string>() };
}

export function QuestionDialog({
	request,
	onAnswer,
}: {
	request: QuestionRequest;
	onAnswer: (answers: QuestionAnswerPayload[], cancelled: boolean) => void;
}): React.JSX.Element {
	const t = useT();
	const total = request.questions.length;
	const [states, setStates] = useState<QuestionUiState[]>(() => request.questions.map(initialState));
	const [current, setCurrent] = useState(0);
	const [missing, setMissing] = useState<Set<number>>(new Set());

	const isAnswered = (s: QuestionUiState) => s.picked.size > 0 || s.custom.trim() !== "";

	// Esc 放弃整份问卷；Ctrl+Enter 等价于 下一题/提交
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onAnswer([], true);
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				advance();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

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
		if (!isAnswered(states[current])) {
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
	const unanswered = missing.has(qi);
	const answeredCount = states.filter(isAnswered).length;

	return (
		<div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/50 pb-28">
			<div className="flex max-h-[62vh] w-[560px] max-w-full flex-col rounded-xl border border-owl-border bg-owl-panel shadow-2xl shadow-black/40">
				{/* 进度：第 x / N 题 + 圆点（绿=已答，描边=当前） */}
				<div className="flex items-center gap-2 border-b border-owl-border px-4 py-2.5">
					<span className="text-sm font-semibold text-owl-accent">
						{t("question.progress", { i: qi + 1, n: total })}
					</span>
					<div className="flex flex-1 items-center gap-1.5">
						{request.questions.map((q, i) => (
							<button
								key={i}
								type="button"
								title={q.header || q.question}
								className={`h-1.5 flex-1 rounded-full transition-colors ${
									i === qi
										? "bg-owl-accent"
										: isAnswered(states[i])
											? "bg-owl-accent/40 hover:bg-owl-accent/60"
											: "bg-owl-border hover:bg-owl-muted/40"
								}`}
								onClick={() => {
									setCurrent(i);
									setMissing(new Set());
								}}
							/>
						))}
					</div>
					<span className="text-[11px] text-owl-muted">{t("question.answeredCount", { n: answeredCount, total })}</span>
				</div>
				<div className="flex-1 overflow-y-auto px-4 py-3">
					<div className="flex items-center gap-2">
						<span className="rounded bg-owl-sidebar px-1.5 py-0.5 font-mono text-[11px] text-owl-muted">
							{question.header}
						</span>
						<p className="text-sm font-medium">{question.question}</p>
						{question.multiSelect && <span className="text-[11px] text-owl-muted">{t("question.multiSelectHint")}</span>}
					</div>
					{unanswered && <p className="mt-1 text-xs text-red-400">{t("question.missingWarning")}</p>}
					<div className="mt-2 space-y-1.5">
						{question.options.map((option) => {
							const picked = state.picked.has(option.label);
							const previewVisible =
								state.previewOpen.has(option.label) || (!question.multiSelect && picked && option.preview !== undefined);
							return (
								<div key={option.label}>
									<div
										className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
											picked ? "border-owl-accent bg-owl-accent/10" : "border-owl-border hover:bg-owl-hover"
										}`}
										onClick={() => pick(qi, option.label, question.multiSelect)}
									>
										<span
											className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[10px] text-white ${
												question.multiSelect ? "rounded-sm" : "rounded-full"
											} ${picked ? "border-owl-accent bg-owl-accent" : "border-owl-border"}`}
										>
											{picked ? (question.multiSelect ? "✓" : "●") : ""}
										</span>
										<span className="min-w-0 flex-1">
											<span className="block text-sm">{option.label}</span>
											{option.description && (
												<span className="mt-0.5 block text-xs text-owl-muted">{option.description}</span>
											)}
										</span>
										{option.preview && (
											<button
												type="button"
												className="shrink-0 rounded border border-owl-border px-1.5 py-0.5 text-[11px] text-owl-muted hover:bg-owl-hover hover:text-owl-text"
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
											className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-owl-border bg-owl-sidebar p-3 text-sm [&_code]:rounded [&_code]:bg-owl-panel [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-owl-border [&_pre]:bg-owl-panel [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-xs"
											// markdown-it html:false，预览内容按数据转义
											dangerouslySetInnerHTML={{ __html: renderMarkdown(option.preview) }}
										/>
									)}
								</div>
							);
						})}
						{/* 「其他」自由文本行：单选下输入即顶掉已选选项；多选下是额外一项 */}
						<div
							className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
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
						{state.noteOpen ? (
							<textarea
								value={state.note}
								onChange={(event) => patch(qi, { note: event.target.value })}
								placeholder={t("question.notePlaceholder")}
								rows={2}
								className="w-full resize-y rounded-lg border border-owl-border bg-owl-sidebar px-2.5 py-1.5 text-xs outline-none placeholder:text-owl-muted/60 focus:border-owl-accent"
							/>
						) : (
							<button
								type="button"
								className="text-[11px] text-owl-muted hover:text-owl-text"
								onClick={() => patch(qi, { noteOpen: true })}
							>
								{t("question.addNote")}
							</button>
						)}
					</div>
				</div>
				<div className="flex items-center justify-between border-t border-owl-border px-4 py-3">
					<button
						type="button"
						className="rounded-lg border border-owl-border px-3 py-1.5 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
							onClick={() => onAnswer([], true)}
						>
							{t("common.cancel")}
						</button>
					<div className="flex items-center gap-2">
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
			</div>
		</div>
	);
}
