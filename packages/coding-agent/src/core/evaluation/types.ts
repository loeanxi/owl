/** Model evaluation contracts. Safe to import in desktop browser code. */
export type EvaluationCategory = "svg" | "html" | "code";
export type EvaluationOutputType = EvaluationCategory | "json";
export type EvaluationThinkingLevel = "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface EvaluationRubricItem {
	id: string;
	label: string;
	description: string;
}
export interface EvaluationCheckSpec {
	id: string;
	label: string;
	kind: string;
	config?: Record<string, unknown>;
}
export interface EvaluationTask {
	id: string;
	version: number;
	title: string;
	category: EvaluationCategory;
	prompt: string;
	input?: string;
	outputType: EvaluationOutputType;
	builtin: boolean;
	source?: { label: string; url: string };
	rubric: EvaluationRubricItem[];
	checks: EvaluationCheckSpec[];
}
export interface EvaluationModel {
	provider: string;
	modelId: string;
	name: string;
	sourceName: string;
	supportedThinkingLevels: EvaluationThinkingLevel[];
	contextWindow: number;
	maxTokens: number;
	/** USD per million tokens. Missing pricing is unknown, never zero. */
	pricing: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}
export interface EvaluationProfileInput {
	id: string;
	provider: string;
	modelId: string;
	thinkingLevel: EvaluationThinkingLevel;
}
export interface EvaluationProfile extends EvaluationProfileInput {
	model: EvaluationModel;
	maxTokens: number;
	timeoutMs: number;
}
export interface EvaluationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}
export interface EvaluationCheck {
	id: string;
	label: string;
	status: "passed" | "failed" | "unchecked";
	detail: string;
}
export interface EvaluationArtifact {
	type: EvaluationOutputType;
	content: string;
	/** Rendering is performed in a restricted sandbox in the desktop UI. */
	previewAllowed: boolean;
}
export interface EvaluationRating {
	scores: Record<string, number>;
	note: string;
}
export interface EvaluationActualModel {
	provider: string;
	modelId: string;
	responseModel: string | null;
	/** null means provider defaults were used, with no guaranteed requested effort. */
	forwardedThinkingLevel: Exclude<EvaluationThinkingLevel, "default"> | null;
	providerThinkingLevel: string | null;
}
export type EvaluationResultStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type EvaluationGenerationPhase = "waiting" | "thinking" | "answering" | "checking";
export interface EvaluationResult {
	id: string;
	taskId: string;
	sample: number;
	attempt: number;
	profileId: string;
	status: EvaluationResultStatus;
	output: string;
	thinking: string;
	/** Present only while queued/running; terminal outcomes are represented by status. */
	generationPhase?: EvaluationGenerationPhase;
	artifact: EvaluationArtifact | null;
	checks: EvaluationCheck[];
	error: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number | null;
	usage: EvaluationUsage | null;
	costUsd: number | null;
	rating: EvaluationRating | null;
	retryOf: string | null;
	actualModel?: EvaluationActualModel;
}
export interface EvaluationGroup {
	taskId: string;
	sample: number;
	/** Stable shuffled result identifiers, including retained retry attempts. */
	resultIds: string[];
	revealed: boolean;
}
export type EvaluationRunStatus = "running" | "completed" | "cancelled" | "interrupted";
export interface EvaluationRun {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	status: EvaluationRunStatus;
	samples: 1 | 3 | 5;
	tasks: EvaluationTask[];
	profiles: EvaluationProfile[];
	results: EvaluationResult[];
	groups: EvaluationGroup[];
}
export interface EvaluationResultView
	extends Omit<
		EvaluationResult,
		"profileId" | "startedAt" | "finishedAt" | "durationMs" | "usage" | "costUsd" | "actualModel"
	> {
	anonymousLabel: string;
	revealed: boolean;
	profile?: EvaluationProfile;
	startedAt?: string | null;
	finishedAt?: string | null;
	durationMs?: number | null;
	usage?: EvaluationUsage | null;
	costUsd?: number | null;
	actualModel?: EvaluationActualModel;
}
export interface EvaluationRunView extends Omit<EvaluationRun, "profiles" | "results"> {
	profileCount: number;
	results: EvaluationResultView[];
}
export interface EvaluationRunSummary {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	status: EvaluationRunStatus;
	taskCount: number;
	profileCount: number;
	samples: 1 | 3 | 5;
	total: number;
	completed: number;
	failed: number;
	pending: number;
	rated: number;
	revealed: number;
}
export interface EvaluationBootstrap {
	tasks: EvaluationTask[];
	models: EvaluationModel[];
	runs: EvaluationRunSummary[];
}
export type EvaluationRequest =
	| { action: "bootstrap" }
	| { action: "task.save"; task: EvaluationTask }
	| { action: "run.start"; name: string; taskIds: string[]; profiles: EvaluationProfileInput[]; samples: 1 | 3 | 5 }
	| { action: "run.get"; runId: string }
	| { action: "run.list" }
	| { action: "run.cancel"; runId: string }
	| { action: "run.append"; runId: string; samples: 3 | 5 }
	| { action: "run.retry"; runId: string; resultId: string }
	| {
			action: "run.reveal";
			runId: string;
			taskId: string;
			sample: number;
			mode: "score" | "skip";
			ratings?: Record<string, EvaluationRating>;
	  };
export interface EvaluationResponseMap {
	bootstrap: EvaluationBootstrap;
	"task.save": EvaluationTask;
	"run.start": EvaluationRunView;
	"run.get": EvaluationRunView;
	"run.list": EvaluationRunSummary[];
	"run.cancel": EvaluationRunView;
	"run.append": EvaluationRunView;
	"run.retry": EvaluationRunView;
	"run.reveal": EvaluationRunView;
}
