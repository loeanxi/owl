import assert from "node:assert/strict";
import test from "node:test";
import {
	defaultWorkspaceMemory,
	readWorkspaceMemory,
	resolveWorkspaceMemory,
	sanitizeWorkspaceMemory,
	type WorkspaceMemory,
	WorkspaceRestoreGate,
	workspaceMemoryKey,
	workspaceScrollKey,
	writeWorkspaceMemory,
} from "./workspace-memory.ts";

function memory(patch: Partial<WorkspaceMemory> = {}): WorkspaceMemory {
	return {
		...defaultWorkspaceMemory(),
		savedAt: 1_760_000_000_000,
		workspace: "D:/owl/project",
		researchWorkspace: "D:/owl/research",
		workspaceSelected: true,
		...patch,
	};
}

function storage(): Pick<Storage, "getItem" | "setItem"> {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
	};
}

test("restart keeps the exact session, trajectory, selected workspace and panel state", () => {
	const state = memory({
		rail: "research",
		chatSession: "chat-older-but-open",
		researchSession: "research-open",
		researchWorkspaceSelected: false,
		conversationView: "trajectory",
		researchConversationView: "context",
		sidebarMinimized: true,
		newsSidebarMinimized: true,
		sidebarOpen: true,
		terminalOpen: true,
		developerLayout: true,
		scroll: { "chat-history": { top: 4321, left: 0, atBottom: false } },
	});
	const saved = storage();
	assert.equal(writeWorkspaceMemory(saved, "D:/owl/profiles/one", state), true);
	assert.deepEqual(readWorkspaceMemory(saved, "D:/owl/profiles/one"), state);
});

test("profiles do not share locations and Windows path variations use one profile", () => {
	const saved = storage();
	assert.equal(writeWorkspaceMemory(saved, "D:/owl/profiles/one", memory({ rail: "news" })), true);
	assert.equal(writeWorkspaceMemory(saved, "D:/owl/profiles/two", memory({ rail: "mail" })), true);
	assert.equal(readWorkspaceMemory(saved, "d:\\owl\\profiles\\ONE\\")?.rail, "news");
	assert.equal(readWorkspaceMemory(saved, "D:/owl/profiles/two")?.rail, "mail");
	assert.equal(readWorkspaceMemory(saved, "D:/owl/profiles/three"), undefined);
	assert.equal(writeWorkspaceMemory(saved, " ", memory()), false);
	assert.equal(readWorkspaceMemory(saved, " "), undefined);
});

test("every real settings section survives reload, including appearance and changelog", () => {
	const saved = storage();
	for (const section of [
		"general",
		"accounts",
		"models",
		"plugins",
		"skills",
		"presets",
		"sidebar",
		"prompts",
		"memory",
		"image",
		"appearance",
		"notifications",
		"usage",
		"archived",
		"json",
		"diagnostics",
		"execution-anomalies",
		"changelog",
		"about",
	] as const) {
		writeWorkspaceMemory(saved, "profile", memory({ settings: true, settingsTab: section }));
		assert.equal(readWorkspaceMemory(saved, "profile")?.settingsTab, section);
	}
});

test("corrupt JSON, unsupported versions and unavailable storage safely return no snapshot", () => {
	const saved = storage();
	saved.setItem(workspaceMemoryKey("profile"), "{invalid");
	assert.equal(readWorkspaceMemory(saved, "profile"), undefined);
	saved.setItem(workspaceMemoryKey("profile"), JSON.stringify({ version: 2 }));
	assert.equal(readWorkspaceMemory(saved, "profile"), undefined);
	saved.setItem(workspaceMemoryKey("profile"), JSON.stringify([]));
	assert.equal(readWorkspaceMemory(saved, "profile"), undefined);
	assert.equal(
		readWorkspaceMemory(
			{
				getItem: () => {
					throw new Error("blocked");
				},
			},
			"profile",
		),
		undefined,
	);
	assert.equal(
		writeWorkspaceMemory(
			{
				setItem: () => {
					throw new Error("quota");
				},
			},
			"profile",
			memory(),
		),
		false,
	);
});

test("malformed fields fall back without losing valid view preferences", () => {
	const state = sanitizeWorkspaceMemory(
		{
			version: 1,
			rail: "removed-screen",
			settingsTab: "removed-section",
			workspace: "",
			researchWorkspace: 77,
			conversationView: "trajectory",
			researchConversationView: "unknown-view",
			sidebarMinimized: "false",
			chatSession: { id: "wrong-shape" },
			settings: true,
			scroll: {
				valid: { top: 9, left: 2, atBottom: true },
				negative: { top: -1, left: 0 },
				nan: { top: Number.NaN, left: 0 },
				infinity: { top: Number.POSITIVE_INFINITY, left: 0 },
				wrongShape: "123",
			},
		},
		memory({ rail: "projects", settingsTab: "appearance" }),
	);
	assert.ok(state);
	assert.equal(state.rail, "projects");
	assert.equal(state.settingsTab, "appearance");
	assert.equal(state.workspace, "D:/owl/project");
	assert.equal(state.conversationView, "trajectory");
	assert.equal(state.researchConversationView, "chat");
	assert.equal(state.sidebarMinimized, false);
	assert.equal(state.chatSession, undefined);
	assert.equal(state.settings, true);
	assert.deepEqual(state.scroll, { valid: { top: 9, left: 2, atBottom: true } });
});

test("temporary workspace paths explicitly selected by the user remain exact", () => {
	const state = memory({
		workspace: "D:/owl/.validation/a/workspace",
		researchWorkspace: "D:/owl/.validation/research/workspace",
	});
	assert.equal(sanitizeWorkspaceMemory(state)?.workspace, state.workspace);
	assert.equal(sanitizeWorkspaceMemory(state)?.researchWorkspace, state.researchWorkspace);
});

test("validation chooses saved IDs instead of the newest session and uses authoritative cwd", () => {
	const state = memory({ chatSession: "old-open", researchSession: "research-open" });
	const resolved = resolveWorkspaceMemory(state, [
		{ id: "newest", cwd: "D:/elsewhere", scope: "chat" },
		{ id: "old-open", cwd: "D:/moved/project", scope: "chat" },
		{ id: "research-open", cwd: "D:/moved/research", scope: "research" },
	]);
	assert.equal(resolved.chatSession, "old-open");
	assert.equal(resolved.researchSession, "research-open");
	assert.equal(resolved.workspace, "D:/moved/project");
	assert.equal(resolved.researchWorkspace, "D:/moved/research");
});

test("missing, archived and wrong-scope sessions fall back to the saved page without opening another session", () => {
	const state = memory({
		rail: "research",
		settings: true,
		settingsTab: "memory",
		chatSession: "chat-gone",
		researchSession: "research-gone",
	});
	for (const rows of [
		[{ id: "other", cwd: "D:/owl/project", scope: "chat" }],
		[
			{ id: "chat-gone", archivedAt: "2026-10-14", scope: "chat" },
			{ id: "research-gone", archivedAt: "2026-10-14", scope: "research" },
		],
		[
			{ id: "chat-gone", scope: "research" },
			{ id: "research-gone", scope: "chat" },
		],
	]) {
		const resolved = resolveWorkspaceMemory(state, rows);
		assert.equal(resolved.chatSession, undefined);
		assert.equal(resolved.researchSession, undefined);
		assert.equal(resolved.rail, "research");
		assert.equal(resolved.settingsTab, "memory");
		assert.equal(resolved.workspace, state.workspace);
	}
	assert.equal(resolveWorkspaceMemory(memory(), [{ cwd: "D:/unrelated" }]).workspace, "D:/owl/project");
});

test("scroll locations distinguish sessions, projects, settings sections and conversation tabs", () => {
	const state = memory({ chatSession: "one" });
	const key = workspaceScrollKey(state, "chat");
	assert.notEqual(key, workspaceScrollKey({ ...state, chatSession: "two" }, "chat"));
	assert.notEqual(key, workspaceScrollKey({ ...state, workspace: "D:/another" }, "chat"));
	assert.notEqual(key, workspaceScrollKey({ ...state, conversationView: "trajectory" }, "chat"));
	assert.equal(key, workspaceScrollKey({ ...state, workspace: "d:\\OWL\\project\\" }, "chat"));
	assert.notEqual(
		workspaceScrollKey({ ...state, settings: true, settingsTab: "appearance" }, "settings"),
		workspaceScrollKey({ ...state, settings: true, settingsTab: "models" }, "settings"),
	);
});

test("startup empty state cannot overwrite the snapshot while hydration is pending", () => {
	const gate = new WorkspaceRestoreGate();
	assert.equal(gate.canSave(), false);
	const token = gate.begin();
	assert.ok(token);
	assert.equal(gate.canApply(token), true);
	assert.equal(gate.canSave(), false);
	assert.equal(gate.begin(), undefined);
	assert.equal(gate.finish(token), true);
	assert.equal(gate.canSave(), true);
	assert.equal(gate.canApply(token), false);
});

test("user navigation before or during restoration outranks delayed responses", () => {
	const beforeConnected = new WorkspaceRestoreGate();
	beforeConnected.markUserNavigation();
	assert.equal(beforeConnected.begin(), undefined);
	assert.equal(beforeConnected.canSave(), true);
	const duringRestore = new WorkspaceRestoreGate();
	const token = duringRestore.begin();
	assert.ok(token);
	duringRestore.markUserNavigation();
	assert.equal(duringRestore.canApply(token), false);
	assert.equal(duringRestore.finish(token), false);
	assert.equal(duringRestore.retry(token), false);
	assert.equal(duringRestore.canSave(), true);
});

test("temporary bridge failure protects the old snapshot and allows restoration after reconnect", () => {
	const gate = new WorkspaceRestoreGate();
	const first = gate.begin();
	assert.ok(first);
	assert.equal(gate.retry(first), true);
	assert.equal(gate.canSave(), false);
	assert.equal(gate.canApply(first), false);
	const retried = gate.begin();
	assert.ok(retried);
	assert.notEqual(retried.revision, first.revision);
	assert.equal(gate.canApply(retried), true);
	assert.equal(gate.finish(retried), true);
	assert.equal(gate.canSave(), true);
});
