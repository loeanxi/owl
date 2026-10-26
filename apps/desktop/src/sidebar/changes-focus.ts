/**
 * 「改动」卡片定位的跨组件总线：模型让用户看某个文件的差异时，把目标路径
 * （可带行号）暂存到这里；ChangesTab 消费后选中该文件并拉起它的 diff，
 * 有行号时再落到那一行。
 * 模块级单例（与 review-focus.ts 同款模式），App 与 tab 不用互相传 props。
 *
 * 消费要等文件列表到位：工作区改动条目是异步取回的，请求先到时先挂着，
 * 列表里出现该文件后再消费（否则会静默丢掉一次定位）。
 */

const FOCUS_EVENT = "owl-changes-focus";

/** 一次定位请求：文件 + 可选行号。 */
export interface ChangesFocus {
	/** workspace 相对 POSIX 路径。 */
	path: string;
	/** 1 起的行号（定位到差异里的这一行）。 */
	line?: number;
}

let pending: ChangesFocus | undefined;

/** 请求「改动」卡片选中并展开某个文件（可选落到某一行）。 */
export function focusChangesFile(path: string, line?: number): void {
	pending = { path, ...(line !== undefined ? { line } : {}) };
	window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}

/** 查看当前定位目标（不清除）；没有则为 undefined。 */
export function peekChangesFocus(): ChangesFocus | undefined {
	return pending;
}

/** 取走暂存的定位目标（一次性）。 */
export function consumeChangesFocus(): ChangesFocus | undefined {
	const focus = pending;
	pending = undefined;
	return focus;
}

/** ChangesTab 订阅用：定位请求的事件名。 */
export const CHANGES_FOCUS_EVENT = FOCUS_EVENT;
