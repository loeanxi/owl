import { createHash } from "node:crypto";
import type { ToolResultEvent } from "../../core/extensions/types.ts";

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}

function fingerprint(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoveryResult(event: ToolResultEvent): Record<string, unknown> | undefined {
	if (isObject(event.structuredContent) && Array.isArray(event.structuredContent.loaded))
		return event.structuredContent;
	try {
		const value: unknown = JSON.parse(
			event.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export interface LoopGuardStop {
	reason: "repeated-error" | "discovery-no-progress" | "turn-budget";
	toolName: string;
	count: number;
}

/** A total model-round budget, independent of successful operations or failure fingerprints. */
export class TaskTurnBudget {
	private limit = 64;
	private count = 0;

	reset(value?: unknown): void {
		this.limit = typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1024 ? value : 64;
		this.count = 0;
	}

	completeTurn(): LoopGuardStop | undefined {
		this.count++;
		return this.count >= this.limit ? { reason: "turn-budget", toolName: "agent", count: this.count } : undefined;
	}
}

/** Only explicit repeated failures and unsuccessful discovery intents; ordinary reads/polls are not stagnation. */
export class TaskLoopGuard {
	private failures = new Map<string, { result: string; count: number }>();
	private discoveries = new Map<string, number>();
	stop: LoopGuardStop | undefined;

	reset(): void {
		this.failures.clear();
		this.discoveries.clear();
		this.stop = undefined;
	}

	observe(event: ToolResultEvent): boolean {
		if (event.isError) {
			const call = fingerprint([event.toolName, event.input]);
			const result = fingerprint(event.content);
			const previous = this.failures.get(call);
			const count = previous?.result === result ? previous.count + 1 : 1;
			this.failures.set(call, { result, count });
			if (this.failures.size > 100) this.failures.delete(this.failures.keys().next().value!);
			if (count === 3) this.stop = { reason: "repeated-error", toolName: event.toolName, count };
			return count === 3;
		}
		if (event.toolName !== "tool_search") {
			if (event.toolName !== "task_check") this.reset();
			return false;
		}
		const result = discoveryResult(event);
		if (!result || !Array.isArray(result.loaded)) return false;
		if (result.loaded.length > 0) {
			this.reset();
			return false;
		}
		if (!Array.isArray(result.steps) || result.steps.length === 0) return false;
		const intents: unknown[] = [];
		for (const step of result.steps) {
			if (!isObject(step) || !["refine", "no_match"].includes(String(step.status)) || !isObject(step.intent))
				return false;
			const intent = step.intent;
			if (typeof intent.capability !== "string" || typeof intent.action !== "string") return false;
			// Preserve the target: different research queries are not the same failed intent.
			const target = intent.target ?? intent.query ?? event.input.query;
			if (typeof target !== "string" || !target.trim()) return false;
			intents.push([
				intent.capability.trim().toLowerCase(),
				intent.action.trim().toLowerCase(),
				target.trim().toLowerCase(),
				intent.constraints ?? [],
			]);
		}
		const key = fingerprint(intents);
		const count = (this.discoveries.get(key) ?? 0) + 1;
		this.discoveries.set(key, count);
		if (this.discoveries.size > 100) this.discoveries.delete(this.discoveries.keys().next().value!);
		if (count === 3) this.stop = { reason: "discovery-no-progress", toolName: event.toolName, count };
		return false;
	}
}
