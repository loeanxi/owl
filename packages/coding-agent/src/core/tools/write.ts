import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { recordDiffApprovalMutationBefore } from "../diff-approval/registry.ts";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { actionTitleGuideline, actionTitleOf, actionTitleParameter } from "./action-title.ts";
import { assertFullFileRead } from "./edit-read-gate.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
	title: actionTitleParameter,
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: [
		actionTitleGuideline,
		"Use write only for new files or complete rewrites.",
		"For a .ps1 script intended for Windows PowerShell 5.1, UTF-8 without a BOM can be decoded using the Windows ANSI code page. If its content contains non-ASCII text, start content with the actual U+FEFF character (JSON escape \\uFEFF) so write emits a UTF-8 BOM, or keep a temporary script ASCII-only. Validate the generated file with PowerShell Parser.ParseFile before executing it; parsing does not execute the script.",
		"Overwriting an existing file requires having seen the whole current file: a full read or `cat` of it, or your own successful complete write tool call; your own later edits keep either current, and earlier turns count while the file is unchanged on disk. A shell redirection or heredoc does not count as a write tool call: read the whole resulting file before overwriting it with write. Prefer edit for small changes to an existing file. New files can be written directly.",
	],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	/** 模型写的动作短语（工具行标题）。 */
	title?: string;
}

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/** Whether the target file already exists. Default: local filesystem. */
	exists?: (absolutePath: string) => Promise<boolean>;
	/** Read current raw bytes to verify a previous complete write. Omit to require explicit reads. */
	readFile?: (absolutePath: string) => Promise<Buffer>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	readFile: (path) => fsReadFile(path),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined, unknown> {
	const ops = options?.operations ?? defaultWriteOperations;
	const exists = ops.exists ?? pathExists;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist. Overwriting requires having seen the whole current content (a full read or cat, or your own successful complete write tool call, kept current by your own edits; earlier turns count while the file is unchanged). Shell redirects and heredocs do not supply this evidence. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content, title }: { path: string; content: string; title?: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionToolContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				if (ctx?.sessionManager && (await exists(absolutePath))) {
					throwIfAborted();
					assertFullFileRead(
						ctx.sessionManager,
						absolutePath,
						ctx.cwd || cwd,
						path,
						ctx.getPendingNestedToolCalls?.(),
						await ops.readFile?.(absolutePath),
					);
				}
				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				if (!options?.operations) {
					recordDiffApprovalMutationBefore(
						_toolCallId,
						absolutePath,
						content,
						undefined,
						ctx?.sessionManager?.getSessionId?.(),
					);
				}
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				return {
					content: [{ type: "text", text: `Successfully wrote to ${path}` }],
					details: actionTitleOf({ title }) !== undefined ? { title: actionTitleOf({ title }) } : undefined,
				};
			});
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
