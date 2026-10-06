/**
 * 统一响应体 —— 移植自 manager `common/ApiResponse`。
 * 成功 {ok:true,data}；失败 {ok:false,error,code}。前端与桌面端按 ok 分流。
 */
export type ApiResponseOk<T> = {
	ok: true;
	data: T;
};

export type ApiResponseErr = {
	ok: false;
	error: string;
	code: string;
};

export type ApiResponse<T> = ApiResponseOk<T> | ApiResponseErr;

export function apiOk<T>(data: T): ApiResponseOk<T> {
	return { ok: true, data };
}

export function apiErr(code: string, error: string): ApiResponseErr {
	return { ok: false, error, code };
}
