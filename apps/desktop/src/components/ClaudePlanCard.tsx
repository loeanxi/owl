/**
 * Claude 的计划卡：计划 → 步骤行 → 批准 / 驳回带反馈。
 *
 * 规格来源：Claude Desktop 打包渲染层
 *   - `ExitPlanMode` 是一个**工具**：模型用它提交计划（不是写一段散文）。
 *   - 计划在回答流里渲染成**步骤行**（`TurnStatus` 的 `planLine` / `stepNodes`）。
 *   - 交互文案：`Claude proposed a plan` / `Approve plan` / `Plan approved` /
 *     `Plan rejected` / `Plan feedback` / `Following a plan`。
 *
 * owl 的对应：计划模式（`approvalMode === "plan"`）本来就要求模型先给一份可执行的
 * 实施计划，而 owl 的**任务清单**（todo 工具）就是一份带状态的任务列表。
 * 所以这里不做新协议：计划模式下的清单就是计划，计划卡 = 步骤行 + 两个决定。
 *
 * - **批准**：切回 confirm 模式，模型按计划执行（Claude 的 "Plan approved"）。
 * - **驳回**：带一句反馈重新规划（Claude 的 "Plan rejected" + "Plan feedback"）。
 */

import { useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { ClaudeTaskListCard } from "./ClaudeTaskListCard.tsx";
import type { TaskListCard } from "./claude-task-list.ts";
import "./claude-plan-card.css";

export interface ClaudePlanCardProps {
	card: TaskListCard;
	/** 批准：切回执行模式。 */
	onApprove: () => void;
	/** 驳回：带上用户的反馈重新规划。 */
	onReject: (feedback: string) => void;
}

export function ClaudePlanCard({ card, onApprove, onReject }: ClaudePlanCardProps): React.JSX.Element {
	const t = useT();
	const [rejecting, setRejecting] = useState(false);
	// 输入框是非受控的：反馈只在点「发送」时读一次，不需要每键一次重渲染。
	const feedbackRef = useRef<HTMLInputElement>(null);
	const send = (): void => {
		const feedback = feedbackRef.current?.value.trim() ?? "";
		if (feedback === "") return;
		onReject(feedback);
	};
	return (
		<section className="owl-claude-plan" aria-label={t("claude.plan.title")}>
			<ClaudeTaskListCard card={card} />
			<div className="owl-claude-plan-actions">
				<button type="button" className="owl-claude-plan-approve" onClick={onApprove}>
					{t("claude.plan.approve")}
				</button>
				<button
					type="button"
					className="owl-claude-plan-reject"
					aria-expanded={rejecting}
					onClick={() => setRejecting(!rejecting)}
				>
					{t("claude.plan.reject")}
				</button>
			</div>
			{rejecting && (
				<div className="owl-claude-plan-feedback">
					<input
						ref={feedbackRef}
						type="text"
						className="owl-claude-plan-feedback-input"
						aria-label={t("claude.plan.feedbackPlaceholder")}
						placeholder={t("claude.plan.feedbackPlaceholder")}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								send();
							}
						}}
					/>
					<button type="button" className="owl-claude-plan-send" onClick={send}>
						{t("claude.plan.send")}
					</button>
				</div>
			)}
		</section>
	);
}
