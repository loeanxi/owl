import type { RailView } from "./ActivityRail.tsx";

/**
 * 图标栏「置顶」状态（Codex 式）：顶部固定入口之外的功能默认不占位，
 * 点了图钉才进入图标栏下方的置顶区。纯函数 + localStorage 薄封装，便于测试。
 */

/** 可置顶的功能视图；顺序即功能抽屉里的展示顺序。 */
export const RAIL_PINNABLE_VIEWS: readonly RailView[] = [
	"news",
	"projects",
	"automation",
	"map",
	"mail",
	"media",
	"expert",
	"bagu",
	"market",
] as const;

export function isPinnableView(view: string): view is RailView {
	return (RAIL_PINNABLE_VIEWS as readonly string[]).includes(view);
}

/** 清洗任意来源（localStorage / 未来 settings 同步）的置顶列表：去未知项、去重、限制数量。 */
export function normalizeRailPins(value: unknown): RailView[] {
	if (!Array.isArray(value)) return [];
	const pins: RailView[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !isPinnableView(entry)) continue;
		if (!pins.includes(entry)) pins.push(entry);
		if (pins.length >= RAIL_PINNABLE_VIEWS.length) break;
	}
	return pins;
}

export function toggleRailPin(pins: readonly RailView[], view: RailView): RailView[] {
	return pins.includes(view) ? pins.filter((pin) => pin !== view) : [...pins, view];
}

const STORAGE_KEY = "owl-rail-pins";

export function loadRailPins(): RailView[] {
	try {
		return normalizeRailPins(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
	} catch {
		return [];
	}
}

export function saveRailPins(pins: readonly RailView[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
	} catch {
		// localStorage 不可用（隐私模式等）就只在本会话内生效
	}
}
