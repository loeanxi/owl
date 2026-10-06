/**
 * 业务异常 —— 移植自 manager `common/BusinessException`。
 * 错误码全库唯一，HTTP 层据码渲染统一响应体与状态码。
 */
export class BusinessError extends Error {
	/** 全库唯一错误码，如 "checkin.notSupported"。 */
	readonly code: string;
	/** 渲染进响应的附加参数（仅日志/排障用）。 */
	readonly params: Record<string, unknown>;

	constructor(code: string, message: string, params?: Record<string, unknown>) {
		super(message);
		this.name = "BusinessError";
		this.code = code;
		this.params = params ?? {};
	}

	static of(code: string, message: string, params?: Record<string, unknown>): BusinessError {
		return new BusinessError(code, message, params);
	}
}
