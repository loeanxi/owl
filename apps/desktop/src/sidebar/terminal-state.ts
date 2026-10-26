/**
 * 侧栏终端输出尾巴：模型问「用户终端里刚发生了什么」时的答案来源。
 *
 * 用户可以在侧栏终端里手动跑命令（跑测试、看报错），这段输出模型完全看不见——
 * 它只知道自己用 bash 跑的那些。于是用户在终端看到报错后问模型「这个怎么修」，
 * 模型只能瞎猜。这里把终端滚屏的尾巴记下来，随 sidebar_context 一起给模型。
 * 模块级单例（与 focus-state.ts 同款模式），终端 tab 与 App 之间不用传 props。
 */

const tails = new Map<string, string>();
let lastTouched: string | undefined;

/** 记下某个终端最新的输出尾巴。 */
export function reportTerminalTail(terminalId: string, text: string): void {
	tails.set(terminalId, text);
	lastTouched = terminalId;
}

/**
 * 取输出尾巴：指定终端就取那个；不指定取最近有输出的那个（用户多半在用最近那个）。
 */
export function peekTerminalTail(terminalId?: string | null): string {
	const id = terminalId ?? lastTouched;
	return id === undefined ? "" : (tails.get(id) ?? "");
}

/** 终端关掉时清掉它的尾巴。 */
export function clearTerminalTail(terminalId: string): void {
	tails.delete(terminalId);
	if (lastTouched === terminalId) lastTouched = undefined;
}
