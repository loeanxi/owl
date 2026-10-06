/**
 * 客户端来源 IP 的唯一解析入口 —— 移植自 manager `security/ClientIpResolver`。
 * 登录锁定、网关 IP 白名单与限流共用本结论，不允许各自再私读转发头。
 *
 * trusted-proxy-count = 0（默认）：只信 TCP 对端地址，X-Forwarded-For 完全不可信。
 * trusted-proxy-count = N：取 X-Forwarded-For 从右数第 N 跳（最近一层可信代理
 * 追加的对端地址）；缺失/链条短于 N 一律退回对端地址，宁可保守。
 */
import type { IncomingMessage } from "node:http";

export function resolveClientIp(request: IncomingMessage, trustedProxyCount: number): string {
	const remote = request.socket.remoteAddress ?? "unknown";
	const trusted = Math.trunc(trustedProxyCount);
	if (trusted <= 0) {
		return remote;
	}
	const xff = request.headers["x-forwarded-for"];
	if (typeof xff === "string" && xff.trim().length > 0) {
		const hops = xff.split(",");
		const index = hops.length - trusted;
		if (index >= 0) {
			const candidate = (hops[index] ?? "").trim();
			if (candidate.length > 0) {
				return candidate;
			}
		}
	}
	const realIp = request.headers["x-real-ip"];
	if (typeof realIp === "string" && realIp.trim().length > 0) {
		return realIp.trim();
	}
	return remote;
}

/** TCP 对端是否回环（self-rescue 模式专用：对端地址取自连接本身，伪造转发头无效）。 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
	if (!remoteAddress) {
		return false;
	}
	return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}
