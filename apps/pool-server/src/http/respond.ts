/**
 * HTTP 响应工具 —— 对齐 coding-agent map-http 的 JSON 响应惯例，
 * 响应体统一 ApiResponse 信封。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type ApiResponse, apiErr } from "owl-pool";

export function jsonRespond(
	response: ServerResponse,
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...extraHeaders,
	});
	response.end(JSON.stringify(withSuccess(body)));
}

/**
 * manager 前端认 `success`，owl 内部认 `ok`。两条都写上，原版页面和现有测试都能读。
 */
function withSuccess(body: unknown): unknown {
	if (body !== null && typeof body === "object" && !Array.isArray(body) && "ok" in body) {
		const ok = (body as { ok: unknown }).ok;
		if (typeof ok === "boolean" && !("success" in body)) {
			return { ...body, success: ok };
		}
	}
	return body;
}

/** ApiResponse 成功 → 200。 */
export function respondOk(response: ServerResponse, data: unknown): void {
	jsonRespond(response, 200, { ok: true, data });
}

/** ApiResponse 失败 → 按错误码映射状态码。 */
export function respondErr(response: ServerResponse, code: string, error: string): void {
	jsonRespond(response, statusFor(code), apiErr(code, error));
}

/** 错误码 → HTTP 状态码（对齐 manager GlobalExceptionHandler 的已知映射，未知的归 400）。 */
function statusFor(code: string): number {
	if (code.endsWith("notFound")) {
		return 404;
	}
	if (code === "billing.usageInsufficientBalance") {
		return 402;
	}
	if (code === "common.forbidden") {
		return 403;
	}
	if (code.endsWith("noAccounts")) {
		return 409;
	}
	return 400;
}

/** 按实际读取字节限请求体（移植 RequestBodyLimitFilter：不信任 Content-Length）。 */
export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += buffer.length;
		if (size > maxBytes) {
			throw new Error(`请求体超过上限 ${maxBytes} 字节`);
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim().length === 0) {
		return {};
	}
	const parsed: unknown = JSON.parse(text);
	return parsed;
}

export function readQuery(url: URL, name: string): string | undefined {
	const value = url.searchParams.get(name);
	return value === null ? undefined : value;
}

export type { ApiResponse };
