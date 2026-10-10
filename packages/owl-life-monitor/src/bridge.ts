/**
 * owl-life-monitor 桥插件入口：认领 life.probe，对本机 owl 做一轮廉价只读体检。
 */

import type { BridgePluginFactory } from "@owl/owl-coding-agent";
import { probeLife } from "./life-monitor.ts";

const createLifeMonitorBridgePlugin: BridgePluginFactory = (context) => ({
	requests: {
		"life.probe": (request) =>
			probeLife({
				agentDir: context.agentDir,
				cwd: typeof request.cwd === "string" ? request.cwd : undefined,
				model: typeof request.model === "string" ? request.model : undefined,
				sessionDirFor: context.sessionDirFor,
			}),
	},
});

export default createLifeMonitorBridgePlugin;
