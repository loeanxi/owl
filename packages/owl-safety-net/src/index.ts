// owl-safety-net — safety net for the Owl coding agent.
//
// Blocks destructive shell commands and secret-file access before tool execution,
// fail-closed: any engine error also blocks the call.
//
// Origin: kenryu42/cc-safety-net 2.4.15 (MIT). The rule engine is vendored
// under vendor/chunks/ (see that directory's .d.ts files for the
// minified-export mapping); this entry is a clean rewrite of the upstream
// `dist/pi/index.js` extension against the Owl extension API (@owl/owl-coding-agent).
// Owl raises the vendored controlFlowStates cap from 64 to 1024. Ordinary
// read-only loops (several `for name in ...; do grep`) otherwise die as
// "derived-command work limit" before any dangerous rule runs. The cap still
// fails closed on pathological expansions.
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@owl/owl-coding-agent";
import { he as auditDenial, N as guardEvaluate } from "../vendor/chunks/index-96rww7g0.js";
import type { Denial, SafetyNetAnalysis, SafetyNetEvaluation, ShellProgram } from "../vendor/chunks/index-gj6afr0n.js";
import {
	d as analyzeToolCall,
	be as denialToReason,
	Xe as describeCause,
	o as flags,
	P as genericDenial,
	xe as isAuditAllowed,
	L as isFlagEnabled,
	c as loadConfig,
	h as parseProgram,
	et as resolveConfigCwd,
	p as SafetyNetError,
	q as toolCallKind,
	A as unusableCwdDenial,
	ye as verdictToDenial,
} from "../vendor/chunks/index-gj6afr0n.js";
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
		return workingTreeStashBlock(event) ?? workingTreeRevisionOverwriteBlock(event) ?? evaluateEvent(event, ctx);
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

const GIT_STASH = /\bgit\b(?:\s+(?:-C|-c)\s+\S+|\s+--[^\s;&|]+)*\s+stash\b(?:\s+([^\s;&|)]+))?/g;
const READ_ONLY_STASH_SUBCOMMANDS = new Set(["list", "show"]);

function hasStashWrite(program: ShellProgram): boolean {
	for (const [index, node] of program.nodes.entries()) {
		if (node.body && hasStashWrite(node.body)) return true;
		if (node.nested?.some(hasStashWrite)) return true;
		if (node.kind !== "command") continue;
		const words = node.words?.map((word) => word.text) ?? [];
		const name = (words[0] ?? "")
			.split(/[\\/]/)
			.pop()
			?.replace(/\.exe$/i, "")
			.toLowerCase();
		// These commands treat literal arguments as data. Substitutions above still execute,
		// and a pipe may send the text to a shell/evaluator, so keep that case conservative.
		if (
			/^(?:echo|printf|write-output|write-host|grep|egrep|fgrep|rg)$/.test(name ?? "") &&
			program.nodes[index + 1]?.operator !== "|"
		)
			continue;
		if (name === "git") {
			let cursor = 1;
			while (words[cursor]?.startsWith("-")) {
				const option = words[cursor++]!;
				if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/.test(option)) cursor++;
			}
			if (words[cursor] === "stash" && !READ_ONLY_STASH_SUBCOMMANDS.has(words[cursor + 1] ?? "")) return true;
			continue;
		}
		// Preserve the previous conservative handling of shell -c/eval/script wrappers.
		for (const match of (node.source ?? "").matchAll(GIT_STASH)) {
			if (!READ_ONLY_STASH_SUBCOMMANDS.has(match[1] ?? "")) return true;
		}
	}
	return false;
}

/**
 * Owl rule, not in the vendored engine: `git stash` (push/-u/pop/apply/drop...)
 * rewrites the shared working tree. Agents used it to get a "clean baseline"
 * while other sessions and the user were editing the same checkout; every
 * uncommitted change vanished for the length of a test run, and a failed pop
 * loses work. `git stash list` / `git stash show` only read.
 */
function workingTreeStashBlock(event: ToolCallEvent): ToolCallEventResult | undefined {
	if (!SHELL_PROFILES.has(event.toolName)) return undefined;
	const command = (event.input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const program = parseProgram(command, SHELL_PROFILES.get(event.toolName)!);
	// Incomplete syntax still reaches the engine's fail-closed analysis. Do not discard
	// the old conservative check while the parser cannot distinguish commands from data.
	const stashWrite =
		program.status === "complete"
			? hasStashWrite(program)
			: [...command.matchAll(GIT_STASH)].some((match) => !READ_ONLY_STASH_SUBCOMMANDS.has(match[1] ?? ""));
	if (stashWrite) {
		return {
			block: true,
			reason: `BLOCKED by Owl Safety Net\n\nReason: \`git stash\` takes every uncommitted change out of this working tree, which other sessions or the user may be editing right now; a failed pop loses work.\n\nCommand: ${command}\n\nTo tell new test failures from old ones, compare against the repository's known-failures list (see AGENTS.md). To inspect the committed file, run \`git diff -- <path>\` or \`git show HEAD:<path>\` and read this tool's output. Do not redirect that output onto the working tree file, and do not checkout or restore the file. If the user explicitly wants a stash, ask them to run it themselves.`,
		};
	}
	return undefined;
}

/**
 * `git show HEAD:path > path`, `git checkout -- path`, and `git restore path`
 * replace the shared working tree with another revision. Agents did this after
 * `git stash` was blocked, to manufacture a baseline while other sessions were
 * editing the same file. Reading `git show` or `git diff` into the tool output
 * is allowed.
 */
function workingTreeRevisionOverwriteBlock(event: ToolCallEvent): ToolCallEventResult | undefined {
	if (!SHELL_PROFILES.has(event.toolName)) return undefined;
	const command = (event.input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const segments = command.split(/&&|\|\||;|\r?\n/);
	const replaces = segments.some((segment) => {
		if (
			/\bgit(?:\.exe)?\s+show\b/i.test(segment) &&
			/(?:^|[^&\d])>>?\s*\S+|\btee\b|\bOut-File\b|\bSet-Content\b/i.test(segment)
		)
			return true;
		if (/\bgit(?:\.exe)?\s+checkout\b/i.test(segment) && /\s--\s+\S+/.test(segment)) return true;
		return /\bgit(?:\.exe)?\s+restore\b/i.test(segment) && !/\s(?:-h|--help)\b/.test(segment);
	});
	if (!replaces) return undefined;
	return {
		block: true,
		reason: `BLOCKED by Owl Safety Net\n\nReason: this command replaces a working tree file with another git revision. Other sessions or the user may be editing that file right now.\n\nCommand: ${command}\n\nTo inspect the committed file, run \`git diff -- <path>\` or \`git show HEAD:<path>\` and read this tool's output. Do not redirect that output onto the file.`,
	};
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
			denial: unusableCwdDenial(
				{ directory: "session", problem: "unusable", cwd: ctx.cwd },
				{
					toolName: event.toolName,
				},
			),
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

	const rawCommand = (event.input as { command?: unknown }).command;
	if (typeof rawCommand !== "string" || rawCommand.trim() === "") return malformed(ctx.cwd, event.toolName);
	const command = shell === "posix" ? windowsCdTargets(rawCommand) : rawCommand;

	return {
		kind: "analyze",
		analysis: analyzeToolCall(
			event.toolName,
			command === rawCommand ? event.input : { ...event.input, command },
			{ kind: "command", shell },
			{ configCwd, executionCwd: configCwd },
			command,
		),
	};
}

const MSYS_CD_TARGET = /(\b(?:cd|pushd)\s+)(['"]?)\/([a-zA-Z])(?=[/'"\s;&|)]|$)(\/?)/g;

/**
 * Git Bash on Windows writes drives as `/d/...`. The engine resolves `cd` targets as
 * Windows paths, so `cd /d/repo && rm -rf target` lands outside the cwd and is blocked.
 * Only the `cd` target is rewritten to `D:/...`; other arguments keep their form.
 */
function windowsCdTargets(command: string): string {
	if (process.platform !== "win32") return command;
	return command.replace(
		MSYS_CD_TARGET,
		(_match, prefix: string, quote: string, drive: string) => `${prefix}${quote}${drive.toUpperCase()}:/`,
	);
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
