/**
 * Cookie 读取与下发 —— 对齐 manager `ResponseCookie` 形态：
 * HttpOnly + SameSite=Strict + Path=/，https 场景追加 Secure。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** 解析请求头里的 Cookie；目标名不存在返回 undefined。 */
export function readCookie(request: IncomingMessage, name: string): string | undefined {
	const header = request.headers.cookie;
	if (header === undefined) {
		return undefined;
	}
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) {
			continue;
		}
		if (part.slice(0, eq).trim() === name) {
			return part.slice(eq + 1).trim();
		}
	}
	return undefined;
}

/** 下发会话 Cookie；token 为空串即清除（Max-Age=0）。 */
export function writeSessionCookie(
	response: ServerResponse,
	name: string,
	token: string,
	maxAgeSeconds: number,
	secure: boolean,
): void {
	const parts = [
		`${name}=${token}`,
		"Path=/",
		`Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
		"HttpOnly",
		"SameSite=Strict",
	];
	if (secure) {
		parts.push("Secure");
	}
	const existing = response.getHeader("Set-Cookie");
	const cookies = Array.isArray(existing) ? [...existing.map(String), parts.join("; ")] : [parts.join("; ")];
	response.setHeader("Set-Cookie", cookies);
}
