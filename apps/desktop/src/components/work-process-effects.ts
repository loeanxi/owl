/**
 * 工作过程动效开关。
 *
 * 开关表落在 `document.documentElement.dataset.owlWorkEffects` 上（空格分词），
 * CSS 用 `[data-fx~="rail"]` 之类的属性选择器匹配，组件用 `useWorkEffects()` 订阅同一份值。
 *
 * 与「聊天阅读 → 动态效果」总开关的关系：总开关关掉全部动效（html[data-owl-chat-motion="off"]），
 * 这里决定「总开关开着时，哪些动效开」。两者独立，各自生效。
 */
import { useSyncExternalStore } from "react";

export type WorkEffectId = "rail" | "enter" | "morph" | "count" | "spine" | "breathe" | "nudge";

/** 动效清单，顺序即设置页里的展示顺序。 */
export const WORK_EFFECT_IDS: readonly WorkEffectId[] = [
	"rail",
	"enter",
	"morph",
	"count",
	"spine",
	"breathe",
	"nudge",
];

export type WorkEffects = Readonly<Record<WorkEffectId, boolean>>;

/** 默认全开；逐项回退，坏值只影响自己那一项。 */
export const DEFAULT_WORK_EFFECTS: WorkEffects = Object.freeze({
	rail: true,
	enter: true,
	morph: true,
	count: true,
	spine: true,
	breathe: true,
	nudge: true,
});

/** dataset 上的键名。 */
const DATASET_KEY = "owlWorkEffects";

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function parseWorkEffects(raw: unknown): WorkEffects {
	const value = asRecord(raw);
	const next = {} as Record<WorkEffectId, boolean>;
	for (const id of WORK_EFFECT_IDS) next[id] = typeof value[id] === "boolean" ? value[id] : DEFAULT_WORK_EFFECTS[id];
	return Object.freeze(next);
}

/** 开着的动效 id，顺序跟随 WORK_EFFECT_IDS。 */
export function enabledWorkEffectIds(effects: WorkEffects): WorkEffectId[] {
	return WORK_EFFECT_IDS.filter((id) => effects[id]);
}

/** data-fx 属性值：开着的动效用空格连起来。全关时是空串。 */
export function workEffectsToken(effects: WorkEffects): string {
	return enabledWorkEffectIds(effects).join(" ");
}

function sameEffects(a: WorkEffects, b: WorkEffects): boolean {
	return WORK_EFFECT_IDS.every((id) => a[id] === b[id]);
}

function readDataset(): WorkEffects {
	try {
		if (typeof document === "undefined") return DEFAULT_WORK_EFFECTS;
		const token = document.documentElement.dataset[DATASET_KEY];
		if (!token) return DEFAULT_WORK_EFFECTS;
		const enabled = new Set(token.split(/\s+/).filter(Boolean));
		const next = {} as Record<WorkEffectId, boolean>;
		for (const id of WORK_EFFECT_IDS) next[id] = enabled.has(id);
		return Object.freeze(next);
	} catch {
		return DEFAULT_WORK_EFFECTS;
	}
}

function writeDataset(effects: WorkEffects): void {
	try {
		if (typeof document === "undefined") return;
		document.documentElement.dataset[DATASET_KEY] = workEffectsToken(effects);
	} catch {
		/* 无 DOM 环境时忽略：本次会话内仍然生效。 */
	}
}

// ---------------------------------------------------------------- 订阅式存储 ----

let current: WorkEffects = readDataset();
const listeners = new Set<() => void>();

/** 当前生效值（引用稳定，直到 applyWorkEffects 真正改变了某个字段）。 */
export function getWorkEffects(): WorkEffects {
	return current;
}

export function subscribeWorkEffects(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** 组件用：订阅动效开关，开关变化时所在组件重渲染。 */
export function useWorkEffects(): WorkEffects {
	return useSyncExternalStore(subscribeWorkEffects, getWorkEffects, getWorkEffects);
}

/** 应用一份动效开关：落 dataset 并通知订阅者。幂等，值没变不触发订阅。 */
export function applyWorkEffects(next: unknown): WorkEffects {
	const parsed = parseWorkEffects(next);
	if (sameEffects(parsed, current)) {
		// 值没变也要保证 dataset 与之一致（首次启动时 dataset 还没写过）。
		writeDataset(parsed);
		return current;
	}
	current = parsed;
	writeDataset(parsed);
	for (const listener of [...listeners]) listener();
	return current;
}
