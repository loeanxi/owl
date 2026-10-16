/**
 * Serialize model/thinking mutations by runtime identity. A timed-out UI request
 * still owns its place in the queue until its host operation actually settles.
 */
export class SessionSettingsQueue {
	private readonly tails = new WeakMap<object, Promise<void>>();
	private readonly retired = new WeakSet<object>();

	run<T>(session: object, mutation: () => T | Promise<T>): Promise<T> {
		const previous = this.tails.get(session) ?? Promise.resolve();
		const result = previous.then(() => {
			if (this.retired.has(session)) throw new Error("会话运行时已卸载，设置未执行");
			return mutation();
		});
		// Keep rejection out of the chain: one failed auth/extension must not block later choices.
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(session, settled);
		void settled.then(() => {
			if (this.tails.get(session) === settled) this.tails.delete(session);
		});
		return result;
	}

	isRetired(session: object): boolean {
		return this.retired.has(session);
	}

	/** Pending mutations are rejected; finish the in-flight mutation before disposing its session manager. */
	retire(session: object): Promise<void> {
		this.retired.add(session);
		return this.tails.get(session) ?? Promise.resolve();
	}
}
