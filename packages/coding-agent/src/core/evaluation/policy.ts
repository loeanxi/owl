/** Content progress, rather than transport events, keeps an evaluation connection alive. */
export const EVALUATION_IDLE_TIMEOUT_MS = 120_000;

export class EvaluationIdleWatchdog {
	private readonly idleTimeoutMs: number;
	private readonly onIdle: (receivedContent: boolean) => void;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private bodyLength = 0;
	private thinkingLength = 0;
	private stopped = false;

	constructor(idleTimeoutMs: number, onIdle: (receivedContent: boolean) => void) {
		this.idleTimeoutMs = idleTimeoutMs;
		this.onIdle = onIdle;
		this.arm();
	}

	observe(body: string, thinking: string): void {
		if (this.stopped) return;
		const bodyLength = body.trimEnd().length;
		const thinkingLength = thinking.trimEnd().length;
		if (bodyLength <= this.bodyLength && thinkingLength <= this.thinkingLength) return;
		this.bodyLength = Math.max(this.bodyLength, bodyLength);
		this.thinkingLength = Math.max(this.thinkingLength, thinkingLength);
		this.arm();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private arm(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.stopped = true;
			this.onIdle(this.bodyLength > 0 || this.thinkingLength > 0);
		}, this.idleTimeoutMs);
	}
}
