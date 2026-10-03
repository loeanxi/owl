/** owl-genui 引擎调试页（仅 dev 用）：用会话里挖出的真实失败 spec 逐个渲染，
 * 打开 http://localhost:5188/debug-genui.html 看控制台。 */
import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import { GenuiActionContext, GenuiBlock, processGenuiSpec, validateGenuiSpec } from "../../../../packages/owl-genui/client/index.ts";
import type { GenuiSpec } from "../../../../packages/owl-genui/client/index.ts";

const noop = () => {};

const dashboard: GenuiSpec = {
	title: "2026 年 Q1—Q4 数据看板",
	gap: 14,
	items: [
		{
			type: "echart",
			title: "营收与毛利趋势（百万元）",
			height: 300,
			preset: "line",
			data: [
				{ label: "Q1", value: 420 },
				{ label: "Q2", value: 468 },
				{ label: "Q3", value: 512 },
				{ label: "Q4", value: 605 },
			],
			series: [{ label: "毛利", data: [168, 195, 225, 278] }],
		},
		{
			type: "chart",
			kind: "bars",
			title: "季度营收（分组）",
			data: [
				{ label: "Q1", value: 420 },
				{ label: "Q2", value: 468 },
			],
			series: [
				{ label: "营收", data: [420, 468, 512, 605] },
				{ label: "毛利", data: [168, 195, 225, 278] },
			],
		},
		{ type: "plot", title: "y = sin(x)", xMin: -6.28, xMax: 6.28, series: [{ label: "sin", expr: "sin(x)" }] },
		{ type: "mermaid", code: "graph LR\nA[需求] --> B[开发] --> C[测试] --> D[发布]" },
	],
} as GenuiSpec;

const mermaidOnly: GenuiSpec = { items: [{ type: "mermaid", code: "graph LR\nA[需求] --> B[开发] --> C[测试] --> D[发布]" }] } as GenuiSpec;

const echartOnly: GenuiSpec = { items: [dashboard.items[0]] } as GenuiSpec;

import { isRenderableProcess } from "../../../../packages/owl-genui/client/guard.ts";

/** 模拟真实 fence 管线：spec 先过 guard 修复再渲染（GenuiBlock 直接喂原始 spec 会绕过守卫）。 */
function guarded(spec: GenuiSpec): GenuiSpec {
  const processed = processGenuiSpec(spec);
  if (isRenderableProcess(processed) && processed.spec !== null) return processed.spec;
  console.warn("[debug] spec not renderable:", processed.errors);
  return spec;
}

function Case({ name, spec }: { name: string; spec: GenuiSpec }): React.JSX.Element {
	return createElement(
		"section",
		null,
		createElement("h2", null, name),
		createElement(
			"div",
			{ className: "owl-genui-root" },
			createElement(GenuiActionContext.Provider, { value: noop }, createElement(GenuiBlock, { spec, animateEntrance: false })),
		),
	);
}

const root = createRoot(document.getElementById("app")!);
root.render(
	createElement(StrictMode, null, [
		createElement(Case, { key: "dash", name: "完整看板（原始失败 spec）", spec: dashboard }),
		createElement(Case, { key: "echart", name: "仅 echart line", spec: echartOnly }),
		createElement(Case, { key: "mermaid", name: "仅 mermaid", spec: mermaidOnly }),
	]),
);
