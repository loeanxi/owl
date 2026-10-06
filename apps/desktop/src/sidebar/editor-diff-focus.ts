/**
 * 编辑器 diff 装饰的跨组件聚焦总线：对话流改动卡点击文件名时，把要高亮的
 * 文件（工作区相对 POSIX 路径）暂存到这里；EditorTab 消费后拉取该文件的
 * 待审 diff，在 CodeMirror 里做行级装饰并滚动到第一个改动块。
 * 模块级单例（与 review-focus.ts 同款模式），改动卡与 tab 不用互相传 props。
 *
 * 除暂存外还派发 window 事件：editor tab 已挂载（工作台 tab 常驻、非激活
 * 只 hidden）时靠事件立即消费；新开 tab 时由挂载 effect 兜底消费。
 * 与 review-focus 不同的是消费必须「先 peek 匹配再取走」：工作台里同时
 * 挂载着多个 EditorTab 实例，一次性盲取会让不匹配的实例吞掉聚焦请求。
 */

const FOCUS_EVENT = "owl-editor-diff-focus";

let focusPath: string | undefined;

/** 请求编辑器 tab 高亮该文件的待审改动（工作区相对 POSIX 路径）。 */
export function focusEditorDiff(path: string): void {
	focusPath = path;
	window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}

/** 查看当前聚焦路径（不清除）；没有则为 undefined。 */
export function peekEditorDiffFocus(): string | undefined {
	return focusPath;
}

/** 取走暂存的聚焦路径（一次性）。与 peek 配合：路径匹配的实例才取走。 */
export function consumeEditorDiffFocus(): string | undefined {
	const path = focusPath;
	focusPath = undefined;
	return path;
}

/** EditorTab 订阅用：聚焦请求的事件名。 */
export const EDITOR_DIFF_FOCUS_EVENT = FOCUS_EVENT;

