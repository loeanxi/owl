import { GatewayFault, InMemoryAccountStore } from "owl-pool";
import { describe, expect, it, vi } from "vitest";
import { QoderCheckInProvider } from "../src/account/qoder-checkin.ts";

function account(credentials: Record<string, unknown>) {
	return new InMemoryAccountStore().create({ name: "Qoder 测试账号", platform: "QODER", credentials }, 0);
}

describe("Qoder CN check-in adapter", () => {
	it("浏览器登录 home 没有签到 PAT 时支持平台但未配置，不启动桥", async () => {
		const bridge = vi.fn(async () => ({ status: "SUCCESS", credits: 10 }));
		const provider = new QoderCheckInProvider(bridge);
		const browserLogin = account({ authSource: "ACCOUNT_HOME" });
		expect(provider.supports()).toBe("QODER");
		expect(provider.isConfigured(browserLogin)).toBe(false);
		expect((await provider.checkIn(browserLogin)).status).toBe("INACTIVE");
		expect(bridge).not.toHaveBeenCalled();
	});

	it("配置判断与桥的凭证别名和优先顺序一致", () => {
		const provider = new QoderCheckInProvider(async () => ({}));
		for (const key of [
			"checkinToken",
			"QODERCN_PERSONAL_ACCESS_TOKEN",
			"accessToken",
			"personalAccessToken",
			"authToken",
			"apiKey",
			"token",
		]) {
			expect(provider.isConfigured(account({ [key]: "pat" }))).toBe(true);
		}
		expect(provider.isConfigured(account({ checkinToken: " ", accessToken: "pat" }))).toBe(false);
		expect(provider.isConfigured(account({ accessToken: " ", personalAccessToken: "pat" }))).toBe(false);
		expect(provider.isConfigured(account({ checkinToken: "pat", accessToken: " " }))).toBe(false);
	});

	it.each(["SUCCESS", "ALREADY", "INACTIVE", "FAILED"])("桥返回 %s 映射领域状态而不携带原始响应", async (status) => {
		const provider = new QoderCheckInProvider(async () => ({
			status,
			credits: 10,
			message: "活动结果",
			token: "secret",
		}));
		const result = await provider.checkIn(account({ checkinToken: "pat" }));
		expect(result.status).toBe(status);
		expect(result.message).toBe("活动结果");
		expect(result.detail).toBeNull();
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(result.credits).toBe(["SUCCESS", "ALREADY"].includes(status) ? 10 : null);
	});

	it("桥鉴权拒绝映射 AUTH_ERROR，连通性错误仍为 FAILED", async () => {
		const authProvider = new QoderCheckInProvider(async () => {
			throw new GatewayFault(503, "upstream_auth_required", "controlled error");
		});
		expect((await authProvider.checkIn(account({ checkinToken: "pat" }))).status).toBe("AUTH_ERROR");
		const unavailableProvider = new QoderCheckInProvider(async () => {
			throw new GatewayFault(502, "upstream_unavailable", "controlled error");
		});
		expect((await unavailableProvider.checkIn(account({ checkinToken: "pat" }))).status).toBe("FAILED");
	});
});
