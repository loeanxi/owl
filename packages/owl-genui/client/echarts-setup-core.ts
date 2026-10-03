/**
 * ECharts 核心 setup：树摇后的 echarts/core + 常用图表类型（bar/line/pie/
 * scatter）。vite 会把本模块连同 echarts 一起拆成异步 chunk，仅在规格里出现
 * `echart` 节点时才被 import（见 echarts-lazy.ts），主包不承担引擎体积。
 * @module owl-genui/client/echarts-setup-core
 */

import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import {
	DatasetComponent,
	DataZoomComponent,
	GridComponent,
	LegendComponent,
	MarkAreaComponent,
	MarkLineComponent,
	MarkPointComponent,
	TitleComponent,
	TooltipComponent,
	TransformComponent,
} from "echarts/components";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
	BarChart,
	LineChart,
	PieChart,
	ScatterChart,
	GridComponent,
	TooltipComponent,
	LegendComponent,
	TitleComponent,
	DataZoomComponent,
	MarkLineComponent,
	MarkAreaComponent,
	MarkPointComponent,
	DatasetComponent,
	TransformComponent,
	CanvasRenderer,
]);

/** The engine surface the lazy loader consumes. */
export interface EChartsSetupApi {
	createChart: (el: HTMLElement, option: EChartsCoreOption, opts?: { height?: number }) => EChartsType;
}

export function createChart(el: HTMLElement, option: EChartsCoreOption, opts?: { height?: number }): EChartsType {
	const initOpts = opts !== undefined && opts.height !== undefined ? { height: opts.height } : undefined;
	const instance = echarts.init(el, undefined, initOpts);
	instance.setOption(option);
	return instance;
}
