import { editorWalKey } from "./editor-controller.ts";

export interface EditorLocalDraftSummary {
	path: string;
	editorId: string;
	updatedAt: number;
	size: number;
}

/** Enumerate only the current account/project's writer records; never modify a WAL. */
export function listEditorLocalDrafts(
	storage: Pick<Storage, "getItem"> & Partial<Pick<Storage, "key" | "length">>,
	profile: string,
	cwd: string,
): EditorLocalDraftSummary[] {
	if (!profile || typeof storage.key !== "function" || typeof storage.length !== "number") return [];
	const summaries: EditorLocalDraftSummary[] = [];
	for (let index = 0; index < storage.length; index++) {
		const key = storage.key(index);
		if (!key?.startsWith("owl.editor.wal.")) continue;
		const rawKey = key.slice("owl.editor.wal.".length);
		let identity: { path: string; editorId: string } | undefined;
		for (let end = rawKey.indexOf("]"); end !== -1; end = rawKey.indexOf("]", end + 1)) {
			if (rawKey[end + 1] !== ".") continue;
			try {
				const parts: unknown = JSON.parse(rawKey.slice(0, end + 1));
				if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((part) => typeof part === "string"))
					continue;
				const editorId = rawKey.slice(end + 2);
				if (
					parts[0] !== profile ||
					parts[1] !== cwd ||
					!editorId ||
					`${editorWalKey(parts[0], parts[1], parts[2])}.${editorId}` !== key
				)
					continue;
				identity = { path: parts[2], editorId };
				break;
			} catch {
				/* Brackets inside quoted paths are not tuple boundaries. */
			}
		}
		if (!identity) continue;
		const raw = storage.getItem(key);
		if (!raw) continue;
		try {
			const record: unknown = JSON.parse(raw);
			if (!record || typeof record !== "object" || Array.isArray(record)) continue;
			const draft = record as Record<string, unknown>;
			if (
				draft.editorId !== identity.editorId ||
				typeof draft.token !== "string" ||
				!draft.token ||
				typeof draft.content !== "string" ||
				typeof draft.baseContent !== "string" ||
				!(draft.baseRevision === null || typeof draft.baseRevision === "string") ||
				!Number.isInteger(draft.localRevision) ||
				typeof draft.updatedAt !== "number" ||
				!Number.isFinite(draft.updatedAt)
			)
				continue;
			summaries.push({ ...identity, updatedAt: draft.updatedAt, size: draft.content.length });
		} catch {
			/* A malformed writer must not hide other recoverable records. */
		}
	}
	return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}
