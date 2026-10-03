/**
 * ECharts 完整引擎 setup：规格需要核心集之外的图表类型或直接给 `option` 时
 * 由 echarts-lazy 按需 import（wordcloud 等扩展一并注册）。
 * @module owl-genui/client/echarts-setup-full
 */
import { type EChartsCoreOption, type EChartsType, init as echartsInit } from "echarts";
import "echarts-wordcloud";

/** The engine surface the lazy loader consumes. */
export interface EChartsSetupApi {
	createChart: (el: HTMLElement, option: EChartsCoreOption, opts?: { height?: number }) => EChartsType;
}

export function createChart(el: HTMLElement, option: EChartsCoreOption, opts?: { height?: number }): EChartsType {
	const initOpts = opts !== undefined && opts.height !== undefined ? { height: opts.height } : undefined;
	const instance = echartsInit(el, undefined, initOpts);
	instance.setOption(option);
	return instance;
}
