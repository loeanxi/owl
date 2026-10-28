import { deliveryChecklist } from "../hooks/delivery.ts";
import type { ChatEntry } from "../hooks/transcript.ts";
import { getUiLanguage, useT } from "../i18n/index.ts";
import { MessageCopyButton } from "./MessageActions.tsx";
import "./delivery-summary.css";

const zh = {
	title: "本轮交付与验证",
	noProof: "未关联执行记录",
	proof: "已关联成功执行记录",
	pending: "待验证",
	verified: "已标记通过",
	blocked: "受阻",
	detail: "查看验证记录",
	result: "执行结果",
	missing: "关联的执行记录不可用",
	source: "验收结论由 Agent 提交，可展开核对具体证据。",
	allPassed: "全部通过",
	blockedSome: "{n} 项受阻",
	passedSome: "{n}/{total} 已通过",
	copyOutput: "复制执行结果",
};
const en: Record<keyof typeof zh, string> = {
	title: "This turn's delivery and checks",
	noProof: "No linked execution record",
	proof: "Linked successful execution",
	pending: "Pending verification",
	verified: "Marked as passed",
	blocked: "Blocked",
	detail: "View verification records",
	result: "Execution result",
	missing: "The linked execution record is unavailable",
	source: "Acceptance conclusions are submitted by the agent. Expand an item to inspect its evidence.",
	allPassed: "All passed",
	blockedSome: "{n} blocked",
	passedSome: "{n}/{total} passed",
	copyOutput: "Copy execution result",
};

export function DeliverySummary({ entries }: { entries: readonly ChatEntry[] }): React.JSX.Element | null {
	useT();
	const copy = getUiLanguage() === "en" ? en : zh;
	const checklist = deliveryChecklist(entries);
	if (!checklist) return null;
	// 收起态的结果信号：全过绿 / 有受阻红 / 其余灰，展开前的第一眼就能分辨这轮验收成色。
	const verifiedCount = checklist.criteria.filter((item) => item.status === "verified").length;
	const blockedCount = checklist.criteria.filter((item) => item.status === "blocked").length;
	const outcome =
		blockedCount > 0
			? { tone: "blocked" as const, text: copy.blockedSome.replace("{n}", String(blockedCount)) }
			: verifiedCount === checklist.criteria.length
				? { tone: "verified" as const, text: copy.allPassed }
				: {
						tone: "partial" as const,
						text: copy.passedSome
							.replace("{n}", String(verifiedCount))
							.replace("{total}", String(checklist.criteria.length)),
					};
	return (
		<section className="owl-delivery-summary" aria-label={copy.title}>
			<strong>{copy.title}</strong>
			<details>
				<summary>
					<span className="owl-delivery-outcome" data-tone={outcome.tone}>
						{outcome.text}
					</span>
					{copy.detail} · {verifiedCount}/{checklist.criteria.length}
				</summary>
				<p>{checklist.goal}</p>
				<p className="owl-delivery-muted">{copy.source}</p>
				<ul>
					{checklist.criteria.map((item, index) => (
						<li key={index} data-status={item.status}>
							<div>
								<span className="owl-delivery-status">{copy[item.status]}</span>
								<strong>{item.criterion}</strong>
							</div>
							{item.evidence && <p>{item.evidence}</p>}
							<p className="owl-delivery-muted">
								{item.tool ? copy.proof : item.toolCallId ? copy.missing : copy.noProof}
							</p>
							{item.tool && (
								<details>
									<summary>
										{item.tool.name} · {copy.result}
									</summary>
									<pre>{item.tool.detail ?? item.tool.args}</pre>
									<pre>{item.tool.output!.text}</pre>
									<div className="owl-delivery-evidence-actions">
										<MessageCopyButton
											text={item.tool.output!.text}
											label={copy.copyOutput}
											identity={`delivery:${index}:output`}
											showLabel
										/>
									</div>
								</details>
							)}
						</li>
					))}
				</ul>
			</details>
		</section>
	);
}
