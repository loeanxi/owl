import assert from "node:assert/strict";
import test from "node:test";
import { hideProject, isSessionUnread, moveProjectToSection, parseProjectSidebarPreferences, removeProjectSection, withSessionsRead } from "./project-sidebar-model.ts";

test("malformed preferences cannot leave projects in nonexistent partitions", () => {
	const prefs = parseProjectSidebarPreferences({ sections: [{ id: "work", name: "工作" }, { id: "work", name: "重复" }, null], assignments: { "D:\\OWL\\": "work", "D:/gone": "missing" }, hidden: ["D:\\OWL", "d:/owl/", 42] });
	assert.deepEqual(prefs.sections, [{ id: "work", name: "工作" }]);
	assert.deepEqual(prefs.assignments, { "d:/owl": "work" });
	assert.deepEqual(prefs.hidden, ["d:/owl"]);
});
test("moving and removing a partition preserves projects and returns their assignment to default", () => {
	const prefs = parseProjectSidebarPreferences({ sections: [{ id: "work", name: "工作" }] });
	const assigned = moveProjectToSection(prefs, "D:\\owl", "work");
	assert.equal(assigned.assignments["d:/owl"], "work");
	assert.deepEqual(prefs.assignments, {});
	assert.deepEqual(removeProjectSection(assigned, "work").assignments, {});
	assert.equal(hideProject(assigned, "D:/owl/").hidden[0], "d:/owl");
	assert.deepEqual(hideProject(assigned, "D:/owl/").assignments, {});
});
test("read markers follow session modification time and do not rewrite source rows", () => {
	const prefs = parseProjectSidebarPreferences({ readInitialized: true });
	const row = { id: "a", modified: "2026-10-04T01:00:00Z" };
	assert.equal(isSessionUnread(prefs, row), true);
	const read = withSessionsRead(prefs, [row]);
	assert.equal(isSessionUnread(read, row), false);
	assert.equal(isSessionUnread(read, { ...row, modified: "2026-10-04T02:00:00Z" }), true);
	assert.equal(isSessionUnread(read, { id: "x", modified: "bad" }), false);
	assert.deepEqual(prefs.readThrough, {});
	assert.deepEqual(row, { id: "a", modified: "2026-10-04T01:00:00Z" });
});
