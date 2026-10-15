import { matchesSessionScope, type SessionScope } from "./components/sidebar-scope.ts";
import { normPath, samePath } from "./utils/paths.ts";

type ProjectStorage = Pick<Storage, "getItem" | "setItem">;
type Visit = { cwd: string; sessionId: string; visitedAt: number };
export type ProjectHistoryRow = { id?: string; cwd?: string; scope?: unknown; archivedAt?: unknown; modified?: string; created?: string; messageCount?: number };
export type ProjectSessionChoice = { sessionId?: string; fallback: boolean };

export function projectSessionMemoryKey(profile: string, scope: SessionScope): string {
	return `owl.project.sessions.v1:${encodeURIComponent(normPath(profile))}:${scope}`;
}

function readVisits(storage: Pick<ProjectStorage, "getItem">, profile: string, scope: SessionScope): Visit[] {
	if (!profile.trim()) return [];
	try {
		const raw = storage.getItem(projectSessionMemoryKey(profile, scope));
		if (!raw || raw.length > 256_000) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is Visit => value !== null && typeof value === "object" && typeof value.cwd === "string" && value.cwd.trim() !== "" && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 4_000 && typeof value.visitedAt === "number" && Number.isFinite(value.visitedAt)).slice(-200);
	} catch { return []; }
}

/** Record what the user opened, independently of which conversation the agent modified last. */
export function rememberProjectSession(storage: ProjectStorage, profile: string | undefined, scope: SessionScope, cwd: string, sessionId: string | undefined): void {
	if (!profile?.trim() || !cwd.trim() || !sessionId) return;
	const visits = readVisits(storage, profile, scope).filter((visit) => !samePath(visit.cwd, cwd));
	visits.push({ cwd: normPath(cwd), sessionId, visitedAt: Date.now() });
	try { storage.setItem(projectSessionMemoryKey(profile, scope), JSON.stringify(visits.slice(-200))); } catch { /* Session navigation remains available without storage. */ }
}

/** Validate saved ownership against authoritative rows before restoring; archived sessions stay tucked away. */
export function resolveProjectSession(storage: Pick<ProjectStorage, "getItem">, profile: string | undefined, scope: SessionScope, cwd: string, rows: readonly ProjectHistoryRow[]): ProjectSessionChoice {
	const remembered = profile ? readVisits(storage, profile, scope).find((visit) => samePath(visit.cwd, cwd))?.sessionId : undefined;
	const available = rows.filter((row) => row.id && samePath(row.cwd, cwd) && matchesSessionScope(row, scope) && typeof row.archivedAt !== "string");
	if (remembered && available.some((row) => row.id === remembered)) return { sessionId: remembered, fallback: false };
	const latest = [...available].sort((a, b) => String(b.modified ?? b.created ?? "").localeCompare(String(a.modified ?? a.created ?? ""))).find((row) => row.messageCount !== 0);
	return { sessionId: latest?.id, fallback: remembered !== undefined };
}
