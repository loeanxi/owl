import { expect, it } from "vitest";
import { computerUseSummary } from "./computer-use-summary.ts";

it("shows the action rather than an opaque observation id or input payload", () => {
	expect(computerUseSummary("computer_act", {
		observationId: "opaque-token", action: "set_value", elementId: "e8", text: "actual field payload",
	}, "zh")).toBe("自动 · 设置控件值 e8");
	expect(computerUseSummary("computer_act", { action: "key", combo: "ctrl+s", inputMode: "foreground" }, "en")).toBe("Foreground · Press key (ctrl+s)");
	expect(computerUseSummary("computer_observe", {}, "zh")).toBe("观察窗口 当前应用");
	expect(computerUseSummary("computer_release", {}, "en")).toBe("Release desktop control");
	expect(computerUseSummary("browser_click", {}, "zh")).toBeUndefined();
});

it("identifies automatic routing, explicit background and the requested app", () => {
	expect(computerUseSummary("computer_act", { action: "click", inputMode: "auto", elementId: "e3" }, "en")).toBe("Auto · Click e3");
	expect(computerUseSummary("computer_act", { action: "set_value", inputMode: "background", elementId: "e1" }, "zh")).toBe("后台 · 设置控件值 e1");
	expect(computerUseSummary("computer_act", { action: "open_app", app: "notepad.exe" }, "zh")).toBe("自动 · 打开应用 notepad.exe");
	expect(computerUseSummary("computer_observe", { windowQuery: "记事本" }, "zh")).toBe("观察窗口 记事本");
});
