/** Serialize page mutations for one browser owner without blocking other chats. */
export class BrowserOperationQueue {
	private readonly tails = new Map<string, Promise<void>>();

	run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const task = new Promise<T>((resolve, reject) => {
			let cancelled = false;
			const onAbort = (): void => {
				cancelled = true;
				reject(new Error("浏览器操作已取消"));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			void previous.then(() => {
				signal?.removeEventListener("abort", onAbort);
				if (cancelled || signal?.aborted) {
					reject(new Error("浏览器操作已取消"));
					return;
				}
				void operation().then(resolve, reject);
			});
		});
		// An aborted waiter must still retain the preceding operation in the chain.
		const tail = Promise.allSettled([previous, task]).then(() => {});
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return task;
	}
}
