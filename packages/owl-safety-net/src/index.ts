// owl-safety-net — safety net for the Owl coding agent.
//
// Blocks destructive shell commands and secret-file access before tool execution,
// fail-closed: any engine error also blocks the call.
//
// Origin: kenryu42/cc-safety-net 2.4.15 (MIT). The rule engine is vendored
// verbatim under vendor/chunks/ (see that directory's .d.ts files for the
// minified-export mapping); this entry is a clean rewrite of the upstream
// `dist/pi/index.js` extension against the Owl extension API (@owl/owl-coding-agent).
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@owl/owl-coding-agent";
import {
	A as unusableCwdDenial,
	P as genericDenial,
	Xe as describeCause,
	be as denialToReason,
	c as loadConfig,
	d as analyzeToolCall,
	et as resolveConfigCwd,
	L as isFlagEnabled,
	o as flags,
	p as SafetyNetError,
	q as toolCallKind,
	xe as isAuditAllowed,
	ye as verdictToDenial,
} from "../vendor/chunks/index-gj6afr0n.js";
import type { Denial, SafetyNetAnalysis, SafetyNetEvaluation } from "../vendor/chunks/index-gj6afr0n.js";
import { N as guardEvaluate, he as auditDenial } from "../vendor/chunks/index-96rww7g0.js";
import { ee as referenceDoc } from "../vendor/chunks/index-pm924a1e.js";

const COMMAND_NAME = "safety-net";
const COMMAND_DESCRIPTION = "Explain Safety Net: blocks, rules, env flags, diagnostics";
const DEFAULT_COMMAND_QUESTION = "Help me with the safety net.";
const AGENT_LABEL = "owl";

/** Shell tool name → engine shell profile. Other tools go through file-access analysis. */
const SHELL_PROFILES = new Map<string, string>([
	["bash", "posix"],
	["powershell", "powershell"],
]);

/** Outcome of looking at one tool_call event before handing it to the guard. */
type Extraction =
	| { kind: "skip" }
	| { kind: "malformed"; denial: Denial; cwd: string | null }
	| { kind: "analyze"; analysis: SafetyNetAnalysis };

export default function createSafetyNetExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => handleToolCall(event, ctx));
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		handler: async (args, cmdCtx) => {
			pi.sendUserMessage(buildDocPrompt(args), cmdCtx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}

function handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
	try {
		return evaluateEvent(event, ctx);
	} catch (error) {
		console.error("owl-safety-net error:", error);
		// Fail closed: an engine crash must not wave the call through.
		return block(genericDenial());
	}
}

function evaluateEvent(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
	const config = loadConfig();
	const extraction = extract(event, ctx, config.paths);
	if (extraction.kind === "skip") return undefined; // Nothing this extension checks.

	const getSessionId = () => ctx.sessionManager.getSessionId();
	const finish = (evaluation: SafetyNetEvaluation, includeEvidence: boolean) => {
		const denial = verdictToDenial(evaluation, { includeEvidence });
		return denial ? block(denial) : undefined;
	};

	if (extraction.kind === "malformed") {
		auditDenial(config, extraction.denial, getSessionId, {
			agent: AGENT_LABEL,
			toolName: extraction.denial.toolName,
			cwd: extraction.cwd,
		});
		return block(extraction.denial);
	}

	try {
		const evaluation = guardEvaluate(config, extraction.analysis, {
			guard: {
				auditAllowed: isAuditAllowed(config.env),
				policyOptions: undefined,
				dependencies: undefined,
			},
			audit: { agent: AGENT_LABEL, getSessionId },
		});
		return finish(evaluation, true);
	} catch (error) {
		if (!(error instanceof SafetyNetError)) throw error;
		if (isFlagEnabled(flags.debug, config.env)) {
			console.error(`owl-safety-net debug: tool_call analysis failed: ${describeCause(error.cause)}`);
		}
		return finish(error.evaluation, extraction.analysis.route.kind === "command");
	}
}

/**
 * Turn one tool_call event into an engine analysis, a must-deny malformed result,
 * or a skip when the tool is not of interest.
 */
function extract(event: ToolCallEvent, ctx: ExtensionContext, paths: unknown): Extraction {
	if (typeof event.toolName !== "string" || event.toolName.trim() === "") return malformed(ctx.cwd, undefined);
	if (typeof ctx.cwd !== "string" || ctx.cwd.trim() === "") return malformed(null, event.toolName);

	const configCwd = resolveConfigCwd(".", [ctx.cwd], paths);
	if (!configCwd) {
		return {
			kind: "malformed",
			denial: unusableCwdDenial({ directory: "session", problem: "unusable", cwd: ctx.cwd }, {
				toolName: event.toolName,
			}),
			cwd: ctx.cwd,
		};
	}

	const shell = SHELL_PROFILES.get(event.toolName);
	if (!event.input || typeof event.input !== "object") {
		return shell ? malformed(ctx.cwd, event.toolName) : { kind: "skip" };
	}

	if (!shell) {
		return {
			kind: "analyze",
			analysis: analyzeToolCall(
				event.toolName,
				event.input,
				{ kind: toolCallKind(event.toolName) },
				{ configCwd, executionCwd: configCwd },
				null,
			),
		};
	}

	const command = (event.input as { command?: unknown }).command;
	if (typeof command !== "string" || command.trim() === "") return malformed(ctx.cwd, event.toolName);

	return {
		kind: "analyze",
		analysis: analyzeToolCall(
			event.toolName,
			event.input,
			{ kind: "command", shell },
			{ configCwd, executionCwd: configCwd },
			command,
		),
	};
}

function malformed(cwd: string | null, toolName: string | undefined): Extraction {
	return { kind: "malformed", denial: genericDenial({ toolName }), cwd };
}

function block(denial: Denial): ToolCallEventResult {
	return { block: true, reason: denialToReason(denial) };
}

function buildDocPrompt(args: string): string {
	return `${referenceDoc.slice(referenceDoc.indexOf("# CC Safety Net")).trimEnd()}

## User request

${args.trim() || DEFAULT_COMMAND_QUESTION}`;
}
