/**
 * owl-career 桥插件入口：认领 career.get，给「我的 Token 生涯」看板汇总本机各 Agent 的用量。
 * 首扫可能较慢（Codex 全量可到 GB 级），前端以加载态等待；之后 mtime+size 缓存秒回。
 */

import type { BridgePluginFactory } from "@owl/owl-coding-agent";
import { collectCareerStats } from "./career-stats.ts";

const createCareerBridgePlugin: BridgePluginFactory = (context) => ({
	requests: {
		"career.get": () => collectCareerStats(context),
	},
});

export default createCareerBridgePlugin;
