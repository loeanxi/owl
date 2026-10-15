import assert from "node:assert/strict";
import test from "node:test";
import { projectSessionMemoryKey, rememberProjectSession, resolveProjectSession, type ProjectHistoryRow } from "./project-session-memory.ts";

function store() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
const rows: ProjectHistoryRow[] = [
	{ id: "opened", cwd: "D:/A", scope: "chat", modified: "2026-10-10", messageCount: 4 },
	{ id: "newest", cwd: "D:/A", scope: "chat", modified: "2026-10-15", messageCount: 8 },
	{ id: "research", cwd: "D:/A", scope: "research", modified: "2026-10-16", messageCount: 2 },
	{ id: "other", cwd: "D:/B", scope: "chat", modified: "2026-10-17", messageCount: 2 },
];
test("A/B project visits restore the last opened chat instead of the latest modified chat", () => {
	const saved = store();
	rememberProjectSession(saved, "profile", "chat", "D:/A", "opened");
	rememberProjectSession(saved, "profile", "chat", "D:/B", "other");
	assert.deepEqual(resolveProjectSession(saved, "profile", "chat", "d:\\A\\", rows), { sessionId: "opened", fallback: false });
	assert.equal(resolveProjectSession(saved, "profile", "chat", "D:/B", rows).sessionId, "other");
});
test("account and ordinary/research ownership remain separate", () => {
	const saved = store();
	rememberProjectSession(saved, "profile-one", "chat", "D:/A", "opened");
	rememberProjectSession(saved, "profile-one", "research", "D:/A", "research");
	assert.equal(resolveProjectSession(saved, "profile-one", "research", "D:/A", rows).sessionId, "research");
	assert.equal(resolveProjectSession(saved, "profile-two", "chat", "D:/A", rows).sessionId, "newest");
});
test("deleted, archived or foreign project/session references fall back to a valid conversation or blank", () => {
	for (const sessionId of ["deleted", "research", "other"]) {
		const saved = store(); rememberProjectSession(saved, "profile", "chat", "D:/A", sessionId);
		assert.deepEqual(resolveProjectSession(saved, "profile", "chat", "D:/A", rows), { sessionId: "newest", fallback: true });
	}
	const saved = store(); rememberProjectSession(saved, "profile", "chat", "D:/A", "opened");
	assert.deepEqual(resolveProjectSession(saved, "profile", "chat", "D:/A", rows.map((row) => ({ ...row, archivedAt: "2026-10-15" }))), { sessionId: undefined, fallback: true });
});
test("bad or unavailable browser storage never prevents ordinary navigation", () => {
	const saved = store(); saved.setItem(projectSessionMemoryKey("profile", "chat"), "{broken");
	assert.equal(resolveProjectSession(saved, "profile", "chat", "D:/A", rows).sessionId, "newest");
	const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } };
	rememberProjectSession(blocked, "profile", "chat", "D:/A", "opened");
	assert.equal(resolveProjectSession(blocked, "profile", "chat", "D:/A", rows).sessionId, "newest");
});
