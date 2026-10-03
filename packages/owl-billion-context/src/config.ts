/**
 * 配置解析 — 参照 billion-context-pi src/config.ts（MIT）大幅简化。
 *
 * 窗口取当前模型的 contextWindow（优先 ctx.getContextUsage() 的窗口字段）；
 * 其余全部走 acp-kernel defaultConfig 出厂值。上游的三级 acp.json 覆盖
 * （global→provider→model）、prompt pack、输出余量自适应等未移植。
 */
import { defaultConfig, type Config } from "./kernel.js";

export function resolveConfig(contextWindow: number): Config {
	const limit = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 0;
	// 未知窗口（0）时给一个保守的 128K 假窗：内核阈值按比例工作，
	// 比无限窗更安全（nudge 会照常触发而不是永不触发）。
	return defaultConfig(limit > 0 ? limit : 131072);
}
