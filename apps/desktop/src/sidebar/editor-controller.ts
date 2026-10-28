import type { FsReadResult } from "../bridge/protocol.ts";
import { editorText } from "./editor-copy.ts";
import { editorsTransitionLocked } from "./editor-exit-guard.ts";

export interface EditorRead extends FsReadResult {
	revision: string | null;
	editable: boolean;
	readOnlyReason?: string;
}
export interface EditorDraft {
	cwd: string;
	path: string;
	content: string;
	baseRevision: string | null;
	baseContent: string;
	updatedAt: number;
	draftRevision: string;
	operationId: string;
	editorId?: string;
}
export type EditorSaveResult =
	| { status: "saved"; path: string; size: number; revision: string; warnings?: string[] }
	| { status: "conflict"; reason: string; current?: EditorRead };
export type DraftSlot = { draft: EditorDraft | null; draftRevision: string | null };
export type DraftMutation =
	| { status: "saved"; draft: EditorDraft; draftRevision: string }
	| { status: "removed"; draft: null; draftRevision: string }
	| { status: "conflict"; reason: string; draft: EditorDraft | null; draftRevision: string | null };
export interface EditorFileApi {
	fsRead(cwd: string, path: string): Promise<FsReadResult>;
	editorFileSave(
		cwd: string,
		path: string,
		content: string,
		expectedRevision: string | null,
		expectedProfile: string,
	): Promise<EditorSaveResult>;
	editorDraftGet(cwd: string, path: string, expectedProfile: string): Promise<DraftSlot>;
	editorDraftPut(
		cwd: string,
		path: string,
		value: {
			content: string;
			baseRevision: string | null;
			baseContent: string;
			expectedDraftRevision: string | null;
			operationId: string;
			editorId?: string;
		},
		expectedProfile: string,
	): Promise<DraftMutation>;
	editorDraftRemove(
		cwd: string,
		path: string,
		expectedDraftRevision: string,
		expectedProfile: string,
	): Promise<DraftMutation>;
}
interface LocalDraft {
	content: string;
	baseContent: string;
	baseRevision: string | null;
	localRevision: number;
	updatedAt: number;
	editorId?: string;
	token?: string;
	walKey?: string;
}
export interface EditorSnapshot {
	text: string;
	version: number;
	dirty: boolean;
	loading: boolean;
	ready: boolean;
	editable: boolean;
	saving: boolean;
	disk?: EditorRead;
	baseRevision?: string | null;
	baseContent: string;
	stale: boolean;
	error?: string;
	conflict?: EditorRead;
	draftStatus: "checking" | "none" | "pending" | "saved" | "error" | "conflict";
	draftError?: string;
	recovery?: EditorDraft;
	localRecovery?: LocalDraft;
	localRecoveries?: LocalDraft[];
	walStatus: "none" | "saved" | "error";
	walError?: string;
	savedAt?: number;
	copyPath?: string;
	warnings?: string[];
	serverSavedVersion?: number;
}
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> & Partial<Pick<Storage, "length" | "key">>;
export function editorWalKey(profile: string, cwd: string, path: string): string {
	return `owl.editor.wal.${JSON.stringify([profile, cwd, path])}`;
}

/** Disk and draft acknowledgements belong to immutable content snapshots, never to the current editor by accident. */
export class EditorController {
	private state: EditorSnapshot = {
		text: "",
		version: 0,
		dirty: false,
		loading: true,
		ready: false,
		editable: false,
		saving: false,
		baseContent: "",
		stale: false,
		draftStatus: "checking",
		walStatus: "none",
	};
	private readonly listeners = new Set<() => void>();
	private active = true;
	private readSequence = 0;
	private saving = false;
	private draftFlight?: Promise<boolean>;
	private slot: DraftSlot = { draft: null, draftRevision: null };
	private slotKnown = false;
	private serverVersion = -1;
	private walVersion = -1;
	private walToken?: string;
	private copyVersion = -1;
	private failedPut?: { version: number; operationId: string; expectedDraftRevision: string | null };
	private readonly api: EditorFileApi;
	readonly cwd: string;
	readonly path: string;
	readonly profile: string;
	private readonly storage?: StorageLike;
	private readonly editorId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
	constructor(api: EditorFileApi, cwd: string, path: string, profile: string, storage?: StorageLike) {
		this.api = api;
		this.cwd = cwd;
		this.path = path;
		this.profile = profile;
		this.storage = storage;
		if (profile && storage) {
			try {
				const base = editorWalKey(profile, cwd, path);
				const keys = [base];
				if (storage.key && typeof storage.length === "number")
					for (let index = 0; index < storage.length; index++) {
						const key = storage.key(index);
						if (key?.startsWith(`${base}.`)) keys.push(key);
					}
				const candidates: LocalDraft[] = [];
				for (const key of keys) {
					try {
						const raw = storage.getItem(key);
						if (raw) {
							const draft: unknown = JSON.parse(raw);
							if (
								draft &&
								typeof draft === "object" &&
								"content" in draft &&
								typeof draft.content === "string" &&
								"baseContent" in draft &&
								typeof draft.baseContent === "string" &&
								"baseRevision" in draft &&
								(typeof draft.baseRevision === "string" || draft.baseRevision === null)
							)
								candidates.push({ ...(draft as LocalDraft), walKey: key });
						}
					} catch (error) {
						this.state.walStatus = "error";
						this.state.walError = error instanceof Error ? error.message : String(error);
					}
				}
				candidates.sort((a, b) => b.updatedAt - a.updatedAt);
				this.state.localRecoveries = candidates;
				this.state.localRecovery = candidates[0];
			} catch (error) {
				this.state.walStatus = "error";
				this.state.walError = error instanceof Error ? error.message : String(error);
			}
		}
	}
	getSnapshot = (): EditorSnapshot => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private patch(next: Partial<EditorSnapshot>): void {
		if (!this.active) return;
		this.state = { ...this.state, ...next };
		for (const notify of this.listeners) notify();
	}
	activate(): void {
		this.active = true;
	}
	dispose(): void {
		this.active = false;
		++this.readSequence;
	}
	revision = (): number => this.state.version;
	isDirty = (): boolean => this.state.dirty;
	isProtected = (): boolean => {
		if (!this.state.dirty || this.serverVersion === this.state.version) return true;
		if (this.walVersion !== this.state.version || !this.walToken || !this.storage) return false;
		try {
			const raw = this.storage.getItem(`${editorWalKey(this.profile, this.cwd, this.path)}.${this.editorId}`);
			if (!raw) return false;
			const draft = JSON.parse(raw) as LocalDraft;
			return draft.editorId === this.editorId && draft.token === this.walToken && draft.content === this.state.text;
		} catch {
			return false;
		}
	};
	private readResult(result: FsReadResult): EditorRead {
		const value = result as Partial<EditorRead>;
		return {
			...result,
			revision: value.revision ?? null,
			editable:
				value.editable === true &&
				result.kind === "text" &&
				!result.truncated &&
				typeof value.revision === "string",
			readOnlyReason: value.readOnlyReason,
		};
	}
	private localBackup(): void {
		if (!this.profile || !this.storage || this.state.baseRevision === undefined) {
			this.patch({ walStatus: "error", walError: editorText("walUnavailable") });
			return;
		}
		try {
			const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
			this.storage.setItem(
				`${editorWalKey(this.profile, this.cwd, this.path)}.${this.editorId}`,
				JSON.stringify({
					content: this.state.text,
					baseContent: this.state.baseContent,
					baseRevision: this.state.baseRevision,
					localRevision: this.state.version,
					updatedAt: Date.now(),
					editorId: this.editorId,
					token,
				} satisfies LocalDraft),
			);
			this.walToken = token;
			this.walVersion = this.state.version;
			this.patch({ walStatus: "saved", walError: undefined });
		} catch (error) {
			this.patch({ walStatus: "error", walError: error instanceof Error ? error.message : String(error) });
		}
	}
	private clearLocal(version: number): void {
		if (this.state.version !== version || !this.storage) return;
		try {
			const key = `${editorWalKey(this.profile, this.cwd, this.path)}.${this.editorId}`;
			const raw = this.storage.getItem(key);
			const draft = raw ? (JSON.parse(raw) as LocalDraft) : undefined;
			if (draft?.editorId === this.editorId && draft.token === this.walToken && draft.localRevision === version)
				this.storage.removeItem(key);
			this.walVersion = -1;
			this.walToken = undefined;
			this.patch({ walStatus: "none" });
		} catch (error) {
			this.patch({ walStatus: "error", walError: error instanceof Error ? error.message : String(error) });
		}
	}
	async load(): Promise<void> {
		if (this.state.dirty) {
			await this.reload();
			return;
		}
		const sequence = ++this.readSequence;
		this.patch({ loading: true, error: undefined });
		const [read, draft] = await Promise.allSettled([
			this.api.fsRead(this.cwd, this.path),
			this.profile
				? this.api.editorDraftGet(this.cwd, this.path, this.profile)
				: Promise.reject(new Error(editorText("profilePending"))),
		]);
		if (!this.active || sequence !== this.readSequence) return;
		if (read.status === "fulfilled") {
			const disk = this.readResult(read.value);
			this.patch({
				disk,
				text: disk.content,
				baseContent: disk.content,
				baseRevision: disk.revision,
				ready: true,
				editable: disk.editable && Boolean(this.profile),
				loading: false,
				dirty: false,
			});
		} else
			this.patch({
				loading: false,
				error: read.reason instanceof Error ? read.reason.message : String(read.reason),
			});
		if (draft.status === "fulfilled") {
			this.slot = draft.value;
			this.slotKnown = true;
			this.patch({ recovery: draft.value.draft ?? undefined, draftStatus: draft.value.draft ? "saved" : "none" });
		} else
			this.patch({
				draftStatus: "error",
				draftError: draft.reason instanceof Error ? draft.reason.message : String(draft.reason),
			});
	}
	change(text: string): void {
		if (editorsTransitionLocked() || !this.active || !this.state.ready || !this.state.editable || this.state.loading)
			return;
		this.patch({ text, version: this.state.version + 1, dirty: true, savedAt: undefined });
		this.localBackup();
	}
	markStale(): void {
		this.patch({ stale: true });
	}
	async reload(): Promise<boolean> {
		if (editorsTransitionLocked() || this.state.loading || this.state.saving) return false;
		const version = this.state.version;
		const sequence = ++this.readSequence;
		this.patch({ loading: true, error: undefined });
		try {
			const disk = this.readResult(await this.api.fsRead(this.cwd, this.path));
			if (!this.active || editorsTransitionLocked() || sequence !== this.readSequence) return false;
			if (this.state.dirty && disk.revision === this.state.baseRevision && disk.editable) {
				this.patch({
					disk,
					editable: Boolean(this.profile) && disk.editable,
					stale: false,
					conflict: undefined,
					error: undefined,
				});
				return true;
			}
			if (this.state.dirty || this.state.version !== version) {
				this.patch({ conflict: disk, stale: true, error: editorText("reloadKept") });
				return false;
			}
			this.patch({
				text: disk.content,
				disk,
				baseContent: disk.content,
				baseRevision: disk.revision,
				ready: true,
				editable: disk.editable && Boolean(this.profile),
				stale: false,
				conflict: undefined,
				version: version + 1,
			});
			return true;
		} catch (error) {
			this.patch({ error: error instanceof Error ? error.message : String(error) });
			return false;
		} finally {
			if (sequence === this.readSequence) this.patch({ loading: false });
		}
	}
	restore(source: "server" | "local", walKey?: string): boolean {
		const draft =
			source === "server"
				? this.state.recovery
				: walKey
					? this.state.localRecoveries?.find((item) => item.walKey === walKey)
					: this.state.localRecovery;
		if (editorsTransitionLocked() || !draft || !this.profile || this.state.saving || this.state.loading) return false;
		if (this.state.dirty && this.copyVersion !== this.state.version) {
			this.patch({ error: editorText("restoreDirty") });
			return false;
		}
		const disk = this.state.disk;
		const conflict = !disk || disk.revision !== draft.baseRevision;
		this.patch({
			text: draft.content,
			baseContent: draft.baseContent,
			baseRevision: draft.baseRevision,
			ready: true,
			editable: disk?.editable === true,
			dirty: true,
			version: this.state.version + 1,
			recovery: undefined,
			localRecovery: undefined,
			conflict: conflict ? disk : undefined,
			stale: conflict,
			error: conflict ? editorText("draftBaseConflict") : undefined,
		});
		this.localBackup();
		return true;
	}
	async preserveDraft(): Promise<boolean> {
		const requested = this.state.version;
		if (!this.state.dirty) return true;
		if (this.draftFlight) {
			await this.draftFlight;
			return this.active && this.state.version === requested && this.serverVersion === requested;
		}
		if (
			!this.profile ||
			this.state.baseRevision === undefined ||
			!this.slotKnown ||
			this.state.recovery ||
			this.state.draftStatus === "conflict"
		) {
			this.patch({ draftStatus: "error", draftError: editorText("draftNeedsReview") });
			return false;
		}
		const snapshot = {
			text: this.state.text,
			baseContent: this.state.baseContent,
			baseRevision: this.state.baseRevision,
			version: requested,
		};
		const operationId =
			this.failedPut?.version === requested
				? this.failedPut.operationId
				: (globalThis.crypto?.randomUUID?.() ?? `${this.editorId}-${requested}-${Date.now()}`);
		const expectedDraftRevision =
			this.failedPut?.version === requested ? this.failedPut.expectedDraftRevision : this.slot.draftRevision;
		this.patch({ draftStatus: "pending", draftError: undefined });
		const flight = (async (): Promise<boolean> => {
			try {
				const result = await this.api.editorDraftPut(
					this.cwd,
					this.path,
					{
						content: snapshot.text,
						baseContent: snapshot.baseContent,
						baseRevision: snapshot.baseRevision,
						expectedDraftRevision,
						operationId,
						editorId: this.editorId,
					},
					this.profile,
				);
				if (!this.active) return false;
				this.slot = { draft: result.draft, draftRevision: result.draftRevision };
				if (result.status !== "saved") {
					this.patch({
						draftStatus: "conflict",
						recovery: result.draft ?? undefined,
						draftError: result.status === "conflict" ? result.reason : editorText("draftNeedsReview"),
					});
					return false;
				}
				this.failedPut = undefined;
				this.serverVersion = snapshot.version;
				this.patch({ draftStatus: "saved", draftError: undefined, serverSavedVersion: snapshot.version });
				return this.state.version === snapshot.version;
			} catch (error) {
				this.failedPut = { version: requested, operationId, expectedDraftRevision };
				this.patch({ draftStatus: "error", draftError: error instanceof Error ? error.message : String(error) });
				return false;
			}
		})();
		this.draftFlight = flight;
		try {
			return await flight;
		} finally {
			if (this.draftFlight === flight) this.draftFlight = undefined;
			if (this.active && this.state.dirty && this.state.version !== requested && this.state.draftStatus === "saved")
				void this.preserveDraft();
		}
	}
	async save(): Promise<boolean> {
		if (
			!this.active ||
			this.saving ||
			!this.state.ready ||
			this.state.loading ||
			!this.state.editable ||
			this.state.baseRevision === undefined ||
			this.state.conflict ||
			this.state.stale
		) {
			this.patch({ error: editorText("saveBlocked") });
			return false;
		}
		if (!this.state.dirty) return true;
		const snapshot = { text: this.state.text, version: this.state.version, baseRevision: this.state.baseRevision };
		this.saving = true;
		this.patch({ saving: true, error: undefined, warnings: undefined });
		try {
			const result = await this.api.editorFileSave(
				this.cwd,
				this.path,
				snapshot.text,
				snapshot.baseRevision,
				this.profile,
			);
			if (!this.active) return false;
			if (result.status === "conflict") {
				this.patch({ conflict: result.current, stale: true, error: result.reason });
				return false;
			}
			this.patch({
				baseContent: snapshot.text,
				baseRevision: result.revision,
				disk: { ...this.state.disk!, content: snapshot.text, revision: result.revision, size: result.size },
				dirty: this.state.version !== snapshot.version,
				savedAt: Date.now(),
				stale: false,
				warnings: result.warnings,
			});
			// Newer input now derives from the successfully saved bytes. Preserve that
			// baseline in the WAL immediately, then serialize it after any older PUT.
			if (this.state.version !== snapshot.version) this.localBackup();
			if (this.draftFlight) await this.draftFlight;
			if (!this.active) return false;
			if (this.state.version !== snapshot.version) {
				this.serverVersion = -1;
				this.failedPut = undefined;
				this.patch({ serverSavedVersion: undefined });
				await this.preserveDraft();
				return false;
			}
			if (
				this.state.version === snapshot.version &&
				this.slot.draft?.content === snapshot.text &&
				this.serverVersion === snapshot.version
			) {
				const removed = await this.api.editorDraftRemove(
					this.cwd,
					this.path,
					this.slot.draftRevision!,
					this.profile,
				);
				if (!this.active) return false;
				this.slot = { draft: removed.draft, draftRevision: removed.draftRevision };
				if (removed.status === "conflict")
					this.patch({
						draftStatus: "conflict",
						recovery: removed.draft ?? undefined,
						draftError: removed.reason,
					});
				else if (this.state.version === snapshot.version) this.patch({ draftStatus: "none" });
			}
			if (this.state.version === snapshot.version) this.clearLocal(snapshot.version);
			return this.state.version === snapshot.version && !this.state.dirty;
		} catch (error) {
			this.patch({ error: error instanceof Error ? error.message : String(error) });
			return false;
		} finally {
			this.saving = false;
			this.patch({ saving: false });
		}
	}
	async discard(): Promise<boolean> {
		const version = this.state.version;
		if (this.saving) return false;
		if (this.draftFlight) await this.draftFlight;
		if (!this.active || this.state.version !== version) return false;
		try {
			if (this.slot.draft?.editorId === this.editorId && this.slot.draftRevision) {
				const result = await this.api.editorDraftRemove(this.cwd, this.path, this.slot.draftRevision, this.profile);
				if (!this.active || this.state.version !== version) return false;
				if (result.status === "conflict") {
					this.patch({ draftStatus: "conflict", recovery: result.draft ?? undefined, draftError: result.reason });
					return false;
				}
				this.slot = { draft: result.draft, draftRevision: result.draftRevision };
			}
			this.clearLocal(version);
			this.patch({
				text: this.state.baseContent,
				dirty: false,
				version: version + 1,
				recovery: this.slot.draft ?? undefined,
				localRecovery: undefined,
				draftStatus: this.slot.draft ? "saved" : "none",
				draftError: undefined,
			});
			return true;
		} catch (error) {
			this.patch({ draftStatus: "error", draftError: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}
	removeLocalRecovery(walKey: string): boolean {
		if (editorsTransitionLocked()) return false;
		const candidate = this.state.localRecoveries?.find((draft) => draft.walKey === walKey);
		if (!this.storage || !candidate || !walKey.startsWith(`${editorWalKey(this.profile, this.cwd, this.path)}.`))
			return false;
		try {
			const raw = this.storage.getItem(walKey);
			const current = raw ? (JSON.parse(raw) as LocalDraft) : undefined;
			if (
				!current ||
				!candidate.token ||
				current.token !== candidate.token ||
				current.editorId !== candidate.editorId ||
				current.content !== candidate.content ||
				current.localRevision !== candidate.localRevision
			) {
				this.patch({ walError: editorText("recoveryChanged") });
				return false;
			}
			this.storage.removeItem(walKey);
			const remaining = this.state.localRecoveries?.filter((draft) => draft.walKey !== walKey) ?? [];
			this.patch({ localRecoveries: remaining, localRecovery: remaining[0], walError: undefined });
			return true;
		} catch (error) {
			this.patch({ walError: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}
	async useDiskAfterPreserve(): Promise<boolean> {
		if (editorsTransitionLocked()) return false;
		const version = this.state.version;
		if (this.state.dirty && !(await this.preserveDraft())) return false;
		if (
			!this.active ||
			editorsTransitionLocked() ||
			this.state.version !== version ||
			this.state.loading ||
			this.saving
		)
			return false;
		this.patch({ loading: true });
		try {
			const disk = this.readResult(await this.api.fsRead(this.cwd, this.path));
			if (!this.active || editorsTransitionLocked() || this.state.version !== version) return false;
			this.patch({
				text: disk.content,
				disk,
				baseContent: disk.content,
				baseRevision: disk.revision,
				editable: disk.editable,
				dirty: false,
				version: version + 1,
				stale: false,
				conflict: undefined,
				error: undefined,
				recovery: this.slot.draft ?? undefined,
			});
			return true;
		} catch (error) {
			this.patch({ error: error instanceof Error ? error.message : String(error) });
			return false;
		} finally {
			this.patch({ loading: false });
		}
	}
	async saveAs(path: string): Promise<boolean> {
		if (
			editorsTransitionLocked() ||
			!this.profile ||
			!this.state.ready ||
			this.state.loading ||
			this.saving ||
			this.state.disk?.kind === "binary"
		)
			return false;
		if (!path.trim() || path.replace(/\\/g, "/") === this.path.replace(/\\/g, "/")) {
			this.patch({ error: editorText("newPath") });
			return false;
		}
		const version = this.state.version;
		const text = this.state.text;
		this.saving = true;
		this.patch({ saving: true, error: undefined });
		try {
			const result = await this.api.editorFileSave(this.cwd, path, text, null, this.profile);
			if (!this.active) return false;
			if (result.status !== "saved") {
				this.patch({ error: result.reason });
				return false;
			}
			this.copyVersion = version;
			this.patch({ copyPath: path, warnings: result.warnings });
			return this.state.version === version;
		} catch (error) {
			this.patch({ error: error instanceof Error ? error.message : String(error) });
			return false;
		} finally {
			this.saving = false;
			this.patch({ saving: false });
		}
	}
}
