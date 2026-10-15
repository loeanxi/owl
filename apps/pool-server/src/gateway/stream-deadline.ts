/**
 * 上游请求期限：流式请求按「连续无数据」判空闲，另设总时长上限；
 * 显式 timeoutMs 仍是绝对期限。持续输出的长推理不会被固定时长截断。
 */
import { GatewayFault } from "owl-pool";

export interface UpstreamDeadlineConfig {
	/** 显式绝对期限；设置后优先于总时长上限。 */
	timeoutMs?: number;
	streamIdleTimeoutMs?: number;
	streamMaxDurationMs?: number;
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_STREAM_MAX_DURATION_MS = 1_800_000;

export class UpstreamDeadline {
	readonly signal: AbortSignal;
	readonly #controller = new AbortController();
	readonly #label: string;
	readonly #idleMs: number | null;
	readonly #caller: AbortSignal | undefined;
	readonly #aborted: Promise<never>;
	#idleTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #totalTimer: ReturnType<typeof setTimeout>;

	/** 非流式响应体一次性到达，只受总期限约束。 */
	constructor(label: string, config: UpstreamDeadlineConfig, options: { caller?: AbortSignal; streaming: boolean }) {
		this.signal = this.#controller.signal;
		this.#label = label;
		this.#caller = options.caller;
		this.#idleMs = options.streaming ? (config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS) : null;
		const explicit = config.timeoutMs !== undefined;
		const totalMs = config.timeoutMs ?? config.streamMaxDurationMs ?? DEFAULT_STREAM_MAX_DURATION_MS;
		this.#aborted = new Promise<never>((_resolve, reject) => {
			this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true });
		});
		this.#aborted.catch(() => {});
		this.#caller?.addEventListener("abort", this.#onCallerAbort, { once: true });
		if (this.#caller?.aborted) this.#onCallerAbort();
		this.#totalTimer = setTimeout(
			() =>
				this.#abort(
					new GatewayFault(
						504,
						"upstream_timeout",
						`${label} ${explicit ? "显式绝对期限" : "流总时长上限"} ${totalMs}ms 已到，已中止等待`,
					),
				),
			totalMs,
		);
		this.touch();
	}

	/** 收到上游数据：重新计算空闲期限。 */
	touch(): void {
		if (this.#idleMs === null || this.signal.aborted) return;
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		const idleMs = this.#idleMs;
		this.#idleTimer = setTimeout(
			() =>
				this.#abort(
					new GatewayFault(
						504,
						"upstream_stream_idle_timeout",
						`${this.#label} 流连续 ${idleMs}ms 未收到数据，已中止等待`,
					),
				),
			idleMs,
		);
	}

	/** 不理会 AbortSignal 的传输也不能让等待越过期限。 */
	race<T>(pending: Promise<T>): Promise<T> {
		return Promise.race([pending, this.#aborted]);
	}

	/** 包装响应体：每个分块刷新空闲期限，期限到或取消时以对应原因中止读取。 */
	watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
		const reader = body.getReader();
		const cancelSource = () => void reader.cancel(this.signal.reason).catch(() => {});
		this.signal.addEventListener("abort", cancelSource, { once: true });
		return new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				const chunk = await this.race(reader.read());
				if (chunk.done) {
					this.signal.removeEventListener("abort", cancelSource);
					controller.close();
					return;
				}
				this.touch();
				controller.enqueue(chunk.value);
			},
			cancel: async (reason) => {
				this.signal.removeEventListener("abort", cancelSource);
				await reader.cancel(reason);
			},
		});
	}

	/** 已中止时抛出原因：调用方取消原样上抛，期限到抛对应 GatewayFault。 */
	throwIfAborted(): void {
		this.signal.throwIfAborted();
	}

	dispose(): void {
		clearTimeout(this.#totalTimer);
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		this.#caller?.removeEventListener("abort", this.#onCallerAbort);
	}

	#onCallerAbort = (): void => {
		this.#abort(this.#caller?.reason);
	};

	#abort(reason: unknown): void {
		if (this.signal.aborted) return;
		this.#controller.abort(reason);
		this.dispose();
	}
}
