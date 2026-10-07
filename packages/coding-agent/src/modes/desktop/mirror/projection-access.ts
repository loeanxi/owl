import type { MirrorInputRequest, MirrorProjectionGeometry } from "../protocol.ts";

interface ProjectionTarget {
	projectWindow(windowId: string, visible?: boolean): Promise<MirrorProjectionGeometry>;
	inputWindow(request: MirrorInputRequest): void;
	unembedWindow(windowId: string): Promise<void>;
}

interface ProjectionClaim {
	owner: object;
	active: boolean;
	revision: number;
}

/** Per-connection ownership also fences late native work after a WebSocket closes. */
export class MirrorProjectionAccess {
	private readonly target: ProjectionTarget;
	private readonly claims = new Map<string, ProjectionClaim>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly closed = new WeakSet<object>();

	constructor(target: ProjectionTarget) {
		this.target = target;
	}

	hasClaim(windowId: string): boolean {
		return this.claims.has(String(Number(windowId)));
	}

	assertOwnerOrUnclaimed(owner: object, windowId: string): void {
		const claim = this.claims.get(String(Number(windowId)));
		if (claim && claim.owner !== owner) throw new Error("mirror projection belongs to another connection");
	}

	async project(owner: object, windowId: string, visible = true): Promise<MirrorProjectionGeometry> {
		if (this.closed.has(owner)) throw new Error("mirror connection is closed");
		if (!Number.isSafeInteger(Number(windowId)) || Number(windowId) <= 0 || String(Number(windowId)) !== windowId)
			throw new Error("invalid windowId");
		this.assertOwnerOrUnclaimed(owner, windowId);
		let claim = this.claims.get(windowId);
		if (!claim) {
			if (!visible) throw new Error("mirror projection is not owned by this connection");
			claim = { owner, active: false, revision: 0 };
			this.claims.set(windowId, claim);
		}
		const current = claim;
		const revision = ++current.revision;
		current.active = false;
		return this.enqueue(windowId, async () => {
			if (this.closed.has(owner)) throw new Error("mirror connection is closed");
			const geometry = await this.target.projectWindow(windowId, visible);
			if (this.closed.has(owner)) throw new Error("mirror connection closed during projection");
			if (this.claims.get(windowId) === current && current.revision === revision) current.active = visible;
			return geometry;
		});
	}

	input(owner: object, request: MirrorInputRequest, subscribed: boolean): void {
		const claim = this.claims.get(request.windowId);
		if (this.closed.has(owner) || !claim || claim.owner !== owner) {
			throw new Error("mirror input requires this connection's projection");
		}
		// Release remains possible after a tab detached or its geometry became stale.
		if (request.action !== "cancel" && (!claim.active || !subscribed)) {
			throw new Error("mirror input requires an active projection subscription");
		}
		this.target.inputWindow(request);
	}

	unembed(owner: object, windowId: string): Promise<void> {
		const claim = this.claims.get(windowId);
		if (!claim || claim.owner !== owner)
			return Promise.reject(new Error("mirror projection is not owned by this connection"));
		claim.active = false;
		const revision = ++claim.revision;
		return this.enqueue(windowId, async () => {
			await this.target.unembedWindow(windowId);
			if (this.claims.get(windowId) === claim && claim.revision === revision) this.claims.delete(windowId);
		});
	}

	async disconnect(owner: object): Promise<void> {
		this.closed.add(owner);
		await Promise.all(
			[...this.claims]
				.filter(([, claim]) => claim.owner === owner)
				.map(async ([windowId]) => {
					try {
						await this.unembed(owner, windowId);
					} finally {
						// A closed connection cannot retry; the hub retains failed restore metadata.
						if (this.claims.get(windowId)?.owner === owner) this.claims.delete(windowId);
					}
				}),
		);
	}

	private enqueue<T>(windowId: string, operation: () => Promise<T>): Promise<T> {
		const result = (this.pending.get(windowId) ?? Promise.resolve()).then(operation);
		const settled = result.then(
			() => {},
			() => {},
		);
		this.pending.set(windowId, settled);
		void settled.then(() => {
			if (this.pending.get(windowId) === settled) this.pending.delete(windowId);
		});
		return result;
	}
}
