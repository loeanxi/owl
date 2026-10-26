/**
 * 编辑器行定位的跨组件总线：模型说「看第 42 行」时，把目标文件与行号暂存
 * 到这里；EditorTab 消费后滚动到该行并闪一次强调色。
 * 模块级单例（与 editor-diff-focus.ts / review-focus.ts 同款模式），App 与
 * tab 不用互相传 props。
 *
 * 与 diff 总线的差别：这里带行号/行段（模型给的锚点），且一次请求只服务一个
 * 文件。工作台里同时挂着多个 EditorTab 实例，消费必须「先 peek 匹配再取走」，
 * 避免不匹配的实例吞掉请求。
 */

const FOCUS_EVENT = "owl-editor-line-focus";

export interface EditorLineFocus {
	/** workspace 相对 POSIX 路径。 */
	path: string;
	/** 1 起的行号。 */
	line?: number;
	/** 1 起的结束行（与 line 一起给出时高亮整段）。 */
	endLine?: number;
	/** 请求时刻：过期的定位请求不再生效（否则半年前的请求会在文件再次打开时突然跳行）。 */
	at: number;
}

/** 定位请求的最长有效期（毫秒）。 */
const STALE_MS = 60_000;

let pending: EditorLineFocus | undefined;

/** 请求编辑器定位到某文件的某一行。 */
export function focusEditorLine(path: string, line?: number, endLine?: number): void {
	pending = {
		path,
		at: Date.now(),
		...(line !== undefined ? { line } : {}),
		...(endLine !== undefined ? { endLine } : {}),
	};
	window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}

/** 查看当前定位请求（不清除）；没有则为 undefined。 */
export function peekEditorLineFocus(): EditorLineFocus | undefined {
	return pending;
}

/** 取走暂存的定位请求（一次性）。与 peek 配合：路径匹配的实例才取走。 */
export function consumeEditorLineFocus(): EditorLineFocus | undefined {
	const focus = pending;
	pending = undefined;
	return focus;
}

/** EditorTab 订阅用：定位请求的事件名。 */
export const EDITOR_LINE_FOCUS_EVENT = FOCUS_EVENT;
