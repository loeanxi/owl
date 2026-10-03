// 移植自 billion-context-pi src/abort.ts（MIT）
// pi 会把本轮 AbortSignal 传进每个工具 execute()（第三参）；Esc 中止时
// 多阶段处理必须在下一个阶段边界停下，而不是在 abort 后继续跑（并持久化）。
export function assertNotAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const err = new Error("Operation aborted");
	err.name = "AbortError";
	throw err;
}
