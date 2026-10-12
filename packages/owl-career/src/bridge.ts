/**
 * owl-career 桥插件入口：认领 career.get，给「我的 Token 生涯」看板汇总本机各 Agent 的用量。
 * cached=true 只读上一次完整结果（秒回，可能为 null）；否则做一次增量统计（首扫可能较慢，
 * Codex 全量可到 GB 级；之后 mtime+size 缓存秒回）。
 */

import type { BridgePluginFactory } from "@owl/owl-coding-agent";
import { collectCareerStats, readCareerSnapshot } from "./career-stats.ts";

const createCareerBridgePlugin: BridgePluginFactory = (context) => ({
	requests: {
		"career.get": (request) => (request.cached === true ? readCareerSnapshot(context) : collectCareerStats(context)),
	},
});

export default createCareerBridgePlugin;
