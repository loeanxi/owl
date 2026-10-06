/**
 * OpenAI 流式上游的基础设施 —— 移植自 manager `gateway/SseEventReader`、
 * `OpenAiStreamCompletion`、`UpstreamToolCalls` 与 IncompleteUpstreamStreamException。
 */

/** 上游流不完整（EOF 无终止证据/事件非法）：驱动冷却与换号。 */
export class IncompleteUpstreamStreamException extends Error {
	constructor(message = "上游流不完整") {
		super(message);
		this.name = "IncompleteUpstreamStreamException";
	}
}

export interface SseEvent {
	name: string;
	data: string;
}

/**
 * SSE 分帧：event:/data: 行解析，空行出帧；EOF 时残留 data 也成帧。
 * 协议解释留在各适配器。
 */
export class SseEventReader {
	#name = "message";
	#data: string[] = [];
	#hasData = false;

	/** 喂一行（不带行尾）；返回成帧的事件或 null。 */
	next(line: string): SseEvent | null {
		if (line === "") {
			if (this.#hasData) {
				const event = { name: this.#name, data: this.#data.join("\n") };
				this.#name = "message";
				this.#data = [];
				this.#hasData = false;
				return event;
			}
			this.#name = "message";
			return null;
		}
		if (line.startsWith("event:")) {
			this.#name = sseValue(line, 6);
		} else if (line.startsWith("data:")) {
			this.#data.push(sseValue(line, 5));
			this.#hasData = true;
		}
		return null;
	}

	/** EOF 收尾：残留 data 成帧。 */
	finish(): SseEvent | null {
		if (!this.#hasData) {
			return null;
		}
		const event = { name: this.#name, data: this.#data.join("\n") };
		this.#data = [];
		this.#hasData = false;
		return event;
	}
}

function sseValue(line: string, start: number): string {
	return line.slice(start < line.length && line[start] === " " ? start + 1 : start);
}

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "function_call", "content_filter"]);

/**
 * Chat Completions 终止证据追踪：独立于传输 EOF 判断流是否完整
 * （有 finish_reason 或实际产出，且 [DONE] 或全部 choice 终止）。
 */
export class OpenAiStreamCompletion {
	readonly #choices = new Set<number>();
	readonly #finishedChoices = new Set<number>();
	#done = false;
	#responseEvidence = false;

	done(): void {
		this.#done = true;
	}

	observe(event: unknown): void {
		if (event === null || typeof event !== "object" || Array.isArray(event)) {
			throw new IncompleteUpstreamStreamException();
		}
		const record = event as Record<string, unknown>;
		if (record.error !== null && record.error !== undefined) {
			throw new UpstreamStreamError("上游返回流式错误");
		}
		const choices = record.choices;
		if (!Array.isArray(choices)) {
			return;
		}
		for (const choice of choices) {
			if (choice === null || typeof choice !== "object") {
				continue;
			}
			const item = choice as Record<string, unknown>;
			const index = typeof item.index === "number" ? item.index : 0;
			this.#choices.add(index);
			if (typeof item.finish_reason === "string" && FINISH_REASONS.has(item.finish_reason)) {
				this.#finishedChoices.add(index);
				this.#responseEvidence = true;
			}
			const delta = item.delta;
			if (delta === null || typeof delta !== "object") {
				continue;
			}
			const d = delta as Record<string, unknown>;
			if (
				nonemptyText(d.content) ||
				nonemptyText(d.reasoning_content) ||
				nonemptyText(d.refusal) ||
				(Array.isArray(d.tool_calls) && d.tool_calls.length > 0) ||
				(d.function_call !== null && typeof d.function_call === "object")
			) {
				this.#responseEvidence = true;
			}
		}
	}

	requireComplete(): void {
		if (!this.isComplete()) {
			throw new IncompleteUpstreamStreamException();
		}
	}

	isComplete(): boolean {
		return (
			this.#responseEvidence &&
			(this.#done ||
				(this.#choices.size > 0 && [...this.#choices].every((index) => this.#finishedChoices.has(index))))
		);
	}
}

/** 流内错误（上游 error 事件）：按 SERVER 分类参与冷却换号。 */
export class UpstreamStreamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UpstreamStreamError";
	}
}

export interface ToolCallSlot {
	id: string;
	type: string;
	function: { name?: string; arguments?: string };
}

/**
 * OpenAI tool_calls 增量合并：按 index 聚合 id/name/arguments。
 */
export class UpstreamToolCallAggregator {
	readonly #slots = new Map<number, ToolCallSlot>();

	merge(raw: unknown): void {
		if (raw === null || typeof raw !== "object") {
			return;
		}
		const tc = raw as Record<string, unknown>;
		const index = typeof tc.index === "number" ? tc.index : this.#slots.size;
		const slot = this.#slot(index);
		if (typeof tc.id === "string" && tc.id.length > 0) {
			slot.id = tc.id;
		}
		if (typeof tc.type === "string") {
			slot.type = tc.type;
		}
		const fnNode = (tc.function ?? tc) as Record<string, unknown>;
		if (typeof fnNode.name === "string" && fnNode.name.length > 0) {
			slot.function.name = fnNode.name;
		}
		if (typeof fnNode.arguments === "string") {
			slot.function.arguments = (slot.function.arguments ?? "") + fnNode.arguments;
		}
	}

	/** 按 index 升序展平为完整 tool_calls。 */
	flatten(): Array<Record<string, unknown>> {
		return [...this.#slots.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, slot]) => {
				const args = slot.function.arguments ?? "";
				return {
					id: slot.id,
					type: "function",
					function: { name: slot.function.name ?? "", arguments: args.trim().length === 0 ? "{}" : args },
				};
			});
	}

	#slot(index: number): ToolCallSlot {
		const existing = this.#slots.get(index);
		if (existing !== undefined) {
			return existing;
		}
		const slot: ToolCallSlot = {
			id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
			type: "function",
			function: {},
		};
		this.#slots.set(index, slot);
		return slot;
	}
}

function nonemptyText(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}
