/**
 * owl-computer-use 扩展入口。
 *
 * 把 Windows 桌面（截图/鼠标/键盘/窗口）作为六个 computer_* 工具暴露给视觉
 * 模型：先 computer_screenshot 拿到屏幕与坐标底子，再 computer_click/type/
 * key/scroll 产出真实输入，最后再截图确认。执行链是 GDI/SendInput C# 内核
 * ← PowerShell 侧车（computer-driver.ps1，JSON 行协议）← ComputerDriverSession。
 *
 * 配置（settings.json）：
 *   "owlComputerUse": { "enabled": true, "maxImageWidth": 1568 }
 * enabled=false 时整个插件不注册任何工具；PowerShell worker 惰性启动、
 * 空闲自停，扩展加载本身不起任何子进程。
 *
 * 安全：非只读工具（click/type/key/scroll/windows focus·restore）全部
 * readOnlyHint=false，落入桌面端 approvalMode 的既有门控（plan 拦截 /
 * confirm 弹审批 / auto 放行）；win+l、ctrl+alt+del 在工具层硬拒。提权
 * 窗口（UIPI）的输入注入会被系统静默丢弃，属于已知边界。
 * @module owl-computer-use
 */
import { type ExtensionAPI } from "@owl/owl-coding-agent";
import { ComputerDriverSession } from "./src/driver/session.ts";
import {
	createClickTool,
	createKeyTool,
	createScreenshotTool,
	createScrollTool,
	createTypeTool,
	createWindowsTool,
	type ComputerUseSettings,
	DEFAULT_MAX_IMAGE_WIDTH,
} from "./src/plugin/tools.ts";

export default function (pi: ExtensionAPI): void {
	if (process.platform !== "win32") {
		console.warn("[owl-computer-use] Windows-only; tools not registered on this platform.");
		return;
	}

	let settings: ComputerUseSettings = {};
	try {
		settings = (pi.getSettings() as { owlComputerUse?: ComputerUseSettings }).owlComputerUse ?? {};
	} catch {
		// 设置系统不可得时按默认开启处理。
	}
	if (settings.enabled === false) return;

	const session = new ComputerDriverSession();
	pi.registerTool(createScreenshotTool(session, { maxImageWidth: settings.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH }));
	pi.registerTool(createClickTool(session));
	pi.registerTool(createTypeTool(session));
	pi.registerTool(createKeyTool(session));
	pi.registerTool(createScrollTool(session));
	pi.registerTool(createWindowsTool(session));
}
