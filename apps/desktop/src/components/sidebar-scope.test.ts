import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeResearchSidebar, loadSidebarStrings, matchesSessionScope, sidebarStorageKeys } from "./sidebar-scope.ts";

class MemoryStorage {
	values = new Map<string, string>();
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("ordinary and research histories stay separate even inside the same project", () => {
	const rows = [
		{ id: "chat", cwd: "D:/shared", scope: "chat" },
		{ id: "research", cwd: "D:/shared", scope: "research" },
		{ id: "legacy", cwd: "D:/shared" },
		{ id: "invalid", cwd: "D:/shared", scope: "other" },
	];
	assert.deepEqual(rows.filter((row) => matchesSessionScope(row, "research")).map((row) => row.id), ["research"]);
	assert.deepEqual(rows.filter((row) => matchesSessionScope(row, "chat")).map((row) => row.id), ["chat", "legacy"]);
});

test("sidebar preferences have independent namespaces while ordinary project history stays intact", () => {
	const storage = new MemoryStorage();
	const ordinary = sidebarStorageKeys("chat");
	const research = sidebarStorageKeys("research");
	storage.setItem(ordinary.projects, JSON.stringify(["D:/ordinary-project"]));
	storage.setItem(research.projects, JSON.stringify(["D:/research-project"]));
	assert.equal(ordinary.projects, "owl.projects");
	for (const key of Object.keys(ordinary) as Array<keyof typeof ordinary>) assert.notEqual(ordinary[key], research[key]);
	assert.deepEqual(loadSidebarStrings(storage, ordinary.projects), ["D:/ordinary-project"]);
	assert.deepEqual(loadSidebarStrings(storage, research.projects), ["D:/research-project"]);
});

test("existing mixed pins are copied by persisted session type without deleting ordinary preferences", () => {
	const storage = new MemoryStorage();
	const ordinary = sidebarStorageKeys("chat");
	const research = sidebarStorageKeys("research");
	storage.setItem(ordinary.pinned, JSON.stringify(["ordinary", "research", "missing"]));
	storage.setItem(ordinary.pinnedProjects, JSON.stringify(["D:/development", "D:\\RESEARCH"]));
	storage.setItem(ordinary.projects, JSON.stringify(["D:/development", "D:/research"]));
	const before = new Map(storage.values);
	initializeResearchSidebar(storage, [{ id: "research", cwd: "D:/research" }]);
	assert.equal(storage.getItem(research.pinned), null);
	initializeResearchSidebar(storage, [{ id: "ordinary", cwd: "D:/development", scope: "chat" }, { id: "research", cwd: "d:/research/", scope: "research" }]);
	assert.deepEqual(loadSidebarStrings(storage, research.pinned), ["research"]);
	assert.deepEqual(loadSidebarStrings(storage, research.pinnedProjects), ["D:\\RESEARCH"]);
	assert.equal(storage.getItem(research.projects), null);
	for (const [key, value] of before) assert.equal(storage.getItem(key), value);
	storage.setItem(research.pinned, "[]");
	storage.setItem(research.pinnedProjects, "[]");
	initializeResearchSidebar(storage, [{ id: "research", cwd: "D:/research", scope: "research" }]);
	assert.deepEqual(loadSidebarStrings(storage, research.pinned), []);
	assert.deepEqual(loadSidebarStrings(storage, research.pinnedProjects), []);
});

test("unavailable or malformed preference storage falls back safely", () => {
	const storage = new MemoryStorage();
	storage.setItem("bad", "{invalid");
	storage.setItem("mixed", JSON.stringify([1, "project", null]));
	assert.deepEqual(loadSidebarStrings(storage, "bad"), []);
	assert.deepEqual(loadSidebarStrings(storage, "mixed"), ["project"]);
	const unavailable = { getItem(): never { throw new Error("storage unavailable"); }, setItem(): never { throw new Error("storage unavailable"); } };
	assert.deepEqual(loadSidebarStrings(unavailable, "anything"), []);
	assert.doesNotThrow(() => initializeResearchSidebar(unavailable, []));
});
