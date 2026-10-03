/**
 * 当前已绑定到 IAB 页面的工作台浏览器 tab 登记（模块级单例：桌面端只有一个
 * 工作台实例）。App 据此判断「agent 打开的页面是否已有面板在看」：没有才开
 * 新 tab；有则激活那个 tab（store.activate），避免同一个页面被重复弹面板。
 */
import type { IabPageInfo, IabPagesMessage } from "../bridge/protocol.ts";

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
 * tab.path 的 IAB 编码：`iab-session:<sessionId>|<pageId>|<url>`。
 * pageId 优先绑定（agent 换页/同 URL 多页都不会绑错），桥重启后 pageId 失效，
 * 回落按 URL 与原聊天绑定；未归属页面仍使用 `iab:<pageId>|<url>`。
 */
export function encodeIabPath(pageId: string, url: string, sessionId?: string): string {
	if (sessionId) return `iab-session:${encodeURIComponent(sessionId)}|${pageId}|${url}`;
	return `iab:${pageId}|${url}`;
}

export function parseIabPath(path: string | undefined): { pageId?: string; url?: string; sessionId?: string } {
	if (!path) return {};
	if (path.startsWith("iab-session:")) {
		const [encodedSessionId = "", pageId = "", ...rest] = path.slice(12).split("|");
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(encodedSessionId);
		} catch {
			return {};
		}
		return {
			...(sessionId ? { sessionId } : {}),
			...(pageId ? { pageId } : {}),
			...(rest.length > 0 && rest[0] ? { url: rest.join("|") } : {}),
		};
	}
	if (path.startsWith("iab:")) {
		const [pageId = "", ...rest] = path.slice(4).split("|");
		return { ...(pageId ? { pageId } : {}), ...(rest.length > 0 && rest[0] ? { url: rest.join("|") } : {}) };
	}
	return { url: path };
}

/** 后台聊天的浏览器操作不能抢当前聊天的面板。 */
export function agentPageForSession(message: IabPagesMessage, sessionId: string | undefined): IabPageInfo | undefined {
	if (!sessionId || message.origin !== "agent" || message.originSessionId !== sessionId) return undefined;
	const owned = message.pages.filter((page) => page.sessionId === sessionId);
	return owned.find((page) => page.active) ?? owned[0];
}
