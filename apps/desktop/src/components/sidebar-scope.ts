import type { SessionListRequest } from "../bridge/protocol.ts";
import { normPath } from "../utils/paths.ts";

export type SessionScope = NonNullable<SessionListRequest["scope"]>;
type ScopeRow = { id?: string; cwd?: string; scope?: unknown };
type SidebarStorage = Pick<Storage, "getItem" | "setItem">;

/** Existing histories without explicit metadata remain ordinary conversations. */
export function matchesSessionScope(row: ScopeRow, scope: SessionScope): boolean {
	return row.scope === scope || (scope === "chat" && row.scope === undefined);
}

export function sidebarStorageKeys(scope: SessionScope): {
	pinned: string; pinnedProjects: string; projects: string; collapsed: string; pinnedSort: string; recentSort: string;
} {
	return scope === "research" ? {
		pinned: "owl.research.sidebar.pinnedSessions", pinnedProjects: "owl.research.sidebar.pinnedProjects",
		projects: "owl.research.sidebar.projects", collapsed: "owl.research.sidebar.collapsed",
		pinnedSort: "owl.research.sidebar.pinnedSort", recentSort: "owl.research.sidebar.recentSort",
	} : {
		pinned: "owl.pinnedSessions", pinnedProjects: "owl.pinnedProjects", projects: "owl.projects",
		collapsed: "owl.sidebar.collapsed", pinnedSort: "owl.sidebar.pinnedSort", recentSort: "owl.sidebar.recentSort",
	};
}

export function loadSidebarStrings(storage: Pick<Storage, "getItem">, key: string): string[] {
	try {
		const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
}

/** Copy only existing research pins into their new namespace; preserve the shared legacy keys. */
export function initializeResearchSidebar(storage: SidebarStorage, rows: readonly ScopeRow[]): void {
	// Wait for authoritative type metadata before splitting legacy preferences.
	if (rows.some((row) => row.scope !== "chat" && row.scope !== "research")) return;
	const keys = sidebarStorageKeys("research");
	const ordinaryKeys = sidebarStorageKeys("chat");
	const research = rows.filter((row) => matchesSessionScope(row, "research"));
	const ids = new Set(research.map((row) => row.id));
	const projects = new Set(research.map((row) => normPath(row.cwd)).filter(Boolean));
	try {
		if (storage.getItem(keys.pinned) === null) {
			storage.setItem(keys.pinned, JSON.stringify(loadSidebarStrings(storage, ordinaryKeys.pinned).filter((id) => ids.has(id))));
		}
		if (storage.getItem(keys.pinnedProjects) === null) {
			storage.setItem(keys.pinnedProjects, JSON.stringify(loadSidebarStrings(storage, ordinaryKeys.pinnedProjects).filter((path) => projects.has(normPath(path)))));
		}
	} catch { /* The current history still renders when preference storage is unavailable. */ }
}
