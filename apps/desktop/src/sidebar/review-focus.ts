/**
 * 改动审批的跨组件聚焦总线：对话流改动卡「工作台审查」跳转时，把要选中的
 * 文件（工作区相对路径）暂存到这里；ReviewTab 挂载/刷新时消费并选中该文件。
 * 模块级单例（与 sidebar/feed.ts 同款模式），App 与 tab 不用互相传 props。
 */

let focusPath: string | undefined;

/** 请求工作台「改动审批」卡片选中并展开该文件（工作区相对 POSIX 路径）。 */
export function focusReviewEntry(displayPath: string): void {
	focusPath = displayPath;
}

/** 取走暂存的聚焦路径（一次性）；没有则为 undefined。 */
export function consumeReviewFocus(): string | undefined {
	const path = focusPath;
	focusPath = undefined;
	return path;
}
