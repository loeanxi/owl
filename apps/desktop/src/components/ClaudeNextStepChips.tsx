/**
 * Claude 的「下一步建议」芯片。
 *
 * Claude Desktop 的 `offer_next_step_v0` 渲染成回答下方的一排可点芯片
 * （bundle 里的 `researchSuggestionChip` / `webSearchSuggestionChip` 是同一族）。
 * 点一下建议直接发出去（Claude 的 `sendTransparentMessage`，不留用户轮次）；
 * owl 这里填进输入框（`onPromptExample`）—— 少一次不可撤销的动作，
 * 用户还能改。
 */

import type { NextStep } from "../hooks/transcript.ts";
import { useT } from "../i18n/index.ts";
import "./claude-next-steps.css";

export interface ClaudeNextStepChipsProps {
	steps: readonly NextStep[];
	/** 点芯片：把这句话交给宿主（桌面端填进输入框）。 */
	onPick: (prompt: string) => void;
}

export function ClaudeNextStepChips({ steps, onPick }: ClaudeNextStepChipsProps): React.JSX.Element | null {
	const t = useT();
	if (steps.length === 0) return null;
	return (
		<div className="owl-claude-nextsteps" role="group" aria-label={t("claude.nextSteps.title")}>
			{steps.map((step) => (
				<button
					key={step.label}
					type="button"
					className="owl-claude-nextstep"
					title={step.prompt}
					onClick={() => onPick(step.prompt)}
				>
					{step.label}
				</button>
			))}
		</div>
	);
}
