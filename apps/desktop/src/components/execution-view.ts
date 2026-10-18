/** Presentation only: switching views never changes the running task. */
export type ExecutionView = "normal" | "thinking" | "verbose";

export const EXECUTION_VIEWS: readonly ExecutionView[] = ["normal", "thinking", "verbose"];

export function isExecutionView(value: unknown): value is ExecutionView {
	return value === "normal" || value === "thinking" || value === "verbose";
}

export function nextExecutionView(view: ExecutionView): ExecutionView {
	return EXECUTION_VIEWS[(EXECUTION_VIEWS.indexOf(view) + 1) % EXECUTION_VIEWS.length]!;
}
