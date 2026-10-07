import { useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import { useT, type TextKey } from "../../i18n/index.ts";
import { type ScheduleDeliveryInfo, parseScheduleDelivery } from "./schedule-delivery.ts";

export { parseScheduleDelivery };
/**
 * 会话内任务卡：到点投递在对话流里的样子（替代普通用户气泡）。
 * 有 taskId 且给了 client 时可暂停任务；onOpenAutomation 跳任务页。
 */
export function ScheduleDeliveryCard({ info, client, onOpenAutomation }: {
	info: ScheduleDeliveryInfo;
	client?: BridgeClient;
	onOpenAutomation?: () => void;
}): React.JSX.Element {
	const t = useT();
	const [paused, setPaused] = useState(false);
	const [busy, setBusy] = useState(false);
	const pause = async (): Promise<void> => {
		if (!client || info.taskId === null || busy) return;
		setBusy(true);
		try {
			await client.request({ type: "schedule.update", taskId: info.taskId, enabled: false });
			setPaused(true);
		} catch {
			// 失败保持原状（桥断开时按钮点了没反应比报错卡更不打扰）
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="owl-schedule-card">
			<div className="owl-schedule-card-head">
				<span className="owl-schedule-card-tag">{t("automation.cardTag" as TextKey)}</span>
				<b>{info.name}</b>
				<span className="owl-schedule-card-repeat">{info.repeat}</span>
				<span className="owl-schedule-card-time">{info.time}</span>
			</div>
			<p className="owl-schedule-card-prompt">{info.prompt}</p>
			<div className="owl-schedule-card-foot">
				{paused ? (
					<span className="owl-schedule-card-paused">{t("automation.cardPaused" as TextKey)}</span>
				) : info.taskId !== null && client !== undefined ? (
					<button type="button" disabled={busy} onClick={() => void pause()}>{t("automation.cardPause" as TextKey)}</button>
				) : null}
				{onOpenAutomation && (
					<button type="button" onClick={onOpenAutomation}>{t("automation.cardOpen" as TextKey)}</button>
				)}
			</div>
		</div>
	);
}
