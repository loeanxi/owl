import { Type } from "typebox";
import { Value } from "typebox/value";

export const RESEARCH_TASK_ENTRY = "owl-research-task";
export const RESEARCH_TASK_FIELDS = [
	"target",
	"function",
	"environment",
	"dataSource",
	"authorization",
	"deliverable",
	"acceptance",
] as const;
export type ResearchTaskField = (typeof RESEARCH_TASK_FIELDS)[number];

export interface ResearchTaskFact {
	state: "unreviewed" | "unknown" | "user_stated";
	value: string | null;
	evidence: Array<{ inputId: string; quote: string }>;
}

export interface ResearchTaskRecord {
	id: string;
	version: 1;
	taskId: string;
	revision: number;
	ownerSessionId: string;
	updatedAt: string;
	originalRequest: string;
	inputHash: string;
	inputs: Array<{
		id: string;
		text: string;
		sha256: string;
		truncated: boolean;
		attachedPaths?: string[];
		imageCount?: number;
	}>;
	facts: Record<ResearchTaskField, ResearchTaskFact>;
	missingMaterials: string[];
	toolMatches: Array<{
		operation: string;
		requestedTools: string[];
		registeredTools: string[];
		unavailableTools: string[];
	}>;
	modelFit: {
		selected: { provider: string; id: string; inputTypes: string[]; inputCompatible: boolean } | null;
		candidates: Array<{ provider: string; id: string; inputCompatible: boolean }>;
		basis: string;
	};
	response: {
		state: "not_started" | "received" | "declined_candidate" | "provider_refused" | "error" | "cancelled";
		provider?: string;
		model?: string;
		summary: string;
	};
	acceptance: {
		state: "not_run" | "partial" | "failed";
		/** Component/file checks never certify completion of the original goal. */
		goalVerified: false;
		checks: Array<{
			id: string;
			taskId: string;
			inputHash: string;
			criterion: string;
			kind: "file_exists" | "sha256" | "json_value";
			status: "passed" | "failed";
			artifactPath: string;
			artifactSha256: string | null;
			verifier: string;
			summary: string;
		}>;
	};
	status: "needs_input" | "in_progress" | "partial" | "blocked" | "unverified";
}

const id = Type.String({ minLength: 1, maxLength: 100 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const shortText = Type.String({ minLength: 1, maxLength: 2000 });
const names = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 });
const fact = Type.Object(
	{
		state: Type.Union([Type.Literal("unreviewed"), Type.Literal("unknown"), Type.Literal("user_stated")]),
		value: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
		evidence: Type.Array(Type.Object({ inputId: id, quote: shortText }, { additionalProperties: false }), {
			maxItems: 8,
		}),
	},
	{ additionalProperties: false },
);
const candidate = Type.Object({ provider: id, id, inputCompatible: Type.Boolean() }, { additionalProperties: false });
const schema = Type.Object(
	{
		id,
		version: Type.Literal(1),
		taskId: id,
		revision: Type.Integer({ minimum: 1 }),
		ownerSessionId: Type.String({ minLength: 1, maxLength: 256 }),
		updatedAt: Type.String(),
		originalRequest: Type.String({ maxLength: 16384 }),
		inputHash: hash,
		inputs: Type.Array(
			Type.Object(
				{
					id,
					text: Type.String({ maxLength: 16384 }),
					sha256: hash,
					truncated: Type.Boolean(),
					attachedPaths: Type.Optional(
						Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }),
					),
					imageCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 32 },
		),
		facts: Type.Object(
			{
				target: fact,
				function: fact,
				environment: fact,
				dataSource: fact,
				authorization: fact,
				deliverable: fact,
				acceptance: fact,
			},
			{ additionalProperties: false },
		),
		missingMaterials: Type.Array(shortText, { maxItems: 32 }),
		toolMatches: Type.Array(
			Type.Object(
				{ operation: shortText, requestedTools: names, registeredTools: names, unavailableTools: names },
				{ additionalProperties: false },
			),
			{ maxItems: 16 },
		),
		modelFit: Type.Object(
			{
				selected: Type.Union([
					Type.Object(
						{ provider: id, id, inputTypes: names, inputCompatible: Type.Boolean() },
						{ additionalProperties: false },
					),
					Type.Null(),
				]),
				candidates: Type.Array(candidate, { maxItems: 16 }),
				basis: shortText,
			},
			{ additionalProperties: false },
		),
		response: Type.Object(
			{
				state: Type.Union([
					Type.Literal("not_started"),
					Type.Literal("received"),
					Type.Literal("declined_candidate"),
					Type.Literal("provider_refused"),
					Type.Literal("error"),
					Type.Literal("cancelled"),
				]),
				provider: Type.Optional(id),
				model: Type.Optional(id),
				summary: Type.String({ maxLength: 1200 }),
			},
			{ additionalProperties: false },
		),
		acceptance: Type.Object(
			{
				state: Type.Union([Type.Literal("not_run"), Type.Literal("partial"), Type.Literal("failed")]),
				goalVerified: Type.Literal(false),
				checks: Type.Array(
					Type.Object(
						{
							id,
							taskId: id,
							inputHash: hash,
							criterion: shortText,
							kind: Type.Union([
								Type.Literal("file_exists"),
								Type.Literal("sha256"),
								Type.Literal("json_value"),
							]),
							status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
							artifactPath: Type.String({ minLength: 1, maxLength: 2048 }),
							artifactSha256: Type.Union([hash, Type.Null()]),
							verifier: id,
							summary: shortText,
						},
						{ additionalProperties: false },
					),
					{ maxItems: 32 },
				),
			},
			{ additionalProperties: false },
		),
		status: Type.Union([
			Type.Literal("needs_input"),
			Type.Literal("in_progress"),
			Type.Literal("partial"),
			Type.Literal("blocked"),
			Type.Literal("unverified"),
		]),
	},
	{ additionalProperties: false },
);

/** Pure wire validation, shared with the renderer. This never certifies the user's goal. */
export function isResearchTaskRecord(value: unknown, ownerSessionId?: string): value is ResearchTaskRecord {
	if (!Value.Check(schema, value)) return false;
	const task = value as ResearchTaskRecord;
	const timestamp = Date.parse(task.updatedAt);
	if (
		!Number.isFinite(timestamp) ||
		new Date(timestamp).toISOString() !== task.updatedAt ||
		(!task.originalRequest.trim() &&
			!task.inputs.some((input) => (input.imageCount ?? 0) > 0 || (input.attachedPaths?.length ?? 0) > 0))
	)
		return false;
	if (ownerSessionId !== undefined && task.ownerSessionId !== ownerSessionId) return false;
	if (new TextEncoder().encode(JSON.stringify(task)).length > 192 * 1024) return false;
	const inputs = new Map(task.inputs.map((input) => [input.id, input]));
	if (inputs.size !== task.inputs.length) return false;
	for (const value of Object.values(task.facts)) {
		if (value.state !== "user_stated") {
			if (value.value !== null || value.evidence.length !== 0) return false;
			continue;
		}
		if (!value.value?.trim() || !value.evidence.length) return false;
		if (
			value.evidence.some(
				(ref) =>
					!ref.quote.trim() ||
					!(
						inputs.get(ref.inputId)?.text.includes(ref.quote) ||
						inputs.get(ref.inputId)?.attachedPaths?.some((path) => path.includes(ref.quote))
					) ||
					!ref.quote.includes(value.value!),
			)
		)
			return false;
	}
	if (task.acceptance.checks.some((check) => check.taskId !== task.taskId || check.inputHash !== task.inputHash))
		return false;
	if (task.acceptance.state === "not_run" && task.acceptance.checks.length) return false;
	if (
		task.acceptance.state === "partial" &&
		(!task.acceptance.checks.length || task.acceptance.checks.some((check) => check.status === "failed"))
	)
		return false;
	if (task.acceptance.state === "failed" && !task.acceptance.checks.some((check) => check.status === "failed"))
		return false;
	return true;
}
