import { afterEach, describe, expect, it, vi } from "vitest";
import { queryMimoQuota } from "../src/account/mimo-quota.ts";

afterEach(() => vi.restoreAllMocks());

describe("MiMo 账户余额可查询能力", () => {
	it("没有账户余额接口时明确为不可查询，不用连通性或本地用量冒充余额", () => {
		const fetchImpl = vi.spyOn(globalThis, "fetch");
		const snapshot = queryMimoQuota();
		expect(snapshot).toEqual({
			ok: false,
			credits: null,
			label: "MiMo 账户额度",
			message: "当前 MiMo 接入通道暂未提供账户余额查询，请在平台控制台查看；连通状态和本地用量不代表余额",
			buckets: [],
			availability: "UNAVAILABLE",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(snapshot).not.toHaveProperty("authRejected");
	});
});
