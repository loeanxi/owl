/**
 * 当前已绑定到 IAB 页面的工作台浏览器 tab 登记（模块级单例：桌面端只有一个
 * 工作台实例）。App 据此判断「agent 打开的页面是否已有面板在看」：没有才开
 * 新 tab；有则激活那个 tab（store.activate），避免同一个页面被重复弹面板。
 */
const boundPages = new Map<string, string>(); // pageId → 工作台 tab id

export function bindIabPage(pageId: string, tabId: string): void {
	boundPages.set(pageId, tabId);
}

export function unbindIabPage(pageId: string, tabId: string): void {
	// 多个 tab 可能先后绑过同一页：只清掉仍是自己登记的那条
	if (boundPages.get(pageId) === tabId) boundPages.delete(pageId);
}

export function isIabPageBound(pageId: string): boolean {
	return boundPages.has(pageId);
}

/** 找到绑定某页面的工作台 tab id（App 据此激活已存在的面板）。 */
export function boundTabIdFor(pageId: string): string | undefined {
	return boundPages.get(pageId);
}

/**
 * tab.path 的 IAB 编码：`iab:<pageId>|<url>`。
 * pageId 优先绑定（agent 换页/同 URL 多页都不会绑错），桥重启后 pageId 失效，
 * 回落按 URL 绑定；纯 URL 的旧路径天然兼容。
 */
export function encodeIabPath(pageId: string, url: string): string {
	return `iab:${pageId}|${url}`;
}

export function parseIabPath(path: string | undefined): { pageId?: string; url?: string } {
	if (!path) return {};
	if (path.startsWith("iab:")) {
		const [pageId = "", ...rest] = path.slice(4).split("|");
		return { ...(pageId ? { pageId } : {}), ...(rest.length > 0 && rest[0] ? { url: rest.join("|") } : {}) };
	}
	return { url: path };
}
