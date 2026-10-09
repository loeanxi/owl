import type { BridgeClient } from "./client.ts";

type WatchCapable = Partial<Pick<BridgeClient, "watchSessionEvents">>;

/** 跟踪「当前关心的会话」并向桥声明 delta 订阅；会话切换时自动释放旧 watch。 */
export class SessionWatch {
	private readonly client: WatchCapable;
	private sessionId: string | undefined;
	private release: (() => void) | undefined;

	constructor(client: WatchCapable) {
		this.client = client;
	}

	set(sessionId: string | null | undefined): void {
		const next = sessionId ?? undefined;
		if (next === this.sessionId) return;
		this.release?.();
		this.release = undefined;
		this.sessionId = next;
		if (next && this.client.watchSessionEvents) this.release = this.client.watchSessionEvents(next);
	}

	dispose(): void {
		this.set(undefined);
	}
}
