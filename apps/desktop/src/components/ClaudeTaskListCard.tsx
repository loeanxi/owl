/**
 * Claude 的行内任务清单卡。
 *
 * 形态对着 Claude 的计划/任务行：每项一行，左边一个状态标记（已完成 / 进行中 / 待办），
 * 右边是事项本身。进行中的那项高亮 —— 这是「现在在做什么」的唯一视觉锚点。
 */

import { useT } from "../i18n/index.ts";
import type { TaskListCard } from "./claude-task-list.ts";
import "./claude-task-list.css";

export interface ClaudeTaskListCardProps {
	card: TaskListCard;
}

/** 每项的标记：跟 Claude 的步骤行一样用形状区分，不只靠颜色。 */
const MARK: Record<string, string> = {
	completed: "✓",
	in_progress: "◐",
	pending: "○",
};

export function ClaudeTaskListCard({ card }: ClaudeTaskListCardProps): React.JSX.Element {
	const t = useT();
	return (
		<section className="owl-claude-tasklist" aria-label={t("claude.taskList.title")}>
			<ul className="owl-claude-tasklist-items">
				{card.items.map((item, index) => (
					<li key={`${index}:${item.content}`} className="owl-claude-tasklist-item" data-status={item.status}>
						<span className="owl-claude-tasklist-mark" aria-hidden="true">
							{MARK[item.status] ?? MARK.pending}
						</span>
						<span className="owl-claude-tasklist-text">{item.content}</span>
					</li>
				))}
			</ul>
		</section>
	);
}
