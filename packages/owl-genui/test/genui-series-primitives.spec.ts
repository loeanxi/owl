// Regression (owl-genui): models frequently emit chart series data as PRIMITIVE
// numbers ("series":[{"label":"毛利","data":[168,195,225,278]}]) — the SKILL.md
// documents exactly this shape. repairChartData used to require {label,value}
// objects and silently DROP every primitive point, so charts rendered with a
// legend but empty lines/bars (the "营收与毛利趋势" incident). These tests pin
// primitives and label-less {value} objects as valid data points.
import { describe, expect, it } from "vitest";
import { isRenderableProcess, processGenuiSpec } from "../client/guard.ts";

describe("repairChartData: primitive series data points", () => {
	it("keeps primitive numbers in a native chart series", () => {
		const value = {
			items: [
				{
					type: "chart",
					kind: "bars",
					data: [{ label: "Q1", value: 420 }],
					series: [{ label: "毛利", data: [168, 195, 225, 278] }],
				},
			],
		};
		const processed = processGenuiSpec(value);
		expect(processed.errors).toEqual([]);
		const chart = processed.spec?.items[0] as {
			series?: Array<{ label: string; data: Array<{ label: string; value: number }> }>;
		};
		expect(chart.series?.[0]?.data.map((d) => d.value)).toEqual([168, 195, 225, 278]);
		// 合成的序号 label 保证 x 轴不为空
		expect(chart.series?.[0]?.data[0]?.label).toBe("1");
	});

	it("keeps primitive numbers in an echart preset series and renders", () => {
		const value = {
			items: [
				{
					type: "echart",
					preset: "line",
					height: 300,
					data: [
						{ label: "Q1", value: 420 },
						{ label: "Q2", value: 468 },
					],
					series: [{ label: "毛利", data: [168, 195] }],
				},
			],
		};
		const processed = processGenuiSpec(value);
		expect(processed.errors).toEqual([]);
		expect(isRenderableProcess(processed)).toBe(true);
	});

	it("accepts label-less {value} objects alongside labelled ones", () => {
		const value = {
			items: [
				{
					type: "chart",
					kind: "line",
					data: [{ label: "A", value: 1 }],
					series: [{ label: "s", data: [{ value: 5 }, { label: "B", value: 7 }] }],
				},
			],
		};
		const processed = processGenuiSpec(value);
		expect(processed.errors).toEqual([]);
		const chart = processed.spec?.items[0] as { series?: Array<{ data: Array<{ label: string; value: number }> }> };
		expect(chart.series?.[0]?.data[0]).toMatchObject({ label: "1", value: 5 });
		expect(chart.series?.[0]?.data[1]).toMatchObject({ label: "B", value: 7 });
	});

	it("still drops non-numeric garbage points", () => {
		const value = {
			items: [
				{
					type: "chart",
					kind: "bars",
					data: [{ label: "A", value: 1 }],
					series: [{ label: "s", data: ["n/a", 3] }],
				},
			],
		};
		const processed = processGenuiSpec(value);
		const chart = processed.spec?.items[0] as { series?: Array<{ data: unknown[] }> };
		expect(chart.series?.[0]?.data).toHaveLength(1);
	});
});
