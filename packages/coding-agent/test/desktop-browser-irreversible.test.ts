import { describe, expect, it, vi } from "vitest";
import type { BrowserHub } from "../src/modes/desktop/browser-hub.ts";
import {
	describeIrreversibleBrowserAction,
	matchIrreversibleActionName,
} from "../src/modes/desktop/browser-irreversible.ts";

function hubWith(name: string | undefined): BrowserHub {
	return {
		describeTarget: vi.fn().mockResolvedValue(name === undefined ? undefined : { name }),
	} as unknown as BrowserHub;
}

describe("irreversible browser action detection", () => {
	it("flags money, deletion, publishing and account changes", () => {
		for (const name of ["确认支付", "立即购买", "删除账号", "发布", "授权给第三方", "转账", "Pay now", "Delete"]) {
			expect(matchIrreversibleActionName(name)).toBeTruthy();
		}
	});

	it("does not flag harmless controls", () => {
		for (const name of ["查询", "搜索", "发送验证码", "上一步", "编辑资料", "移除购物车商品", "Submit form"]) {
			expect(matchIrreversibleActionName(name)).toBeUndefined();
		}
	});

	it("does not flag a bare submit label", () => {
		expect(matchIrreversibleActionName("提交")).toBeUndefined();
		expect(matchIrreversibleActionName("立即提交")).toBeUndefined();
		expect(matchIrreversibleActionName("提交申请材料")).toBeUndefined();
	});

	it("resolves the target name before the click happens", async () => {
		const hub = hubWith("确认支付");
		const action = await describeIrreversibleBrowserAction(hub, "chat", "browser_click", { ref: 7 });
		expect(action?.kind).toBe("支付");
		expect(action?.targetName).toBe("确认支付");
	});

	it("ignores tools that cannot commit anything", async () => {
		const hub = hubWith("确认支付");
		expect(await describeIrreversibleBrowserAction(hub, "chat", "browser_type", { ref: 7 })).toBeUndefined();
		expect(await describeIrreversibleBrowserAction(hub, "chat", "browser_fill_form", { ref: 7 })).toBeUndefined();
	});

	it("stays silent when the target cannot be resolved", async () => {
		expect(
			await describeIrreversibleBrowserAction(hubWith(undefined), "chat", "browser_click", { ref: 7 }),
		).toBeUndefined();
		expect(await describeIrreversibleBrowserAction(hubWith("确认支付"), "chat", "browser_click", {})).toBeUndefined();
	});
});
