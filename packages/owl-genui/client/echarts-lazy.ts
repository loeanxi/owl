/**
 * ECharts 引擎懒加载。dsh 用独立 IIFE 资产 + script 注入；owl 改为 vite 动态
 * import——引擎模块连同 echarts 一起被拆成异步 chunk，首次出现 `echart` 节点
 * 时才下载。加载失败时 EChartNode 显示兜底 UI。
 * @module owl-genui/client/echarts-lazy
 */
export { CORE_PRESETS } from "./echarts-engine.ts";

/** The ECharts instance surface (the subset the component uses). */
export interface EChartsInstance {
	setOption: (opt: unknown, notMerge?: boolean) => void;
	resize: () => void;
	dispose: () => void;
}

/**
 * Create an ECharts instance on `el` with the given option (engine loaded on
 * demand). The caller owns the returned instance and must dispose it.
 * @param el - the DOM node to host the chart canvas.
 * @param option - the ECharts option object.
 * @param opts - optional height override.
 * @param engine - 'core'（常用预设的树摇引擎）或 'full'（完整引擎）。
 * @returns the ECharts instance (setOption/resize/dispose).
 */
export async function createChart(
	el: HTMLElement,
	option: unknown,
	opts?: { height?: number },
	engine: "core" | "full" = "core",
): Promise<EChartsInstance> {
	const api = engine === "full" ? await import("./echarts-setup-full.ts") : await import("./echarts-setup-core.ts");
	return api.createChart(el, option as never, opts);
}
