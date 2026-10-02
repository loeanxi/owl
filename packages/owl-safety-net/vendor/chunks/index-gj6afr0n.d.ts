// Hand-written declarations for the vendored cc-safety-net engine chunk.
// The upstream ships this chunk minified (kenryu42/cc-safety-net 2.4.15, MIT);
// only the exports the Owl entry consumes are declared here, under their
// original minified names so the declarations match the .js file exactly.

/** Process environment snapshot plus resolved filesystem anchors. */
export interface SafetyNetConfig {
	env: Map<string, string>;
	home: string;
	tmpdir: string;
	paths: unknown;
	[key: string]: unknown;
}

/** A denial produced by the engine; render it with `be` (denialToReason). */
export interface Denial {
	reason: string;
	intent: string;
	command?: string;
	segment?: string;
	toolName?: string;
	cwd?: string;
	[key: string]: unknown;
}

/** Per-call analysis returned by `d` (analyzeToolCall) and consumed by the guard. */
export interface SafetyNetAnalysis {
	toolName: string;
	input: unknown;
	route: { kind: string; shell?: string };
	context: { configCwd: string; executionCwd: string };
	command?: string;
	[key: string]: unknown;
}

/** Guard verdict; `decision.kind === "deny"` marks a block. */
export interface SafetyNetEvaluation {
	decision: { kind: string; [key: string]: unknown };
	[key: string]: unknown;
}

/** Thrown by the guard when analysis itself failed; carries the best-effort verdict. */
export declare class p extends Error {
	stage: string;
	evaluation: SafetyNetEvaluation;
	cause: unknown;
}

/** `c` — load the engine config (env, home, tmpdir, path anchors). */
export declare function c(): SafetyNetConfig;
/** `ye` — verdict → denial, or undefined when the verdict is not a deny. */
export declare function ye(
	evaluation: SafetyNetEvaluation,
	options?: { includeEvidence?: boolean },
): Denial | undefined;
/** `be` — render a denial as the human-readable block reason (redacted). */
export declare function be(denial: Denial): string;
/** `P` — generic malformed-input denial (fail closed). */
export declare function P(options?: { toolName?: string; command?: string; segment?: string }): Denial;
/** `A` — denial for an unusable session cwd, keyed by directory/problem templates. */
export declare function A(
	info: { directory: string; problem: string; cwd: string },
	options?: { toolName?: string; command?: string },
): Denial;
/** `Xe` — redact an arbitrary error cause into a message string. */
export declare function Xe(cause: unknown): string;
/** `et` — resolve the engine's config cwd from candidate directories. */
export declare function et(fallback: string, candidates: string[], paths: unknown): string | undefined;
/** `d` — analyze one tool call; command kind parses the command, others defer to the guard. */
export declare function d(
	toolName: string,
	input: unknown,
	route: { kind: string; shell?: string },
	context: { configCwd: string; executionCwd: string },
	command: string | null,
): SafetyNetAnalysis;
/** `q` — route kind for non-shell tools (read/edit/write/grep/find/ls). */
export declare function q(toolName: string): string;
/** `xe` — whether full-call auditing is enabled ("all" audit scope). */
export declare function xe(env: Map<string, string>): boolean;
/** `L` — read an env flag descriptor against the config env. */
export declare function L(flag: { name: string; legacyName?: string } | string, env: Map<string, string>): boolean;
/** `o` — engine env flag descriptors (CC_SAFETY_NET_* / legacy SAFETY_NET_*). */
export declare const o: {
	level: { name: string; legacyName?: string };
	strict: { name: string; legacyName?: string };
	paranoid: { name: string; legacyName?: string };
	debug: { name: string; legacyName?: string };
	auditScope: { name: string; legacyName?: string };
	[key: string]: unknown;
};
