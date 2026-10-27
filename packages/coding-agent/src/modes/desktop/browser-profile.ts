/**
 * 浏览器会话的登录态留存。
 *
 * 无头浏览器每个会话都是全新 BrowserContext，cookie 随会话销毁而消失：用户每天
 * 重新开一次对话，就得把每个站点的登录重做一遍，agent 在需要登录的站点上等于
 * 没法干活。这里把 cookie 按会话落盘，重开同一个对话时恢复——会话之间的隔离
 * 还在（各存各的），但同一个对话可以跨重启继续用。
 *
 * 只留 cookie，不留 localStorage / IndexedDB：token 类的登录很多存在
 * localStorage 里，要留就得注入初始化脚本写盘，代价和风险都更高。目前的取舍是
 * 「撑住常见的 session cookie 登录」，其余交给用户在侧栏自己登一次。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cookie } from "playwright-core";

/** 会话 id 里的路径分隔符要清掉，否则能拼出目录穿越。 */
function safeName(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function profilePath(dir: string, sessionId: string): string {
	return join(dir, `${safeName(sessionId)}.json`);
}

/** 保存会话 cookie；失败不抛——登录态只是锦上添花，不能因此让浏览器动作失败。 */
export async function saveSessionCookies(dir: string, sessionId: string, cookies: readonly Cookie[]): Promise<void> {
	if (cookies.length === 0) return;
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(profilePath(dir, sessionId), JSON.stringify({ savedAt: Date.now(), cookies }), "utf8");
	} catch {
		// 落盘失败不影响本次会话继续用。
	}
}

/** 读取会话 cookie；没有记录或记录损坏都返回空数组。 */
export async function loadSessionCookies(dir: string, sessionId: string): Promise<Cookie[]> {
	try {
		const raw = await readFile(profilePath(dir, sessionId), "utf8");
		const parsed = JSON.parse(raw) as { cookies?: unknown };
		if (!Array.isArray(parsed.cookies)) return [];
		return parsed.cookies.filter(
			(cookie): cookie is Cookie =>
				typeof cookie === "object" &&
				cookie !== null &&
				typeof (cookie as Cookie).name === "string" &&
				typeof (cookie as Cookie).value === "string",
		);
	} catch {
		return [];
	}
}
