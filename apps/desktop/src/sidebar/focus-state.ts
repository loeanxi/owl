/**
 * 编辑器焦点总线：编辑器报「光标在哪个文件的哪一行」，侧栏回答模型「用户在看
 * 什么」时读它。模块级单例（与 editor-line-focus.ts / review-focus.ts 同款模式），
 * 编辑器与问答焦点快照之间不用互相传 props。
 */

export interface EditorFocus {
	/** workspace 相对 POSIX 路径。 */
	path: string;
	/** 光标所在行（1 起）。 */
	line?: number;
}

let current: EditorFocus | undefined;
const listeners = new Set<() => void>();

/** 报一次新的编辑器焦点（内容没变就不通知，省得空转）。 */
export function reportEditorFocus(focus: EditorFocus | undefined): void {
	if (current?.path === focus?.path && current?.line === focus?.line) return;
	current = focus;
	for (const listener of listeners) listener();
}

/** 当前焦点（不清除）。 */
export function peekEditorFocus(): EditorFocus | undefined {
	return current;
}

/** 订阅焦点变化。 */
export function subscribeEditorFocus(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
