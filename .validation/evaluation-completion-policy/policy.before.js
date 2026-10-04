/** Content progress, rather than transport events, keeps an evaluation connection alive. */
export const EVALUATION_IDLE_TIMEOUT_MS = 120_000;
export class EvaluationIdleWatchdog {
    idleTimeoutMs;
    onIdle;
    timer;
    bodyLength = 0;
    thinkingLength = 0;
    stopped = false;
    constructor(idleTimeoutMs, onIdle) {
        this.idleTimeoutMs = idleTimeoutMs;
        this.onIdle = onIdle;
        this.arm();
    }
    observe(body, thinking) {
        if (this.stopped)
            return;
        const bodyLength = body.trimEnd().length;
        const thinkingLength = thinking.trimEnd().length;
        if (bodyLength <= this.bodyLength && thinkingLength <= this.thinkingLength)
            return;
        this.bodyLength = Math.max(this.bodyLength, bodyLength);
        this.thinkingLength = Math.max(this.thinkingLength, thinkingLength);
        this.arm();
    }
    stop() {
        this.stopped = true;
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    arm() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.stopped = true;
            this.onIdle(this.bodyLength > 0 || this.thinkingLength > 0);
        }, this.idleTimeoutMs);
    }
}
//# sourceMappingURL=policy.js.map