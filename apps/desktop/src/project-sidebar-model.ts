import { useSyncExternalStore } from "react";
import { normPath, projectLabel } from "./utils/paths.ts";
import type { SessionScope } from "./components/sidebar-scope.ts";

export interface ProjectSection { id: string; name: string }
export interface ProjectSidebarPreferences {
	view: "projects" | "merged";
	sections: ProjectSection[];
	assignments: Record<string, string>;
	hidden: string[];
	readInitialized: boolean;
	readThrough: Record<string, string>;
}
export interface ProjectSessionStamp { id?: string; modified?: string; timestamp?: string; created?: string }
const ALIASES_KEY = "owl.projectAliases";
const CHANGE_EVENT = "owl-project-sidebar-change";
let revision = 0;
function preferencesKey(scope: SessionScope): string { return `owl.${scope}.projectSidebar`; }
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stored(key: string): unknown {
	try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function publish(): void {
	revision++;
	if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}
function subscribe(listener: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	window.addEventListener(CHANGE_EVENT, listener);
	return () => window.removeEventListener(CHANGE_EVENT, listener);
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
	if (event.key === ALIASES_KEY || event.key?.endsWith(".projectSidebar")) publish();
});
export function useProjectSidebarRevision(): number { return useSyncExternalStore(subscribe, () => revision, () => 0); }

/** Invalid preferences cannot orphan assignments or introduce duplicate sections. */
export function parseProjectSidebarPreferences(raw: unknown): ProjectSidebarPreferences {
	const value = object(raw);
	const sections: ProjectSection[] = [];
	const ids = new Set<string>();
	for (const entry of Array.isArray(value.sections) ? value.sections : []) {
		const section = object(entry);
		if (typeof section.id !== "string" || !section.id.trim() || ids.has(section.id) || typeof section.name !== "string" || !section.name.trim()) continue;
		ids.add(section.id);
		sections.push({ id: section.id, name: section.name.trim().slice(0, 80) });
	}
	const assignments: Record<string, string> = {};
	for (const [path, id] of Object.entries(object(value.assignments))) if (normPath(path) && typeof id === "string" && ids.has(id)) assignments[normPath(path)] = id;
	const hidden = [...new Set((Array.isArray(value.hidden) ? value.hidden : []).filter((path): path is string => typeof path === "string" && normPath(path) !== "").map(normPath))];
	const readThrough: Record<string, string> = {};
	for (const [id, time] of Object.entries(object(value.readThrough))) if (id && typeof time === "string") readThrough[id] = time;
	return { view: value.view === "merged" ? "merged" : "projects", sections, assignments, hidden, readInitialized: value.readInitialized === true, readThrough };
}
export function getProjectSidebarPreferences(scope: SessionScope): ProjectSidebarPreferences { return parseProjectSidebarPreferences(stored(preferencesKey(scope))); }
export function saveProjectSidebarPreferences(scope: SessionScope, value: ProjectSidebarPreferences): void {
	const next = JSON.stringify(parseProjectSidebarPreferences(value));
	if (localStorage.getItem(preferencesKey(scope)) === next) return;
	localStorage.setItem(preferencesKey(scope), next);
	publish();
}
export function getProjectDisplayName(path: string): string {
	const alias = object(stored(ALIASES_KEY))[normPath(path)];
	return typeof alias === "string" && alias.trim() ? alias.trim() : projectLabel(path);
}
export function setProjectAlias(path: string, name: string): void {
	const key = normPath(path);
	if (!key) return;
	const aliases = { ...object(stored(ALIASES_KEY)) };
	const alias = name.trim().slice(0, 120);
	if (alias) aliases[key] = alias; else delete aliases[key];
	localStorage.setItem(ALIASES_KEY, JSON.stringify(aliases));
	publish();
}
export function isProjectHidden(path: string, scope: SessionScope): boolean { return getProjectSidebarPreferences(scope).hidden.includes(normPath(path)); }
export function restoreProject(path: string, scope: SessionScope): void {
	const prefs = getProjectSidebarPreferences(scope);
	const key = normPath(path);
	if (!prefs.hidden.includes(key)) return;
	saveProjectSidebarPreferences(scope, { ...prefs, hidden: prefs.hidden.filter((entry) => entry !== key) });
}
export function moveProjectToSection(prefs: ProjectSidebarPreferences, path: string, id: string | null): ProjectSidebarPreferences {
	const assignments = { ...prefs.assignments };
	const key = normPath(path);
	if (id !== null && prefs.sections.some((section) => section.id === id)) assignments[key] = id;
	else delete assignments[key];
	return { ...prefs, assignments };
}
export function removeProjectSection(prefs: ProjectSidebarPreferences, id: string): ProjectSidebarPreferences {
	return parseProjectSidebarPreferences({ ...prefs, sections: prefs.sections.filter((section) => section.id !== id) });
}
export function hideProject(prefs: ProjectSidebarPreferences, path: string): ProjectSidebarPreferences {
	const key = normPath(path);
	return { ...moveProjectToSection(prefs, path, null), hidden: [...new Set([...prefs.hidden, key])] };
}
export function sessionStamp(row: ProjectSessionStamp): string { return row.modified ?? row.timestamp ?? row.created ?? ""; }
export function withSessionsRead(prefs: ProjectSidebarPreferences, rows: readonly ProjectSessionStamp[]): ProjectSidebarPreferences {
	const readThrough = { ...prefs.readThrough };
	for (const row of rows) if (row.id) readThrough[row.id] = sessionStamp(row);
	return { ...prefs, readThrough };
}
export function initializeReadMarkers(scope: SessionScope, rows: readonly ProjectSessionStamp[]): void {
	const prefs = getProjectSidebarPreferences(scope);
	if (prefs.readInitialized) return;
	saveProjectSidebarPreferences(scope, { ...withSessionsRead(prefs, rows), readInitialized: true });
}
export function markSessionsRead(scope: SessionScope, rows: readonly ProjectSessionStamp[]): void {
	const prefs = getProjectSidebarPreferences(scope);
	saveProjectSidebarPreferences(scope, withSessionsRead(prefs, rows));
}
export function isSessionUnread(prefs: ProjectSidebarPreferences, row: ProjectSessionStamp): boolean {
	if (!prefs.readInitialized || !row.id) return false;
	const time = Date.parse(sessionStamp(row));
	if (!Number.isFinite(time)) return false;
	const marker = prefs.readThrough[row.id];
	return marker === undefined || time > (Date.parse(marker) || 0);
}
