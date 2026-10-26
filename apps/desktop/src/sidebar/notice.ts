/**
 * 侧栏瞬时提示：模型把内容甩给侧边栏时顺带说明一句「为什么甩给你」，
 * 这句话显示在工作台标题栏，几秒后自动消失。
 * 模块级单例（与 review-focus.ts / feed.ts 同款模式），App 推、工作台收。
 */
import { useSyncExternalStore } from "react";

export interface SidebarNotice {
	/** 自增 id：连续两条提示时旧的清理定时器不会误删新的一条。 */
	id: number;
	text: string;
	tone: "info" | "warn";
}

let current: SidebarNotice | undefined;
let sequence = 0;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

/** 推一条提示（替换上一条）。 */
export function pushSidebarNotice(text: string, tone: SidebarNotice["tone"] = "info"): number {
	current = { id: ++sequence, text, tone };
	notify();
	return current.id;
}

/** 清掉指定 id 的提示（id 不匹配说明已被新提示顶掉，忽略）。 */
export function clearSidebarNotice(id: number): void {
	if (current === undefined || current.id !== id) return;
	current = undefined;
	notify();
}

/** 当前提示快照（无则 undefined）。 */
export function getSidebarNotice(): SidebarNotice | undefined {
	return current;
}

/** 订阅提示变化的 hook（无撕裂读取）。 */
export function useSidebarNotice(): SidebarNotice | undefined {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
		() => current,
	);
}
