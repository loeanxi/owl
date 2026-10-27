/**
 * 浏览器工具的错误码。
 *
 * 浏览器工具失败时抛的 Error 只有一句自然语言，宿主与模型都只能读文本、没法按码
 * 分支。这里给出一套固定词表：抛出的错误带 `code` 属性，消息统一以 `CODE: ` 开头，
 * 于是「消息前缀」可供日志与模型直接 grep，「error.code」可供直接调用方分支处理。
 *
 * 错误仍然以抛出为主（agent loop 会把抛出转成 isError 结果，不会中断这一轮），
 * 不改成返回 isError：现有调用方与测试都按抛出语义写的。
 */

export type BrowserErrorCode =
	| "SKILL_REQUIRED"
	| "BROWSER_CONTROL_DISABLED"
	| "BROWSER_BUDGET_EXCEEDED"
	| "BROWSER_SESSION_BUSY"
	| "BROWSER_OPERATION_TIMEOUT"
	| "INVALID_INPUT"
	| "PAGE_NOT_FOUND"
	| "FOREIGN_PAGE"
	| "STALE_REF"
	| "FILE_NOT_AUTHORIZED"
	| "FILE_TOO_LARGE"
	| "FILE_UNAVAILABLE"
	| "EXECUTION_FAILED";

export class BrowserToolError extends Error {
	code: BrowserErrorCode;

	constructor(code: BrowserErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "BrowserToolError";
		this.code = code;
	}
}

/** 把任意抛出的值归一成带码的浏览器错误。 */
export function toBrowserToolError(error: unknown): BrowserToolError {
	if (error instanceof BrowserToolError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new BrowserToolError("EXECUTION_FAILED", message);
}
