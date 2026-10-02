// Hand-written declarations for the vendored cc-safety-net guard chunk
// (kenryu42/cc-safety-net 2.4.15, MIT). Only the exports the Owl entry
// consumes are declared, under their original minified names.

import type { Denial, SafetyNetConfig, SafetyNetEvaluation } from "./index-gj6afr0n.js";

/** `he` — record a denial (or full call, when audit scope allows) to the audit sink. */
export declare function he(
	config: SafetyNetConfig,
	denial: Denial,
	getSessionId: () => string,
	meta: { agent: string; toolName?: string; cwd?: string | null },
): void;

/** `N` — run the guard for one analyzed tool call; throws the engine error on analysis failure. */
export declare function N(
	config: SafetyNetConfig,
	analysis: unknown,
	hooks: {
		guard: {
			auditAllowed: boolean;
			policyOptions?: unknown;
			dependencies?: unknown;
		};
		audit: { agent: string; getSessionId: () => string };
	},
): SafetyNetEvaluation;
