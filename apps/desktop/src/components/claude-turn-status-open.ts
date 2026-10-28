/**
 * Claude 的 TurnStatus 组开合 store。
 *
 * 规格来源：Claude Desktop 打包渲染层（`cc1aae219` 的 `DF()` 与 zustand store）：
 *
 *   openTurnStatusGroups: {},                     // scope → 打开的组 key
 *   setOpenTurnStatusGroup: (scope, key) => …     // 打开新组 = 覆盖旧 key
 *   function DF(scope, key) {                     // 行组件只读自己的 (scope, key)
 *     return [store.openTurnStatusGroups[scope] === key, set…];
 *   }
 *
 * 两条语义都来自这份 store：
 *  1. **默认全收起** —— store 初始是空对象，`forceExpanded` 在消息流里
 *     两处调用都没传（恒 false），没有任何程序化展开；跑动中的组也一样收着，
 *     活动靠组头的 shimmer live 标签表达。
 *  2. **单开手风琴** —— 同一 scope 只存一个 key：点开新组自动收起旧组。
 */

const openGroups = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** 这个组现在是否展开（`DF()` 的读侧）。 */
export function claudeGroupOpen(scope: string, key: string): boolean {
	return openGroups.get(scope) === key;
}

/** 点组头：open=true 打开这个组并收起同 scope 的其它组；false 只在它开着时收起。 */
export function claudeGroupToggle(scope: string, key: string, open: boolean): void {
	const current = openGroups.get(scope);
	if (open ? current === key : current !== key) return;
	if (open) openGroups.set(scope, key);
	else openGroups.delete(scope);
	emit();
}

/** React 的 `useSyncExternalStore` 订阅口。 */
export function subscribeClaudeGroups(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 清空全部开合状态（测试隔离用；Claude 的 store 生命周期是整个 app）。 */
export function resetClaudeGroups(): void {
	openGroups.clear();
	emit();
}
