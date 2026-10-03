import type { EvaluationResultView } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";

export type EvaluationProcessStage = EvaluationResultView["status"] | NonNullable<EvaluationResultView["generationPhase"]>;

/** Server phase takes precedence. Old records can only describe the content actually returned. */
export function evaluationProcessStage(result: Pick<EvaluationResultView, "status" | "generationPhase" | "output" | "thinking">): EvaluationProcessStage {
	if (result.status !== "running") return result.status;
	if (result.generationPhase) return result.generationPhase;
	if (result.output.trim()) return "answering";
	if (result.thinking?.trim()) return "thinking";
	return "waiting";
}
