import { describe, expect, it } from "vitest";
import { BROWSER_CORE_TOOL_NAMES, BrowserHub } from "../src/modes/desktop/browser-hub.ts";

function createHub(): BrowserHub {
	return new BrowserHub({
		onPagesChanged: () => {},
		onFrame: () => {},
		onFileChooser: () => {},
		onDiagnostic: () => {},
	});
}

describe("browser session control", () => {
	it("fails closed once the session control is revoked", async () => {
		const hub = createHub();
		const click = hub.tools("chat-a").find((tool) => tool.name === "browser_click");
		if (!click) throw new Error("browser_click 未注册");
		hub.setSessionControl("chat-a", false);
		await expect(
			click.execute("call", { selector: "#anything" }, undefined, undefined, undefined as never),
		).rejects.toMatchObject({ code: "BROWSER_CONTROL_DISABLED" });
		await hub.dispose();
	});

	it("leaves other sessions untouched", () => {
		const hub = createHub();
		expect(hub.isSessionControlEnabled("chat-a")).toBe(true);
		hub.setSessionControl("chat-a", false);
		expect(hub.isSessionControlEnabled("chat-a")).toBe(false);
		expect(hub.isSessionControlEnabled("chat-b")).toBe(true);
		hub.setSessionControl("chat-a", true);
		expect(hub.isSessionControlEnabled("chat-a")).toBe(true);
	});

	it("reports an unusable URL with a structured code", async () => {
		const hub = createHub();
		const navigate = hub.tools("chat-a").find((tool) => tool.name === "browser_navigate");
		if (!navigate) throw new Error("browser_navigate 未注册");
		await expect(
			navigate.execute("call", { url: "not a url" }, undefined, undefined, undefined as never),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await hub.dispose();
	});

	it("refuses to bind browser tools without a chat", () => {
		const hub = createHub();
		expect(() => hub.tools("  ")).toThrow(/必须绑定聊天/);
	});

	it("holds browser actions until the browser skill has been read", async () => {
		const hub = createHub();
		const tools = hub.tools("chat-a", {
			requiredSkill: "control-in-app-browser",
			skillPath: "/skills/control-in-app-browser/SKILL.md",
		});
		const wait = tools.find((tool) => tool.name === "browser_wait");
		if (!wait) throw new Error("browser_wait 未注册");
		await expect(wait.execute("call", { ms: 1 }, undefined, undefined, undefined as never)).rejects.toMatchObject({
			code: "SKILL_REQUIRED",
		});
		hub.markSkillLoaded("chat-a", "control-in-app-browser");
		const result = await wait.execute("call", { ms: 1 }, undefined, undefined, undefined as never);
		expect(result.isError).toBeFalsy();
		await hub.dispose();
	});

	it("keeps the eagerly activated core tools in sync with the registered tools", async () => {
		const hub = createHub();
		const names = hub.tools("chat-a").map((tool) => tool.name);
		for (const name of BROWSER_CORE_TOOL_NAMES) {
			expect(names).toContain(name);
		}
		await hub.dispose();
	});

	it("leaves the skill gate off unless a required skill is configured", async () => {
		const hub = createHub();
		const wait = hub.tools("chat-a").find((tool) => tool.name === "browser_wait");
		if (!wait) throw new Error("browser_wait 未注册");
		const result = await wait.execute("call", { ms: 1 }, undefined, undefined, undefined as never);
		expect(result.isError).toBeFalsy();
		await hub.dispose();
	});
});
