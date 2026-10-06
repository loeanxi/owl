/**
 * 上游异常消息收口 —— 移植自 manager `common/UpstreamMessages`。
 * fetch 抛出的错误消息可能带完整 URL、Authorization 头或上游回显，
 * 对外展示前统一清洗，防止凭证/内网地址泄漏。
 */

/** 上游返回非 2xx 时抛出；status 供 Provider 区分 401/403（鉴权失败）与其他失败。 */
export class UpstreamHttpError extends Error {
	readonly status: number;

	constructor(status: string | number, message: string) {
		super(message);
		this.name = "UpstreamHttpError";
		this.status = typeof status === "string" ? Number.parseInt(status, 10) : status;
	}
}

const AUTH_HEADER_PATTERN = /(authorization|cookie|x-api-key|x-cloudide-session|bearer)\s*[:=][^\s,;"']+/gi;
const URL_PATTERN = /https?:\/\/[^\s"']+/gi;

/** 把任意抛出的错误转成可展示的一行消息：去 URL、去凭证头、限长。 */
export function describeUpstreamError(error: unknown): string {
	if (error === null || error === undefined) {
		return "未知错误";
	}
	let text = error instanceof Error ? error.message : String(error);
	text = text.replace(AUTH_HEADER_PATTERN, "$1=***");
	text = text.replace(URL_PATTERN, (matched) => {
		try {
			const url = new URL(matched);
			return `${url.protocol}//${url.host}/…`;
		} catch {
			return "***";
		}
	});
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
