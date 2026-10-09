/**
 * Bash execution state for AgentSession — mirrors SessionRetryController style.
 */

import type { AgentSessionEvent } from "./agent-session.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import type { BashExecutionMessage } from "./messages.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";

export interface SessionBashDeps {
	getCwd(): string;
	settingsManager: SettingsManager;
	isStreaming(): boolean;
	appendMessage(message: BashExecutionMessage): void;
	refreshFinalizedContext(): void;
	emit(event: AgentSessionEvent): void;
}

export class SessionBashController {
	private readonly deps: SessionBashDeps;
	private readonly abortControllers = new Set<AbortController>();
	private pendingMessages: BashExecutionMessage[] = [];

	constructor(deps: SessionBashDeps) {
		this.deps = deps;
	}

	get isRunning(): boolean {
		return this.abortControllers.size > 0;
	}

	get hasPendingMessages(): boolean {
		return this.pendingMessages.length > 0;
	}

	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this.abortControllers.add(abortController);

		const prefix = this.deps.settingsManager.getShellCommandPrefix();
		const shellPath = this.deps.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.deps.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this.deps.emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordResult(command, result, options);
			return result;
		} finally {
			this.abortControllers.delete(abortController);
		}
	}

	recordResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		if (this.deps.isStreaming()) {
			this.pendingMessages.push(bashMessage);
		} else {
			this.deps.appendMessage(bashMessage);
			this.deps.refreshFinalizedContext();
		}
	}

	abort(): void {
		for (const abortController of [...this.abortControllers]) {
			abortController.abort();
		}
	}

	flushPending(): void {
		if (this.pendingMessages.length === 0) return;
		for (const bashMessage of this.pendingMessages) {
			this.deps.appendMessage(bashMessage);
		}
		this.pendingMessages = [];
		this.deps.refreshFinalizedContext();
	}
}
