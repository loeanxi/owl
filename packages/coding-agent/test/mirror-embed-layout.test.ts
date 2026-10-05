import { describe, expect, it } from "vitest";
import {
	clampFloatRect,
	containRect,
	computeLayout,
	embedStyle,
	hideRect,
	restoreStyle,
	viewportToParentClient,
	WS_CAPTION,
	WS_CHILD,
	WS_THICKFRAME,
	type EmbedMode,
} from "../src/modes/desktop/mirror/embed-layout.ts";

describe("containRect", () => {
	it("竖屏窗口装进宽扁舞台：宽度顶满、垂直居中", () => {
		const rect = containRect(432, 704, 568, 920);
		expect(rect.width).toBeLessThanOrEqual(432);
		expect(rect.height).toBeLessThanOrEqual(704);
		// 等比：缩放系数取 min
		const scaleW = rect.width / 568;
		const scaleH = rect.height / 920;
		expect(Math.abs(scaleW - scaleH)).toBeLessThan(0.01);
		expect(Math.abs((rect.y + rect.height / 2) - 704 / 2)).toBeLessThanOrEqual(1);
		expect(rect.x).toBeGreaterThanOrEqual(0);
	});

	it("窗口比舞台小则居中放大到贴合（不小于 min 尺寸）", () => {
		const rect = containRect(1000, 860, 200, 200);
		expect(rect.width).toBe(860);
		expect(rect.height).toBe(860);
		expect(rect.x).toBe(Math.round((1000 - 860) / 2));
		expect(rect.y).toBe(0);
	});

	it("退化输入不产生零/负尺寸", () => {
		const rect = containRect(0, 0, 568, 920);
		expect(rect.width).toBeGreaterThanOrEqual(1);
		expect(rect.height).toBeGreaterThanOrEqual(1);
	});
});

describe("viewportToParentClient", () => {
	it("css 坐标按 dpr 缩放为物理坐标，加父窗口原点偏移", () => {
		const rect = viewportToParentClient({ x: 10, y: 20, width: 300, height: 500 }, 1.5, 8, 12);
		expect(rect).toEqual({ x: 10 * 1.5 + 8, y: 20 * 1.5 + 12, width: 450, height: 750 });
	});

	it("dpr=1 且无偏移时原样透传（取整）", () => {
		const rect = viewportToParentClient({ x: 3.6, y: 0, width: 100.4, height: 200 }, 1, 0, 0);
		expect(rect).toEqual({ x: 4, y: 0, width: 100, height: 200 });
	});
});

describe("hideRect", () => {
	it("远在父客户区之外（负坐标），回来时不会因为舞台变大而重新可见", () => {
		const rect = hideRect();
		expect(rect.x).toBeLessThanOrEqual(-20_000);
		expect(rect.y).toBeLessThanOrEqual(-20_000);
	});
});


describe('超高窗口的顶对齐', () => {
	it('窗口高于舞台：y 顶对齐 0（不遮上方工具条），向下溢出', () => {
		const rect = containRect(418, 630, 568, 963);
		expect(rect.y).toBe(0);
		expect(rect.x).toBeGreaterThanOrEqual(0);
	});
	it('computeLayout sidebar 同样顶对齐（高度下发 contain 值，容器自行钳制）', () => {
		const rect = computeLayout('sidebar', { width: 418, height: 630 }, 1, { width: 568, height: 963 });
		expect(rect.y).toBe(0);
		expect(rect.height).toBe(630);
		expect(rect.width).toBeLessThanOrEqual(418);
	});
});

describe("clampFloatRect", () => {
	it("矩形完全在界内时原样保留", () => {
		const rect = { x: 50, y: 60, width: 300, height: 400 };
		expect(clampFloatRect(rect, 1000, 800)).toEqual(rect);
	});

	it("越界时夹回边界内", () => {
		const rect = { x: 900, y: 700, width: 300, height: 400 };
		const clamped = clampFloatRect(rect, 1000, 800);
		expect(clamped.x).toBe(1000 - 300);
		expect(clamped.y).toBe(800 - 400);
	});

	it("比边界还大时缩到贴边并回到原点", () => {
		const clamped = clampFloatRect({ x: -80, y: -40, width: 1600, height: 1200 }, 1000, 800);
		expect(clamped.width).toBeLessThanOrEqual(1000);
		expect(clamped.height).toBeLessThanOrEqual(800);
		expect(clamped.x).toBeGreaterThanOrEqual(0);
		expect(clamped.y).toBeGreaterThanOrEqual(0);
	});
});

describe("style bit math", () => {
	it("embedStyle 清掉 caption/thickframe 并置 WS_CHILD", () => {
		const overlapped = WS_CAPTION | WS_THICKFRAME | 0x00c80000; // 典型 overlapped 组合
		const next = embedStyle(overlapped);
		expect(next & WS_CAPTION).toBe(0);
		expect(next & WS_THICKFRAME).toBe(0);
		expect(next & WS_CHILD).toBe(WS_CHILD);
	});

	it("restoreStyle 用原始样式整体还原（清掉 WS_CHILD）", () => {
		const original = WS_CAPTION | WS_THICKFRAME | 0x00c80000;
		const embedded = embedStyle(original);
		expect(restoreStyle(embedded, original)).toBe(original);
	});
});

describe("computeLayout（三形态）", () => {
	const stage = { width: 432, height: 704 };
	const dpr = 1;
	const win = { width: 568, height: 920 };

	it("sidebar/expand：contain 居中（物理坐标）", () => {
		for (const mode of ["sidebar", "expand"] as EmbedMode[]) {
			const rect = computeLayout(mode, stage, dpr, win);
			const expected = containRect(stage.width, stage.height, win.width, win.height);
			expect(rect.width).toBe(expected.width);
			expect(rect.height).toBe(expected.height);
		}
	});

	it("float：使用用户给的悬浮矩形并夹取到界内", () => {
		const rect = computeLayout(
			"float",
			stage,
			dpr,
			win,
			{ x: 4000, y: 5000, width: 260, height: 420 },
		);
		expect(rect.x).toBeLessThanOrEqual(stage.width - 260);
		expect(rect.y).toBeLessThanOrEqual(stage.height - 420);
		expect(rect.width).toBe(260);
	});

	it("float 无悬浮矩形时退化为居中 contain", () => {
		const rect = computeLayout("float", stage, dpr, win);
		const expected = containRect(stage.width, stage.height, win.width, win.height);
		expect(rect.width).toBe(expected.width);
		expect(rect.height).toBe(expected.height);
	});

	it("dpr>1 时输出物理像素", () => {
		const rect = computeLayout("sidebar", { width: 432, height: 704 }, 1.5, win);
		const css = containRect(432, 704, win.width, win.height);
		expect(rect.width).toBe(css.width * 1.5);
	});
});
