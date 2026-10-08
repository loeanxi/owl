import type { CreditSnapshot } from "./credits.ts";

/** MiMoCode 的账户余额读取尚无可用接口；不启动 serve，也不将模型列表当成余额。 */
export function queryMimoQuota(): CreditSnapshot & { availability: "UNAVAILABLE" } {
	return {
		ok: false,
		credits: null,
		label: "MiMo 账户额度",
		message: "当前 MiMo 接入通道暂未提供账户余额查询，请在平台控制台查看；连通状态和本地用量不代表余额",
		buckets: [],
		availability: "UNAVAILABLE",
	};
}
