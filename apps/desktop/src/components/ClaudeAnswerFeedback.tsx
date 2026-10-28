/**
 * 回答的赞/跌（Claude 的 feedback 动作）。
 *
 * 两个拇指按钮，互斥、带 pressed 态；点踩展开「Tell us more (optional)」
 * 的补充框。评分记在本地（按会话存），理由走 owl 既有的反馈通道交给模型。
 *
 * 规格来源见 `claude-answer-feedback.ts` 的头注释。
 */

import { useEffect, useRef, useState } from "react";
import { getUiLanguage, useT } from "../i18n/index.ts";
import {
	type AnswerRating,
	formatAnswerFeedback,
	loadFeedback,
	saveFeedback,
	toggleRating,
} from "./claude-answer-feedback.ts";
import "./claude-answer-feedback.css";

/** 拇指向上（Material 的 ThumbsUp 轮廓）。 */
function ThumbUp({ className }: { className?: string }): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path d="M5 14H3.5A1.5 1.5 0 0 1 2 12.5v-4A1.5 1.5 0 0 1 3.5 7H5" />
			<path d="M5 14v-6.2c0-.5.15-.98.43-1.36l1.3-1.75c.3-.4.85-.5 1.27-.22.42.28.59.81.45 1.28L8 8h3.6a1.9 1.9 0 0 1 1.85 2.36l-.7 3.1A1.9 1.9 0 0 1 10.9 14H5Z" />
		</svg>
	);
}

/** 拇指向下（ThumbsDown 轮廓）。 */
function ThumbDown({ className }: { className?: string }): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path d="M11 2h1.5A1.5 1.5 0 0 1 14 3.5v4a1.5 1.5 0 0 1-1.5 1.5H11" />
			<path d="M11 2v6.2c0 .5-.15.98-.43 1.36l-1.3 1.75c-.3.4-.85.5-1.27.22-.42-.28-.59-.81-.45-1.28L8 8H4.4a1.9 1.9 0 0 0-1.85 2.36l.7 3.1A1.9 1.9 0 0 0 5.1 14H11" />
		</svg>
	);
}

export interface ClaudeAnswerFeedbackProps {
	/** 会话 id：评分按会话存。 */
	sessionId: string | undefined;
	/** 回答的稳定 id。 */
	entryId: string | undefined;
	/** 把理由交给模型（owl 的反馈通道）。返回 false 表示没送出去。 */
	onSubmit?: (text: string) => Promise<boolean> | void;
}

type FormState = "closed" | "open" | "sending" | "sent" | "failed";

export function ClaudeAnswerFeedback({
	sessionId,
	entryId,
	onSubmit,
}: ClaudeAnswerFeedbackProps): React.JSX.Element | null {
	const t = useT();
	const [rating, setRating] = useState<AnswerRating | undefined>(undefined);
	const [form, setForm] = useState<FormState>("closed");
	const [reason, setReason] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// 评分是按「会话 + 回答」存的：换会话或换回答时重新读。
	useEffect(() => {
		if (sessionId === undefined || entryId === undefined) {
			setRating(undefined);
			return;
		}
		setRating(loadFeedback(sessionId)[entryId]?.rating);
		setForm("closed");
		setReason("");
	}, [sessionId, entryId]);

	if (sessionId === undefined || entryId === undefined) return null;

	const persist = (next: AnswerRating | undefined, nextReason?: string): void => {
		const records = loadFeedback(sessionId);
		if (next === undefined) delete records[entryId];
		else
			records[entryId] = {
				rating: next,
				...(nextReason !== undefined && nextReason !== "" ? { reason: nextReason } : {}),
			};
		saveFeedback(sessionId, records);
		setRating(next);
	};

	const rate = (next: AnswerRating): void => {
		const toggled = toggleRating(rating, next);
		if (toggled === undefined) {
			// 再点一次同一个 = 取消。
			persist(undefined);
			setForm("closed");
			setReason("");
			return;
		}
		persist(toggled, toggled === "down" ? undefined : "");
		// 踩：展开补充框（Claude 的 "Tell us more (optional)"）。
		if (toggled === "down") {
			setForm("open");
			window.setTimeout(() => inputRef.current?.focus(), 0);
			return;
		}
		setForm("closed");
		setReason("");
	};

	const submit = async (): Promise<void> => {
		if (form === "sending") return;
		const text = formatAnswerFeedback(rating ?? "down", reason, getUiLanguage() === "en");
		persist(rating ?? "down", reason.trim());
		setForm("sending");
		if (text === "" || onSubmit === undefined) {
			// 没写理由（或没有通道）：只记录，不打扰对话。
			setForm("sent");
			return;
		}
		try {
			const accepted = await onSubmit(text);
			setForm(accepted === false ? "failed" : "sent");
		} catch {
			setForm("failed");
		}
	};

	const cancel = (): void => {
		setForm("closed");
		setReason("");
	};

	return (
		<div className="owl-feedback" data-message-action-ui="">
			<button
				type="button"
				className={`owl-msg-action owl-feedback-btn ${rating === "up" ? "is-pressed" : ""}`}
				title={t("chat.msgLike")}
				aria-label={t("chat.msgLike")}
				aria-pressed={rating === "up"}
				onClick={() => rate("up")}
			>
				<ThumbUp className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				className={`owl-msg-action owl-feedback-btn ${rating === "down" ? "is-pressed" : ""}`}
				title={t("chat.msgDislike")}
				aria-label={t("chat.msgDislike")}
				aria-pressed={rating === "down"}
				onClick={() => rate("down")}
			>
				<ThumbDown className="h-3.5 w-3.5" />
			</button>
			{form !== "closed" && (
				<div className="owl-feedback-form">
					<label className="owl-feedback-label" htmlFor={`owl-feedback-${entryId}`}>
						{t("chat.feedbackTellMore")}
					</label>
					<textarea
						id={`owl-feedback-${entryId}`}
						ref={inputRef}
						className="owl-feedback-text"
						rows={4}
						value={reason}
						placeholder={t("chat.feedbackPlaceholder")}
						aria-label={t("chat.feedbackTellMore")}
						disabled={form === "sending"}
						onChange={(event) => setReason(event.target.value)}
					/>
					<div className="owl-feedback-actions">
						<button type="button" className="owl-feedback-action" disabled={form === "sending"} onClick={cancel}>
							{t("chat.feedbackCancel")}
						</button>
						<button
							type="button"
							className="owl-feedback-action is-primary"
							disabled={form === "sending"}
							onClick={() => void submit()}
						>
							{form === "sending" ? t("chat.feedbackSending") : t("chat.feedbackSubmit")}
						</button>
					</div>
					{form === "sent" && (
						<p className="owl-feedback-note" role="status">
							{t("chat.feedbackThanks")}
						</p>
					)}
					{form === "failed" && (
						<p className="owl-feedback-note is-error" role="alert">
							{t("chat.feedbackFailed")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
