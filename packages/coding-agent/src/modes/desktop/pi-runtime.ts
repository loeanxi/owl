import { Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { DefaultResourceLoaderOptions } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import {
	type BashRenderState,
	type BashToolDetails,
	bashToolSystemPromptContribution,
	createBashToolDefinition,
	createLocalBashOperations,
} from "../../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../../core/tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../core/tools/truncate.ts";
import { writeToolSystemPromptContribution } from "../../core/tools/write.ts";

/** Aligned with Pi v1.1.0's four-tool prompt, using the current Owl tool guidelines. */
export const PI_SYSTEM_PROMPT = [
	"You are an expert coding assistant operating in Owl's Pi mode. You help users by reading files, executing commands, editing code, and writing new files.",
	"Available tools:",
	...Object.entries({
		read: readToolSystemPromptContribution,
		bash: bashToolSystemPromptContribution,
		edit: editToolSystemPromptContribution,
		write: writeToolSystemPromptContribution,
	}).map(([name, contribution]) => `- ${name}: ${contribution.snippet}`),
	"Guidelines:",
	"- Use bash for file operations like ls, rg, find. Commands run in bash, including on Windows; use POSIX syntax.",
	...new Set(
		[
			...readToolSystemPromptContribution.guidelines,
			...bashToolSystemPromptContribution.guidelines,
			...editToolSystemPromptContribution.guidelines,
			...writeToolSystemPromptContribution.guidelines,
		]
			.filter(
				(guideline) => !/\b(?:codemode|tool_search|skill_search|powershell)\b|\bprocess tool\b/i.test(guideline),
			)
			.map((guideline) => `- ${guideline}`),
	),
	"- Be concise in your responses and use the user's language.",
	"- Show file paths clearly when working with files.",
].join("\n");

/** Preserve Pi's project instructions while excluding automatic add-ons and Owl's default prompt. */
export function piResourceLoaderOptions(
	addenda: string[],
): Pick<
	DefaultResourceLoaderOptions,
	"noExtensions" | "noSkills" | "noPromptTemplates" | "noThemes" | "systemPrompt" | "appendSystemPrompt"
> {
	return {
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt: PI_SYSTEM_PROMPT,
		appendSystemPrompt: addenda,
	};
}

const piBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds; omitted means wait until completion." })),
});

/** Pi has no process tool: commands must finish within the bash call, as in the original Pi implementation. */
export function createPiBashTool(
	cwd: string,
	settingsManager: SettingsManager,
): ToolDefinition<typeof piBashSchema, BashToolDetails | undefined, BashRenderState> {
	const operations = createLocalBashOperations({ shellPath: settingsManager.getShellPath() });
	const tool = createBashToolDefinition(cwd, {
		operations: { exec: operations.exec },
		commandPrefix: settingsManager.getShellCommandPrefix(),
	});
	return {
		...tool,
		parameters: piBashSchema,
		outputSchema: tool.outputSchema
			? Type.Pick(tool.outputSchema, ["output", "truncated", "full_output_path", "exit_code", "wall_time_seconds"])
			: undefined,
		description: `Execute a bash command in the current working directory (Git Bash on Windows; POSIX syntax). Waits until completion; an optional timeout in seconds kills the command if exceeded. Returns stdout and stderr, truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Full truncated output is saved to a temp file.`,
	};
}
