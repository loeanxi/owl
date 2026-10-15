/**
 * owl-computer-use 扩展入口。
 *
 * 三个模型专用工具：computer_observe / computer_act / computer_release。
 * 观察绑定宿主任务、窗口、控件和图片；动作消费一次观察令牌，返回明确的效果
 * 状态与后续观察。按能力自动选择后台 UIA 或前台 SendInput，WGC 由受监督
 * 的原生侧车执行。
 *
 * 配置（settings.json）：
 *   "owlComputerUse": { "enabled": true, "maxImageWidth": 1568 }
 * enabled=false 时整个插件不注册任何工具；PowerShell worker 惰性启动、
 * 空闲自停，扩展加载本身不起任何子进程。
 *
 * 桌面审批分类显式区分观察、动作和自身资源清理。输入冲突作废本次令牌，
 * 可重观察；取消、会话切换和最终收口释放 worker，前台输入由 Windows mutex 保护。
 * @module owl-computer-use
 */
import { type ExtensionAPI, subscribeDesktopControlInterruption } from "@owl/owl-coding-agent";
import { ComputerDriverSession } from "./src/driver/session.ts";
import { ComputerUseRuntime } from "./src/plugin/runtime.ts";
import { type ComputerUseSettings } from "./src/plugin/tools.ts";
import { createComputerTools } from "./src/plugin/tools-v2.ts";

const TASK_GUIDELINES = [
	"执行当前桌面任务时，先 computer_observe 用 windowQuery 或 windowId 定位目标并加载 computer_act；多个匹配时选择窗口，避免一直观察用户正在使用的无关前台。默认 inputMode:auto，由工具按控件能力优先后台 UIA，必要时选择前台键鼠，无需用户逐步选择模式。用户明确要求只用后台、只操作已有窗口或遇输入就停止时，遵守该限制。",
	"任务明确需要某应用且窗口不存在时，可用 computer_act 的 open_app 与 app 参数打开正常应用，再枚举并核对新窗口；不要要求用户代开能自行打开的应用。open_app 不是 shell 命令入口；不得因目标缺失而向当前无关前台窗口输入。",
	"read_conflict 或 retryable 表示当前快照/动作需重新观察，不代表整个任务失败。按 nextAction 处理：用户忙时先做可验证的后台步骤，需前台则等待短暂空闲后重新观察；目标、模式或前置条件变化后再重试，不原样循环无效动作。",
	"用户明确停止、Escape、宿主取消或会话结束必须立即停止并 computer_release；这类停止不能自动恢复。普通输入冲突可重观察恢复，但用户明确要求输入后等待新指令时必须等待。连续无法取得可用控制条件时说明尚未完成和所需条件，不把等待误报为成功。",
	"每次动作使用当前 observationId，并从结果读取 executedMode、executedAction、fallbackReason。issued 只说明已投递；unknown/partial 先 computer_observe 检查实际结果，不重放可能已发生的动作。完成任务前必须通过控件回读或真实截图验证目标状态；结束时 computer_release，仅释放自己的资源。",
];

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
	const runtime = new ComputerUseRuntime(session, settings);
	let lifecycleEpoch = 0;
	for (const tool of createComputerTools(runtime)) {
		pi.registerTool({ ...tool, promptGuidelines: [...TASK_GUIDELINES, ...(tool.promptGuidelines ?? [])] });
	}
	const unsubscribe = subscribeDesktopControlInterruption((event) => {
		if (runtime.interruptForWindow(event.windowId)) {
			lifecycleEpoch++;
			session.close();
		}
	});
	pi.on("agent_start", (_event, ctx) => {
		lifecycleEpoch++;
		runtime.beginRun(ctx.sessionManager.getSessionId());
	});
	const release = async () => {
		const cleanupEpoch = ++lifecycleEpoch;
		try {
			await runtime.release();
		} finally {
			// A new agent_start may run while native cleanup is awaiting its response.
			// That old cleanup must not terminate the new run's worker or observations.
			if (lifecycleEpoch === cleanupEpoch) session.close();
		}
	};
	pi.on("agent_settled", release);
	pi.on("session_before_switch", release);
	pi.on("session_start", release);
	pi.on("session_shutdown", async () => {
		unsubscribe();
		await release();
	});
}
