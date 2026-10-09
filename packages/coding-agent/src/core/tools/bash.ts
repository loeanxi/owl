import { constants, existsSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { killSessionProcess, type ProcessEntry, registerSessionProcess, waitSessionProcess } from "./process-store.ts";

const BASH_UPDATE_THROTTLE_MS = 100;

import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/** unified-exec 默认让渡时限：命令超过 10s 未结束就返回 session_id 转入后台（对标 Codex）。 */
export const DEFAULT_YIELD_TIME_MS = 10_000;
const MIN_YIELD_TIME_MS = 1_000;
const MAX_YIELD_TIME_MS = 600_000;

export function resolveYieldTimeMs(yieldTimeMs: number | undefined): number | undefined {
	if (yieldTimeMs === undefined) return undefined;
	if (!Number.isFinite(yieldTimeMs) || yieldTimeMs < MIN_YIELD_TIME_MS) return MIN_YIELD_TIME_MS;
	return Math.min(yieldTimeMs, MAX_YIELD_TIME_MS);
}

/**
 * unified-exec 会话的环境加固：禁掉分页器/彩色输出等交互式噪音，
 * 防止长会话输出污染模型上下文（对标 Codex 的 NO_COLOR/TERM=dumb/PAGER=cat）。
 */
function getSessionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...base,
		NO_COLOR: "1",
		CLICOLOR: "0",
		TERM: "dumb",
		PAGER: "cat",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const GREP_NO_MATCH_STATUS =
	'Command exited with code 1 (grep: no lines matched — an empty result, not an execution error). Treat it as "no matches"; append `|| true` to the command if a no-match should not surface as a failed command.';

/** 去掉 2>&1、2>/dev/null 这类重定向，避免其中的 & 被当成命令分隔。 */
function withoutRedirections(command: string): string {
	return command.replace(/\d*>&\d+|\d*(?:>>?|<)\s*[^\s;&|]+/g, " ");
}

function pipelineEndsWithGrep(statement: string): boolean {
	const last = statement.split("|").pop()?.trim() ?? "";
	return /^(grep|rg)(\s|$)/.test(last);
}

/**
 * grep/rg 的退出码语义：1 = 没有匹配行（正常的空结果，`grep -c` 还会先打出 0），
 * 2 = 真正的执行错误。
 * `;` 与换行的退出码来自最后一条语句：最后一条是 grep/rg 时，1 就是没匹配。
 * `&&` / `||` 可能短路，只有整段都是 grep/rg 才认定退出码来自 grep。
 * `echo boom; exit 1` 这类复合失败仍是错误。命令替换无法静态判断，不纳入。
 */
function grepNoMatchStatus(command: string): string | undefined {
	const cleaned = withoutRedirections(command.trim());
	if (/`|\$\(/.test(cleaned)) return undefined;
	const withoutLogic = cleaned.replace(/&&|\|\|/g, " ");
	if (/&/.test(withoutLogic)) return undefined;
	const statements = cleaned
		.split(/\n|&&|\|\||;/)
		.map((statement) => statement.trim())
		.filter(Boolean);
	if (statements.length === 0) return undefined;
	const shortCircuit = /&&|\|\|/.test(cleaned);
	if (shortCircuit) {
		return statements.every(pipelineEndsWithGrep) ? GREP_NO_MATCH_STATUS : undefined;
	}
	return pipelineEndsWithGrep(statements[statements.length - 1] ?? "") ? GREP_NO_MATCH_STATUS : undefined;
}

/**
 * 只读 git 查询报「不是仓库」是探路答案。commit/push 等写操作的 128 仍是失败。
 */
function gitNotRepositoryStatus(command: string, exitCode: number, output: string): string | undefined {
	if (exitCode !== 128 || !/not a git repository/i.test(output)) return undefined;
	// 允许 git -C / --git-dir 这类选项出现在子命令前；commit、push 等写操作对不上子命令名。
	if (!/\bgit\b(?:\s+-[^\s;|&]+)*\s+(?:status|log|rev-parse|diff|show|ls-files|branch|remote)\b/.test(command)) {
		return undefined;
	}
	return "Command exited with code 128 (not a git repository — an answer, not a shell failure). Don't retry the same git command in this directory; cd to the repo root or inspect the path.";
}

/**
 * 探测型命令的非零退出是「答案」而不是故障，不标成错误：命令里出现 `2>/dev/null`
 * 说明作者已预期可能不命中并主动压掉 stderr（如探测目录是否存在）；`ls`/`find` 等
 * 只读查找带 `2>&1` 时，路径不存在（退出码 2）同样是答案。test/[、command -v、
 * which、type 的退出码本身就是判断结果（1 = 未找到/条件为假）。
 * 只认 1/2——127 起的命令缺失、137/139 的被杀崩溃仍是真失败。没加重定向的
 * `ls no-such-dir` 仍是错误。只按形态分类；`|| true` 收尾的命令退出码本来就是 0。
 */
function isProbeExit(command: string, exitCode: number): boolean {
	if (exitCode !== 1 && exitCode !== 2) return false;
	const silenced = command.split(/\n|&&|\|\||;|\||&/).some((segment) => {
		const s = segment.trim();
		if (!s) return false;
		if (/2>\s*\/dev\/null/.test(s)) return true;
		return exitCode === 1 && /^(?:command\s+-v|which|type|test|\[\[|\[)(?:\s|$)/.test(s);
	});
	if (silenced) return true;
	return command.split(/\n|&&|\|\||;/).some((part) => {
		const s = part.trim();
		if (!/2>&1/.test(s)) return false;
		return /(?:^|\|\s*)(?:ls|find|stat|cat|head|tail|file)\b/.test(s);
	});
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in seconds. When set, the command blocks until it finishes or is killed at the timeout (classic behavior). Ignored when yield_time_ms is set.",
		}),
	),
	yield_time_ms: Type.Optional(
		Type.Number({
			description: `Unified-exec mode: if the command is still running after this many milliseconds, keep it running in the background and return its session_id instead of waiting. Default ${DEFAULT_YIELD_TIME_MS} when timeout is not set. Interact with the session via the process tool (poll/write/kill/list).`,
		}),
	),
	max_output_tokens: Type.Optional(
		Type.Number({ description: "Approximate max tokens of output returned in unified-exec mode. Default 10000." }),
	),
});

/** Prepended to every bash command so `| head` / `| tail` cannot hide earlier failures. */
export const BASH_PIPEFAIL_PREFIX = "set -o pipefail";

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: [
		"You can inspect PI_* environment variables for current model and session details.",
		"grep/rg exit with code 1 when no lines match (code 2 on real errors). grep -c prints 0 and still exits 1. A ';' chain whose last command is grep/rg and exits 1 is an empty result, not a failure. ls/find of a missing path with 2>&1, and read-only git commands that report 'not a git repository', are answers — read the output instead of retrying the same command.",
		"For Node scripts with async resources, await resource cleanup and set process.exitCode for a natural exit; forcing process.exit() can interrupt cleanup or output.",
		"Bash runs with `set -o pipefail`: a failing producer in a pipeline (`cmd | head`) makes the whole command fail even if head exits 0. Prefer that over relying on PIPESTATUS.",
		"When handing files from Git Bash to native Windows Node/Python, quote paths and prefer workspace-relative paths; shell /tmp/MSYS aliases can refer to a different native directory.",
		"Match Node module format to the file: use .cjs for require/module.exports and .mjs for import/export; check package.json type when using .js.",
	],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Optional(
		Type.Union([Type.Number(), Type.Null()], { description: "Exit code; absent while the command is still running" }),
	),
	wall_time_seconds: Type.Number(),
	session_id: Type.Optional(Type.Number({ description: "Set when the command is still running in the background" })),
	status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("exited")])),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
	/**
	 * unified-exec：把命令作为可存活的会话进程启动，返回进程表条目。
	 * 未实现时（例如远程执行后端），shell 工具自动退回经典 exec 语义。
	 */
	spawnSession?: (
		command: string,
		cwd: string,
		options: {
			sessionId: string;
			env?: NodeJS.ProcessEnv;
			onData?: (data: string) => void;
		},
	) => ProcessEntry;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const signalCode = child.signalCode;
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
		spawnSession: (command, cwd, { sessionId, env, onData }) => {
			const shellConfig = resolveShellConfig();
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				// stdin 保持打开：会话进程后续可经 process 工具写入
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				// stdin 传输型 shell（如 WSL bash -s）靠关闭 stdin 触发执行，之后无法再写
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			return registerSessionProcess({
				child,
				sessionId,
				command,
				cwd,
				acceptsStdin: !commandFromStdin,
				onData,
			});
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	// bash 语法提示只给 bash 工具：模型常把 CMD/PowerShell 姿势（cd /d、dir）带进 bash，
	// 第一条命令就失败。powershell 工具共用本函数，不能注入这条提示。
	const isBash = config.shellName === "bash";
	const syntaxNote = isBash
		? "Commands run in bash (Git Bash on Windows): use POSIX syntax only; cmd/PowerShell forms like 'cd /d', 'dir' or %VAR% fail. Pipelines use pipefail so earlier failures are not hidden by head/tail. "
		: "";
	return {
		name: config.name,
		label: config.label,
		description:
			syntaxNote +
			`Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. ` +
			`By default the command runs in unified-exec mode: if it is still running after ${DEFAULT_YIELD_TIME_MS / 1000}s, it keeps running in the background and you get a session_id — use the process tool to poll for output, write stdin ('\\u0003' = Ctrl-C), or kill it. ` +
			`Pass timeout (seconds) for classic block-until-done semantics with a hard kill at the timeout.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout, yield_time_ms }: { command: string; timeout?: number; yield_time_ms?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			// bash 默认开启 pipefail，避免 `false | head` 被当成成功；用户自定义 prefix 叠在其后。
			const prefixParts = [
				...(isBash ? [BASH_PIPEFAIL_PREFIX] : []),
				...(commandPrefix && commandPrefix.trim().length > 0 ? [commandPrefix] : []),
			];
			const resolvedCommand = prefixParts.length > 0 ? `${prefixParts.join("\n")}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				// unified-exec 模式判定：显式 yield_time_ms 优先（此时 timeout 被忽略）；
				// 未显式指定且无 timeout 时默认开启（让渡 10s）；给了 timeout 则保持经典阻塞语义。
				const explicitYield = resolveYieldTimeMs(yield_time_ms);
				const sessionMode =
					ops.spawnSession !== undefined && (explicitYield !== undefined || timeout === undefined);
				const effectiveYield = explicitYield ?? resolveYieldTimeMs(DEFAULT_YIELD_TIME_MS)!;
				if (sessionMode && ops.spawnSession) {
					const ownerSessionId = ctx?.sessionManager?.getSessionId() ?? "unknown";
					// 进程存储回吐的是解码后的文本，转回 Buffer 喂给 OutputAccumulator
					const onSessionData = (text: string) => handleData(Buffer.from(text, "utf-8"));
					let entry: ProcessEntry;
					try {
						entry = ops.spawnSession(spawnContext.command, spawnContext.cwd, {
							sessionId: ownerSessionId,
							env: getSessionEnv(spawnContext.env),
							onData: onSessionData,
						});
					} catch (err) {
						const snapshot = await finishOutput();
						const { text } = formatOutput(snapshot, "");
						throw new Error(appendStatus(text, err instanceof Error ? err.message : String(err)));
					}
					const onAbortSession = () => killSessionProcess(entry);
					if (signal) {
						if (signal.aborted) onAbortSession();
						else signal.addEventListener("abort", onAbortSession, { once: true });
					}
					try {
						const outcome = await waitSessionProcess(entry, effectiveYield);
						if (entry.spawnError) {
							await finishOutput();
							throw entry.spawnError;
						}
						if (signal?.aborted) {
							killSessionProcess(entry);
							throw new Error("aborted");
						}
						if (outcome === "running") {
							entry.listeners.delete(onSessionData);
							const snapshot = await finishOutput();
							const { text: outputText, details } = formatOutput(snapshot, "");
							const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
							const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
							return {
								content: [
									{
										type: "text",
										text: appendStatus(
											outputText,
											`[Command is still running — session_id: ${entry.id}. Use the process tool to poll for output, write stdin ('\\u0003' = Ctrl-C), or kill it.]`,
										),
									},
								],
								details,
								structuredContent: {
									output: fullOutput.content,
									truncated: fullOutput.truncated,
									...(fullOutput.truncated && snapshot.fullOutputPath
										? { full_output_path: snapshot.fullOutputPath }
										: {}),
									wall_time_seconds: wallTimeSeconds,
									session_id: entry.id,
									status: "running" as const,
								},
							};
						}
						exitCode =
							entry.exitCode ??
							(entry.exitSignal ? 128 + (osConstants.signals[entry.exitSignal] ?? 0) : entry.killed ? 137 : 1);
					} finally {
						entry.listeners.delete(onSessionData);
						if (signal) signal.removeEventListener("abort", onAbortSession);
					}
				} else {
					try {
						const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
							onData: handleData,
							signal,
							timeout,
							env: spawnContext.env,
						});
						exitCode = result.exitCode;
					} catch (err) {
						const snapshot = await finishOutput();
						const { text } = formatOutput(snapshot, "");
						if (err instanceof Error && err.message === "aborted") {
							throw new Error(appendStatus(text, "Command aborted"));
						}
						if (err instanceof Error && err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
						}
						throw err;
					}
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (exitCode !== 0) {
					// Git Bash also maps some Windows native crashes to 127. Require a lookup
					// diagnostic before recommending another binary, and preserve runtime failures.
					const commandNotFound =
						exitCode === 127 &&
						!/Assertion failed:|FATAL ERROR:|Segmentation fault|\bUV_HANDLE_CLOSING\b/i.test(
							fullOutput.content,
						) &&
						/^(?:[^\r\n]*:[ \t]*command not found(?:[ \t]*:[^\r\n]*)?|(?:[^\r\n]*[\\/])?(?:ba|da|z|k)?sh(?:\.exe)?:[^\r\n]*:[ \t]*not found)[ \t]*\r?$/im.test(
							fullOutput.content,
						);
					const grepStatus = exitCode === 1 ? grepNoMatchStatus(command) : undefined;
					const gitStatus = gitNotRepositoryStatus(command, exitCode, outputText);
					const status = commandNotFound
						? "Command exited with code 127 (the shell reported a missing command). Check the command named in the diagnostic with `command -v <cmd>` and use an available alternative."
						: (grepStatus ?? gitStatus ?? `Command exited with code ${exitCode}`);
					// 探测类非零退出（grep 无匹配、路径不存在、不是 git 仓库等）对模型仍附带状态行，
					// 但不再标记为错误：它们是探测得到的答案，UI 不应计成失败。
					return {
						content: [{ type: "text", text: appendStatus(outputText, status) }],
						details,
						structuredContent,
						isError: !(grepStatus !== undefined || gitStatus !== undefined || isProbeExit(command, exitCode)),
					};
				}
				return { content: [{ type: "text", text: outputText }], details, structuredContent };
			} finally {
				clearUpdateTimer();
			}
		},
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
