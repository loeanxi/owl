import { deliveryChecklist } from "../hooks/delivery.ts";
import type { ChatEntry } from "../hooks/transcript.ts";
import { getUiLanguage, useT } from "../i18n/index.ts";
import "./delivery-summary.css";

const zh = { title: "本轮交付与验证", noProof: "未关联执行记录", proof: "已关联成功执行记录", pending: "待验证", verified: "已标记通过", blocked: "受阻", detail: "查看验证记录", result: "执行结果", missing: "关联的执行记录不可用", source: "验收结论由 Agent 提交，可展开核对具体证据。" };
const en: Record<keyof typeof zh, string> = { title: "This turn's delivery and checks", noProof: "No linked execution record", proof: "Linked successful execution", pending: "Pending verification", verified: "Marked as passed", blocked: "Blocked", detail: "View verification records", result: "Execution result", missing: "The linked execution record is unavailable", source: "Acceptance conclusions are submitted by the agent. Expand an item to inspect its evidence." };

export function DeliverySummary({ entries }: { entries: readonly ChatEntry[] }): React.JSX.Element | null {
	useT();
	const copy = getUiLanguage() === "en" ? en : zh;
	const checklist = deliveryChecklist(entries);
	if (!checklist) return null;
	return <section className="owl-delivery-summary" aria-label={copy.title}>
		<strong>{copy.title}</strong>
		<details>
			<summary>{copy.detail} · {checklist.criteria.filter((item) => item.status === "verified").length}/{checklist.criteria.length}</summary>
			<p>{checklist.goal}</p><p className="owl-delivery-muted">{copy.source}</p>
			<ul>{checklist.criteria.map((item, index) => <li key={index} data-status={item.status}>
				<div><span className="owl-delivery-status">{copy[item.status]}</span><strong>{item.criterion}</strong></div>
				{item.evidence && <p>{item.evidence}</p>}
				<p className="owl-delivery-muted">{item.tool ? copy.proof : item.toolCallId ? copy.missing : copy.noProof}</p>
				{item.tool && <details><summary>{item.tool.name} · {copy.result}</summary><pre>{item.tool.detail ?? item.tool.args}</pre><pre>{item.tool.output!.text}</pre></details>}
			</li>)}</ul>
		</details>
	</section>;
}
