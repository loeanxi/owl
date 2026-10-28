import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { minimatch } from "minimatch";

import type { AskOutcome, AskRequest, WorkflowDriver } from "./types.js";

const READ_CAP = 256 * 1024;
const GREP_MATCH_CAP = 2000;
const GREP_BYTES_CAP = 256 * 1024;
const GLOB_CAP = 2000;
const GIT_DIFF_CAP = 512 * 1024;
const GIT_LOG_CAP = 100;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".zcode", ".owl"]);

function reject(message: string): never {
	throw new Error(message);
}

/** Workspace-relative file list honoring one glob pattern, sorted, capped. */
export function globWorkspace(cwd: string, pattern: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		if (out.length > GLOB_CAP) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(full);
				continue;
			}
			const rel = relative(cwd, full).split(sep).join("/");
			if (minimatch(rel, pattern, { dot: false })) {
				out.push(rel);
				if (out.length > GLOB_CAP) return;
			}
		}
	};
	walk(cwd);
	if (out.length > GLOB_CAP) reject(`files.glob over its cap of ${GLOB_CAP} files; narrow the pattern`);
	return out.sort();
}

function execFile(
	cmd: string,
	args: string[],
	opts: { cwd: string; timeoutMs?: number; maxBuffer?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve, rejectFn) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		const cap = opts.maxBuffer ?? READ_CAP;
		child.stdout?.on("data", (c) => {
			if (stdout.length < cap) stdout += c.toString("utf8");
		});
		child.stderr?.on("data", (c) => {
			if (stderr.length < cap) stderr += c.toString("utf8");
		});
		const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			rejectFn(new Error(`spawn ${cmd} failed: ${e.message}`));
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ exitCode: code ?? -1, stdout, stderr });
		});
	});
}

/**
 * Real world reads, executed by the harness (like ZCode's driver): the sandbox
 * never touches the filesystem itself, so every read stays journaled and
 * replayable.
 */
export class NodeWorldDriver {
	private readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async execute(op: string, args: unknown[]): Promise<unknown> {
		switch (op) {
			case "files.glob":
				return globWorkspace(this.cwd, String(args[0]));
			case "files.read": {
				const path = join(this.cwd, String(args[0]));
				const bytes = readFileSync(path);
				if (bytes.length > READ_CAP) reject(`files.read over its ${READ_CAP} byte cap: ${args[0]}`);
				return bytes.toString("utf8");
			}
			case "files.grep": {
				const pattern = new RegExp(String(args[0]), "gi");
				const glob = args[1] === undefined ? undefined : String(args[1]);
				const out: Array<{ path: string; line: number; text: string }> = [];
				let bytes = 0;
				const files = globWorkspace(this.cwd, glob ?? "**/*");
				for (const rel of files) {
					let text: string;
					try {
						text = readFileSync(join(this.cwd, rel), "utf8");
					} catch {
						continue;
					}
					for (const [index, line] of text.split("\n").entries()) {
						pattern.lastIndex = 0;
						if (!pattern.test(line)) continue;
						out.push({ path: rel, line: index + 1, text: line.slice(0, 400) });
						bytes += line.length;
						if (out.length >= GREP_MATCH_CAP || bytes > GREP_BYTES_CAP) {
							reject(
								`files.grep over its caps (${GREP_MATCH_CAP} matches / ${GREP_BYTES_CAP} bytes); narrow the pattern or glob`,
							);
						}
					}
				}
				return out;
			}
			case "git.changedFiles": {
				const base = args[0] === undefined ? undefined : String(args[0]);
				const gitArgs = base ? ["diff", "--name-only", base] : ["status", "--porcelain"];
				const r = await execFile("git", gitArgs, { cwd: this.cwd });
				if (r.exitCode !== 0) reject(`git.changedFiles failed: ${r.stderr.trim()}`);
				return r.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean)
					.map((l) => (base ? l : l.replace(/^..?\s+/, "")));
			}
			case "git.diff": {
				const gitArgs = ["diff"];
				if (args[0] !== undefined) gitArgs.push(String(args[0]));
				if (args[1] !== undefined) gitArgs.push("--", String(args[1]));
				const r = await execFile("git", gitArgs, { cwd: this.cwd, maxBuffer: GIT_DIFF_CAP });
				if (r.exitCode !== 0) reject(`git.diff failed: ${r.stderr.trim()}`);
				if (r.stdout.length > GIT_DIFF_CAP) reject(`git.diff over its ${GIT_DIFF_CAP} byte cap`);
				return r.stdout;
			}
			case "git.status": {
				const r = await execFile("git", ["status", "--porcelain", "--branch"], { cwd: this.cwd });
				if (r.exitCode !== 0) reject(`git.status failed: ${r.stderr.trim()}`);
				const lines = r.stdout.split("\n").filter(Boolean);
				const branchLine = lines.find((l) => l.startsWith("## "));
				const staged: string[] = [];
				const unstaged: string[] = [];
				const untracked: string[] = [];
				for (const line of lines) {
					if (line.startsWith("## ")) continue;
					const x = line[0];
					const y = line[1];
					const path = line.slice(3).trim();
					if (x === "?") untracked.push(path);
					else if (x !== " ") staged.push(path);
					if (y !== " " && y !== "?") unstaged.push(path);
				}
				return {
					branch: branchLine?.replace(/^## /, "").split("...")[0],
					clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
					staged,
					unstaged,
					untracked,
				};
			}
			case "git.log": {
				const count = Math.min(Math.max(Number(args[0] ?? 20), 1), GIT_LOG_CAP);
				const r = await execFile("git", ["log", `-n`, String(count), `--pretty=format:%H%x1f%s%x1f%an%x1f%aI`], {
					cwd: this.cwd,
				});
				if (r.exitCode !== 0) reject(`git.log failed: ${r.stderr.trim()}`);
				return r.stdout
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const [hash, subject, author, date] = line.split("\x1f");
						return { hash, subject, author, date };
					});
			}
			case "world.run": {
				const cmd = String(args[0]);
				const cmdArgs = (args[1] as string[] | undefined) ?? [];
				const timeoutMs = (args[2] as { timeoutMs?: number } | undefined)?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
				// Nonzero exit is a VALUE; reject only on spawn failure or timeout.
				return await execFile(cmd, cmdArgs, { cwd: this.cwd, timeoutMs, maxBuffer: READ_CAP });
			}
			default:
				reject(`unsupported world op ${op}`);
		}
	}
}

/** Tools whose execution may mutate the workspace (closes the amend import cache). */
export const DEFAULT_WRITE_TOOLS = new Set(["bash", "write", "edit", "powershell"]);

export interface PiAgentDriverOptions {
	/** Workflow cwd: child agents run here. */
	cwd: string;
	/** The owl CLI: a command name on PATH, or an absolute entry (dist/bundle/cli.js). */
	owlCommand?: string;
	/** Arguments inserted before the mode flags (e.g. a CLI entry path when owlCommand is a runtime). */
	owlArgsPrefix?: string[];
	timeoutMs?: number;
	/** Tools that count as a workspace write. */
	writeTools?: ReadonlySet<string>;
	/** Model id (provider-qualified, e.g. "zai-coding-cn/glm-5.3-flash"). */
	model?: string;
	/** Extra environment for the child (e.g. OWL_CODING_AGENT_DIR to pick a config dir). */
	env?: Record<string, string>;
	onSpawn?: (args: string[]) => void;
}

/**
 * Real subagent driver: one child owl process per ask (print/json mode,
 * no session). Mirrors ZCode's per-ask child session shape — the persona rides
 * on --append-system-prompt so the harness contract stays underneath.
 */
export class PiAgentDriver implements WorkflowDriver {
	private readonly world: NodeWorldDriver;
	private readonly owlCommand: string;
	private readonly owlArgsPrefix?: string[];
	private readonly timeoutMs?: number;
	private readonly writeTools: ReadonlySet<string>;
	private readonly model?: string;
	private readonly env?: Record<string, string>;
	/** actorKey → agent session id; continuity within and (via resumeSessionId) across runs. */
	private actorSessions = new Map<string, string>();

	private readonly options: PiAgentDriverOptions;

	constructor(options: PiAgentDriverOptions) {
		this.options = options;
		this.world = new NodeWorldDriver(options.cwd);
		this.owlCommand = options.owlCommand ?? "owl";
		this.owlArgsPrefix = options.owlArgsPrefix;
		this.timeoutMs = options.timeoutMs;
		this.writeTools = options.writeTools ?? DEFAULT_WRITE_TOOLS;
		this.model = options.model;
		this.env = options.env;
	}

	async executeAsk(req: AskRequest): Promise<AskOutcome> {
		// Session continuity: one agent session per actor (ZCode's agent() = one
		// conversation across asks). `--session-id` creates it if missing; later
		// asks of the same actor resume it, so planner-reviewer loops keep context.
		// Persona rides only at creation — it is frozen into the session's system prompt.
		let requestedSessionId = req.resumeSessionId ?? this.actorSessions.get(req.actorKey);
		const creating = requestedSessionId === undefined;
		if (creating) {
			requestedSessionId = randomUUID();
			this.actorSessions.set(req.actorKey, requestedSessionId);
		}
		// `--mode json` streams one NDJSON event per line; the positional arg is the prompt.
		const args = [...(this.owlArgsPrefix ?? []), "--mode", "json", "--session-id", requestedSessionId!];
		if (this.model) args.push("--model", this.model);
		if (creating && req.persona) args.push("--append-system-prompt", req.persona);
		args.push(req.instructions);
		this.options.onSpawn?.(args);

		// OWL_WORKFLOW_CHILD marks the child so the workflow extension never registers
		// its tools there (ZCode's no-nesting rule, enforced mechanically).
		const child = spawn(this.owlCommand, args, {
			cwd: this.cwd,
			env: { ...process.env, OWL_WORKFLOW_CHILD: "1", ...(this.env ?? {}) },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let worldToolCalls = 0;
		let tokens = 0;
		let finalText: string | undefined;
		let streamError: string | undefined;
		let observedSessionId: string | undefined = requestedSessionId!;
		let stderrTail = "";

		const parseLine = (line: string): void => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "session" && typeof event.id === "string") observedSessionId = event.id;
			if (event.type === "toolcall_start" && this.writeTools.has(event.toolName)) worldToolCalls += 1;
			if (event.type === "turn_end" && event.message?.role === "assistant") {
				// Provider errors surface in-stream with exit code 0: turn_end carries
				// stopReason "error" + errorMessage. Never let that pass as an empty success.
				if (event.message.stopReason === "error") {
					streamError = String(event.message.errorMessage ?? "model error");
				}
			}
			if (event.type === "agent_end" && Array.isArray(event.messages)) {
				for (const message of event.messages) {
					if (message.role !== "assistant") continue;
					const usage = message.usage;
					if (usage && typeof usage === "object") {
						tokens += Number((usage as any).output ?? (usage as any).totalTokens ?? 0);
					}
					const text = (message.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n");
					if (text.trim()) finalText = text;
				}
			}
		};

		await new Promise<void>((resolve, rejectPromise) => {
			let buffer = "";
			child.stdout!.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					parseLine(buffer.slice(0, index));
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
				}
			});
			child.stderr!.on("data", (chunk) => {
				stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
			});
			const timer = this.timeoutMs ? setTimeout(() => child.kill(), this.timeoutMs) : undefined;
			child.on("error", (e) => {
				if (timer) clearTimeout(timer);
				rejectPromise(new Error(`spawn ${this.owlCommand} failed: ${e.message}`));
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				if (streamError) {
					rejectPromise(new Error(`owl agent error: ${streamError.slice(0, 300)}`));
					return;
				}
				if (code !== 0) {
					rejectPromise(
						new Error(
							`owl agent exited with code ${code}${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ""}`,
						),
					);
					return;
				}
				resolve();
			});
		});

		return { result: finalText ?? "", stats: { worldToolCalls, tokens, sessionId: observedSessionId } };
	}

	async executeWorldRead(op: string, args: unknown[]): Promise<unknown> {
		return this.world.execute(op, args);
	}

	/** The workflow cwd child agents run in. */
	get cwd(): string {
		return this.options.cwd;
	}
}
