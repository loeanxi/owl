/**
 * Auto-retry policy for agent turns, extracted from AgentSession.
 *
 * Owns the attempt counter and the abortable exponential-backoff wait for
 * transient assistant errors (overloaded / rate limit / server / network).
 * Error classification (built-in rules plus user `retry.retryableErrorPatterns`)
 * and the `settings.retry` budget live here; session-tree surgery (omitting the
 * failed attempt from the model projection) stays with AgentSession and is
 * injected as a callback.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { retryDelayMs } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	isContextOverflow,
	isRetryableAssistantError,
	type RetryCallbacks,
} from "@earendil-works/pi-ai/compat";
import { sleep } from "../utils/sleep.ts";
import type { AgentSessionEvent } from "./agent-session.ts";

/** Narrow dependency surface AgentSession provides to the retry controller. */
export interface SessionRetryDeps {
	/** Live `settings.retry` budget; re-read on each decision so settings changes apply. */
	getSettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
	/** User-configured extra retryable substrings, precedence over built-in non-retryable rules. */
	getErrorPatterns(): string[];
	emit(event: AgentSessionEvent): void;
	/** Context window of the model that produced the message, for overflow classification. */
	resolveContextWindow(message: AssistantMessage): number;
}

/** Summarization call sites that share the agent-turn retry policy. */
export type SummarizationRetrySource =
	| { source: "branchSummary" }
	| { source: "compaction"; reason: "manual" | "threshold" | "overflow" };

export class SessionRetryController {
	private readonly deps: SessionRetryDeps;
	private _abortController: AbortController | undefined = undefined;
	private _attempt = 0;

	constructor(deps: SessionRetryDeps) {
		this.deps = deps;
	}

	/** Current retry attempt (0 if none are in flight). */
	get attempt(): number {
		return this._attempt;
	}

	/** Whether a retry backoff wait is currently in progress. */
	get isWaiting(): boolean {
		return this._abortController !== undefined;
	}

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 * User-configured `retry.retryableErrorPatterns` take precedence over the
	 * built-in non-retryable rules.
	 */
	isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.deps.resolveContextWindow(message))) return false;
		return isRetryableAssistantError(message, this.deps.getErrorPatterns());
	}

	/** Whether the run ending with these messages will continue via auto-retry. */
	willRetryAfterAgentEnd(aborted: boolean, messages: readonly AgentMessage[]): boolean {
		if (aborted) return false;
		const settings = this.deps.getSettings();
		if (!settings.enabled || this._attempt >= settings.maxRetries) {
			return false;
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return this.isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Emit the cancelled end event if a retry cycle was in flight (user abort). */
	finishCancelled(): void {
		if (this._attempt === 0) return;
		const attempt = this._attempt;
		this._attempt = 0;
		this.deps.emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Reset the cycle on a successful assistant response, emitting the success end
	 * event. This prevents attempt accumulation across multiple LLM calls within a
	 * turn. No-op when no retry cycle is in flight.
	 */
	finishSucceeded(): void {
		if (this._attempt === 0) return;
		const attempt = this._attempt;
		this._attempt = 0;
		this.deps.emit({ type: "auto_retry_end", success: true, attempt });
	}

	/** Reset the cycle after the final failed attempt, emitting the failure end event. */
	finishFailed(finalError: string | undefined): void {
		if (this._attempt === 0) return;
		const attempt = this._attempt;
		this._attempt = 0;
		this.deps.emit({ type: "auto_retry_end", success: false, attempt, finalError });
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @param omitFailedAttempt persists the omission of the failed attempt from the
	 * model projection (raw history keeps it)
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	async scheduleRetry(message: AssistantMessage, omitFailedAttempt: () => void): Promise<boolean> {
		const settings = this.deps.getSettings();
		if (!settings.enabled) {
			return false;
		}

		this._attempt++;

		if (this._attempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._attempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._attempt);

		this.deps.emit({
			type: "auto_retry_start",
			attempt: this._attempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		omitFailedAttempt();

		// Wait with exponential backoff (abortable)
		this._abortController = new AbortController();
		try {
			await sleep(delayMs, this._abortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this.finishCancelled();
			return false;
		} finally {
			this._abortController = undefined;
		}

		return true;
	}

	/** Cancel an in-progress retry backoff wait. */
	abort(): void {
		this._abortController?.abort();
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	summarizationCallbacks(source: SummarizationRetrySource): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this.deps.emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this.deps.emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this.deps.emit({ type: "summarization_retry_finished" });
			},
		};
	}
}
