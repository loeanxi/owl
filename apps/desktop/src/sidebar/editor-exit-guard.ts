export interface EditorExitParticipant {
	prepare: () => Promise<boolean>;
	needsWarning: () => boolean;
}
interface EditorBeforeUnloadEvent { preventDefault(): void; returnValue: unknown }
export interface EditorUnloadTarget {
	addEventListener(type: "beforeunload", listener: (event: EditorBeforeUnloadEvent) => void): void;
	removeEventListener(type: "beforeunload", listener: (event: EditorBeforeUnloadEvent) => void): void;
}

const participants = new Set<EditorExitParticipant>();
let preparing: Promise<boolean> | undefined;
let transitionSequence = 0;
let accountTransition: { id: number; targetProfile?: string } | undefined;
const transitionListeners = new Set<() => void>();
const profileKey = (profile: string): string => profile.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function editorsTransitionLocked(): boolean { return accountTransition !== undefined; }
export function subscribeEditorTransition(listener: () => void): () => void { transitionListeners.add(listener); return () => { transitionListeners.delete(listener); }; }
function publishTransition(): void { for (const listener of transitionListeners) listener(); }
/** Freeze new edits synchronously, before preserving the departing account's buffers. */
export function beginEditorAccountTransition(): number | undefined {
	if (accountTransition) return undefined;
	accountTransition = { id: ++transitionSequence }; publishTransition(); return accountTransition.id;
}
export function cancelEditorAccountTransition(id?: number): void {
	if (!accountTransition || (id !== undefined && accountTransition.id !== id)) return;
	accountTransition = undefined; publishTransition();
}
export function targetEditorAccountTransition(id: number, profile: string | undefined): void {
	if (accountTransition?.id === id && profile) accountTransition.targetProfile = profileKey(profile);
}
/** Only a committed target owner may unlock; a late response from the old bridge cannot. */
export function confirmEditorAccountProfile(profile: string): void {
	if (accountTransition?.targetProfile === profileKey(profile)) cancelEditorAccountTransition(accountTransition.id);
}

/** Native exits and account switches share the current workbench's editor protection. */
export function registerEditorExitGuard(participant: EditorExitParticipant): () => void {
	participants.add(participant);
	return () => { participants.delete(participant); };
}

export function editorsNeedExitWarning(): boolean {
	for (const participant of participants) {
		try { if (participant.needsWarning()) return true; } catch { return true; }
	}
	return false;
}

/** An exception or a newly mounted owner is never permission to destroy the old buffers. */
export function prepareEditorExit(): Promise<boolean> {
	if (preparing) return preparing;
	const snapshot = [...participants];
	const attempt = (async () => {
		try {
			for (const participant of snapshot) if (!(await participant.prepare())) return false;
			return [...participants].every((participant) => snapshot.includes(participant));
		} catch { return false; }
	})();
	preparing = attempt;
	void attempt.then(() => { if (preparing === attempt) preparing = undefined; });
	return attempt;
}

/** A page refresh cannot await WebSocket writes; warn while the latest edit has no confirmed copy. */
export function listenForUnprotectedEditorUnload(target: EditorUnloadTarget): () => void {
	const beforeUnload = (event: EditorBeforeUnloadEvent): void => {
		if (!editorsNeedExitWarning()) return;
		event.preventDefault();
		event.returnValue = "";
	};
	target.addEventListener("beforeunload", beforeUnload);
	return () => target.removeEventListener("beforeunload", beforeUnload);
}
