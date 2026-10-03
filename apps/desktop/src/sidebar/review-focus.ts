/**
 * 改动审批的跨组件聚焦总线：对话流改动卡「工作台审查」跳转时，把要选中的
 * 文件（工作区相对路径）暂存到这里；ReviewTab 消费后选中并展开该文件。
 * 模块级单例（与 sidebar/feed.ts 同款模式），App 与 tab 不用互相传 props。
 *
 * 除暂存外还派发 window 事件：ReviewTab 已打开时清单不会重新加载，靠事件
 * 立即消费；tab 未打开时由清单到位后的 effect 兜底消费。
 */

const FOCUS_EVENT = "owl-review-focus";

let focusPath: string | undefined;

/** 请求工作台「改动审批」卡片选中并展开该文件（工作区相对 POSIX 路径）。 */
export function focusReviewEntry(displayPath: string): void {
	focusPath = displayPath;
	window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}

/** 取走暂存的聚焦路径（一次性）；没有则为 undefined。 */
export function consumeReviewFocus(): string | undefined {
	const path = focusPath;
	focusPath = undefined;
	return path;
}

/** ReviewTab 订阅用：聚焦请求的事件名。 */
export const REVIEW_FOCUS_EVENT = FOCUS_EVENT;
