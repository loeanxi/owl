import { isIP } from "node:net";
import { fetch as transportFetch } from "undici";

const PUBLIC_DNS_ENDPOINT = "https://1.1.1.1/dns-query";
const MAX_DNS_RESPONSE_BYTES = 16 * 1024;

function dnsRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Independently resolve a Fake-IP hostname; no source URL, headers or credentials reach this request. */
export async function resolvePublicNewsHost(hostname: string, signal: AbortSignal): Promise<string[]> {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (!host || host.length > 253 || isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host))
		throw new Error("信源域名不能用于独立公网解析");
	const controller = new AbortController();
	const requestSignal = AbortSignal.any([signal, controller.signal]);
	try {
		const replies = await Promise.all([1, 28].map(async (type) => {
			const endpoint = new URL(PUBLIC_DNS_ENDPOINT);
			endpoint.searchParams.set("name", host);
			endpoint.searchParams.set("type", String(type));
			const response = await transportFetch(endpoint, {
				headers: { accept: "application/dns-json" },
				redirect: "error",
				signal: requestSignal,
			});
			if (response.status !== 200 || Number(response.headers.get("content-length") ?? 0) > MAX_DNS_RESPONSE_BYTES) {
				await response.body?.cancel();
				throw new Error("公网 DNS 响应不可用或超过大小限制");
			}
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			const reader = response.body?.getReader();
			if (reader)
				try {
					for (;;) {
						const part = await reader.read();
						if (part.done) break;
						bytes += part.value.byteLength;
						if (bytes > MAX_DNS_RESPONSE_BYTES) {
							await reader.cancel();
							throw new Error("公网 DNS 响应超过大小限制");
						}
						chunks.push(part.value);
					}
				} finally {
					reader.releaseLock();
				}
			const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!dnsRecord(payload) || payload.Status !== 0 || !Array.isArray(payload.Question) || payload.Question.length !== 1)
				throw new Error("公网 DNS 响应状态无效");
			const question: unknown = payload.Question[0];
			if (!dnsRecord(question) || question.type !== type || typeof question.name !== "string" || question.name.toLowerCase().replace(/\.$/, "") !== host)
				throw new Error("公网 DNS 响应与请求域名不符");
			if (payload.Answer === undefined) return [];
			if (!Array.isArray(payload.Answer) || payload.Answer.length > 128)
				throw new Error("公网 DNS 答案无效");
			const addresses: string[] = [];
			for (const answer of payload.Answer) {
				if (!dnsRecord(answer) || typeof answer.type !== "number" || !Number.isInteger(answer.type) || typeof answer.data !== "string")
					throw new Error("公网 DNS 答案格式无效");
				if (answer.type !== 1 && answer.type !== 28) continue;
				if (answer.type !== type || isIP(answer.data) !== (answer.type === 1 ? 4 : 6))
					throw new Error("公网 DNS 答案不是有效 IP 地址");
				addresses.push(answer.data);
			}
			return addresses;
		}));
		const addresses = [...new Set(replies.flat())];
		if (!addresses.length) throw new Error("公网 DNS 没有返回地址");
		return addresses;
	} catch {
		throw new Error(signal.aborted ? "信源公网 DNS 解析超时或已取消" : "无法取得信源真实公网地址，请检查网络或代理后重试。");
	} finally {
		controller.abort();
	}
}
