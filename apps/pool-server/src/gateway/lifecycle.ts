import { GatewayFault } from "owl-pool";

/** Own in-flight gateway requests so shutdown can persist uncertainty before closing storage. */
export class GatewayLifecycle {
	readonly #active = new Map<string, { abort: AbortController; done: Promise<void> }>();
	#closing = false;

	enter(callLogId: string, caller?: AbortSignal): { signal: AbortSignal; close(): void } {
		if (this.#closing) throw new GatewayFault(503, "gateway_stopping", "网关正在停止，不能接受新请求");
		const abort = new AbortController();
		let finish = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.#active.set(callLogId, { abort, done });
		let closed = false;
		return {
			signal: caller ? AbortSignal.any([caller, abort.signal]) : abort.signal,
			close: () => {
				if (!closed) {
					closed = true;
					this.#active.delete(callLogId);
					finish();
				}
			},
		};
	}

	activeCallIds(): ReadonlySet<string> {
		return new Set(this.#active.keys());
	}

	async drain(timeoutMs = 3000): Promise<boolean> {
		this.#closing = true;
		for (const entry of this.#active.values()) entry.abort.abort(new Error("Gateway shutting down"));
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				Promise.all([...this.#active.values()].map((entry) => entry.done)).then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
