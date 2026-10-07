/**
 * 输入框上方的「下次运行」常驻条 —— 当前会话有定时任务时的跟随标记：
 * 「⏱ 邮箱晨报 · 每天 09:00 · 下次 09:00（2 小时后）」，点击跳自动化任务页。
 * 与 TodoPin/RetryPin 同一挂点（App 的 composer 上方），轻量轮询 + 推送保活。
 */
import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ScheduleListResult } from "../../bridge/protocol.ts";
import { useT, type TextKey } from "../../i18n/index.ts";
import { formatClock, untilLabel } from "./schedule-delivery.ts";

const EMPTY: ScheduleListResult = { tasks: [], runs: {} };

export function SchedulePin({ client, sessionId, active = true, onOpenAutomation }: {
	client: BridgeClient;
	/** 当前会话；空（开始页）不显示。 */
	sessionId?: string;
	/** 页面可见性（不可见时暂停轮询）。 */
	active?: boolean;
	onOpenAutomation: () => void;
}): React.JSX.Element | null {
	const t = useT();
	const [data, setData] = useState<ScheduleListResult>(EMPTY);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!active) return;
		let alive = true;
		const refresh = async (): Promise<void> => {
			try {
				const result = await client.request<ScheduleListResult>({ type: "schedule.list" });
				if (alive && result.ok && result.result) setData(result.result);
			} catch {
				// 断连时保留上次数据，连接恢复由 schedule.changed / 轮询带回来
			}
		};
		void refresh();
		const offChanged = client.onScheduleChanged(() => void refresh());
		const poll = setInterval(() => void refresh(), 30_000);
		const clock = setInterval(() => setNow(Date.now()), 30_000);
		return () => {
			alive = false;
			offChanged();
			clearInterval(poll);
			clearInterval(clock);
		};
	}, [client, active]);

	const next = useMemo(() => {
		return data.tasks
			.filter((task) => task.enabled && task.sessionId === sessionId && task.nextRunAt !== null)
			.sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))[0] ?? null;
	}, [data, sessionId]);

	if (sessionId === undefined || next === null) return null;
	return (
		<button type="button" className="owl-schedule-pin" onClick={onOpenAutomation} title={t("automation.pinTitle" as TextKey)}>
			<span className="owl-schedule-pin-icon">⏱</span>
			<b>{next.name}</b>
			<span className="owl-schedule-pin-repeat">{next.repeat.kind === "daily" ? `每天 ${next.repeat.time}` : next.repeat.kind === "weekly" ? `周${"日一二三四五六"[next.repeat.weekday] ?? ""} ${next.repeat.time}` : next.repeat.kind === "interval" ? `每 ${next.repeat.minutes} 分钟` : next.repeat.kind === "cron" ? `cron ${next.repeat.expr}` : "一次性"}</span>
			<span className="owl-schedule-pin-next">
				{t("automation.pinNext" as TextKey, { time: formatClock(next.nextRunAt ?? 0), until: untilLabel(next.nextRunAt, now) })}
			</span>
		</button>
	);
}
