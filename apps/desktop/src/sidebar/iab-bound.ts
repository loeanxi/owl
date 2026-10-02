/**
 * 当前已绑定到 IAB 页面的工作台浏览器 tab 登记（模块级单例：桌面端只有一个
 * 工作台实例）。App 据此判断「agent 打开的页面是否已有面板在看」——没有才
 * 自动开新 tab，避免同一个页面被重复弹面板。
 */
const boundPages = new Set<string>();

export function bindIabPage(pageId: string): void {
	boundPages.add(pageId);
}

export function unbindIabPage(pageId: string): void {
	boundPages.delete(pageId);
}

export function isIabPageBound(pageId: string): boolean {
	return boundPages.has(pageId);
}
