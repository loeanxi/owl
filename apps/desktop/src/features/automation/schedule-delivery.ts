/**
 * 会话内投递的解析与展示辅助 —— 桥端 deliveryText 落盘的前缀是这份契约的
 * 事实来源（packages/coding-agent/src/modes/desktop/schedule-service.ts）：
 *
 *   〔owl-schedule:<taskId>〕（自动化任务「<名称>」到点执行 · <节奏> · 现在 <时刻>）\n\n<提示词>
 *
 * ChatStream 据此把这条用户消息渲染成会话内任务卡；旧消息没有标记走兜底
 * 解析（无 taskId，卡上不显示操作）。
 */

export interface ScheduleDeliveryInfo {
	/** 任务 id；旧格式消息没有标记时为 null（无暂停操作）。 */
	taskId: string | null;
	name: string;
	/** 节奏说明（每天 08:30 / 一次性 · …）。 */
	repeat: string;
	/** 到点时刻（yyyy-MM-dd HH:mm）。 */
	time: string;
	/** 标记后的提示词正文。 */
	prompt: string;
}

const WITH_ID = /^〔owl-schedule:([^\〕]+)〕（自动化任务「([^」]+)」到点执行 · (.+) · 现在 ([^\）]+)）\n\n?([\s\S]*)$/;
const LEGACY = /^（自动化任务「([^」]+)」到点执行 · (.+) · 现在 ([^\）]+)）\n\n?([\s\S]*)$/;

/** 识别一条用户消息是否为自动化任务的到点投递；不是回 null。 */
export function parseScheduleDelivery(text: string): ScheduleDeliveryInfo | null {
	const withId = WITH_ID.exec(text);
	if (withId) {
		return {
			taskId: withId[1] ?? null,
			name: withId[2] ?? "",
			repeat: withId[3] ?? "",
			time: withId[4] ?? "",
			prompt: withId[5] ?? "",
		};
	}
	const legacy = LEGACY.exec(text);
	if (legacy) {
		return {
			taskId: null,
			name: legacy[1] ?? "",
			repeat: legacy[2] ?? "",
			time: legacy[3] ?? "",
			prompt: legacy[4] ?? "",
		};
	}
	return null;
}

export function formatClock(ms: number): string {
	const date = new Date(ms);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 相对下一次运行的倒计时（「2 小时后」）。 */
export function untilLabel(target: number | null, now: number): string {
	if (target === null) return "—";
	const delta = target - now;
	if (delta <= 0) return "即将执行";
	const minutes = Math.round(delta / 60_000);
	if (minutes < 1) return "1 分钟内";
	if (minutes < 60) return `${minutes} 分钟后`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时后`;
	return `${Math.floor(hours / 24)} 天后`;
}
