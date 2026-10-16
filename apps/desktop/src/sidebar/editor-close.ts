export interface EditorGuard {
	isDirty(): boolean;
	revision(): number;
	isProtected?(): boolean;
	save(): Promise<boolean>;
	preserveDraft(): Promise<boolean>;
	discard(): Promise<boolean>;
}
export type EditorCloseChoice = "save" | "preserve" | "discard" | "cancel";
export interface EditorCloseRequest { id: number; paths: string[]; reason: "close" | "leave"; pending: boolean; error?: string }
interface EditorTabIdentity { id: string; path?: string; title: string }

/** Owns one confirmation at a time; no caller may drop a buffer on a failed acknowledgement. */
export class EditorCloseCoordinator {
	private editors = new Map<string, EditorGuard>();
	private listeners = new Set<() => void>();
	private request?: EditorCloseRequest;
	private pending?: { ids: () => string[]; resolve: (allowed: boolean) => void };
	private sequence = 0;
	private queue = Promise.resolve();
	private getTabs: () => readonly EditorTabIdentity[];
	private markedDirty: (id: string) => boolean;

	constructor(getTabs: () => readonly EditorTabIdentity[], markedDirty: (id: string) => boolean) {
		this.getTabs = getTabs;
		this.markedDirty = markedDirty;
	}
	register(id: string, guard: EditorGuard): () => void {
		this.editors.set(id, guard);
		return () => { if (this.editors.get(id) === guard) this.editors.delete(id); };
	}
	isDirty(id: string): boolean { return this.editors.get(id)?.isDirty() ?? this.markedDirty(id); }
	hasUnprotectedEdits(): boolean {
		return this.getTabs().some((tab) => this.isDirty(tab.id) && this.editors.get(tab.id)?.isProtected?.() !== true);
	}
	getSnapshot = (): EditorCloseRequest | undefined => this.request;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
	private publish(request: EditorCloseRequest | undefined): void { this.request = request; for (const listener of this.listeners) listener(); }

	protect(ids: () => string[], reason: "close" | "leave", preserveFirst = false): Promise<boolean> {
		const operation = this.queue.then(async () => {
			if (!ids().some((id) => this.isDirty(id))) return true;
			let error: string | undefined;
			if (preserveFirst) {
				const result = await this.apply(ids, "preserve");
				if (result === undefined) return true;
				error = result;
			}
			return new Promise<boolean>((resolve) => {
				this.pending = { ids, resolve };
				this.publish({ id: ++this.sequence, paths: this.getTabs().filter((tab) => ids().includes(tab.id) && this.isDirty(tab.id)).map((tab) => tab.path ?? tab.title), reason, pending: false, error });
			});
		});
		this.queue = operation.then(() => {}, () => {});
		return operation;
	}
	async choose(choice: EditorCloseChoice): Promise<void> {
		const pending = this.pending;
		const request = this.request;
		if (!pending || !request || request.pending) return;
		if (choice === "cancel") { this.pending = undefined; this.publish(undefined); pending.resolve(false); return; }
		this.publish({ ...request, pending: true, error: undefined });
		const error = await this.apply(pending.ids, choice);
		if (this.pending !== pending) return;
		if (error !== undefined) { this.publish({ ...request, pending: false, error }); return; }
		this.pending = undefined;
		this.publish(undefined);
		pending.resolve(true);
	}
	cancel(): void { if (!this.request?.pending) void this.choose("cancel"); }

	private async apply(ids: () => string[], choice: Exclude<EditorCloseChoice, "cancel">): Promise<string | undefined> {
		const handled = new Map<string, { guard: EditorGuard; revision: number }>();
		try {
			for (const id of ids()) {
				if (!this.isDirty(id)) continue;
				const guard = this.editors.get(id);
				if (!guard) return "editor-unavailable";
				const allowed = await (choice === "preserve" ? guard.preserveDraft() : choice === "save" ? guard.save() : guard.discard());
				if (!allowed) return "editor-not-ready";
				handled.set(id, { guard, revision: guard.revision() });
			}
			// Another buffer may change or open while an earlier file is being persisted.
			for (const id of ids()) {
				const handledEditor = handled.get(id);
				if (handledEditor && (this.editors.get(id) !== handledEditor.guard || handledEditor.guard.revision() !== handledEditor.revision)) return "editor-changed";
				if (!handledEditor && this.isDirty(id)) return "editor-changed";
			}
			return undefined;
		} catch (error) { return error instanceof Error ? error.message : String(error); }
	}
}
