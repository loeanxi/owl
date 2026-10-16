import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DiffApprovalStore } from "../../src/core/diff-approval/store.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";

let cwd: string;
let file: string;
let store: DiffApprovalStore;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "owl-undo-review-"));
	file = join(cwd, "file.txt");
	store = new DiffApprovalStore({ filePath: join(cwd, "approval.json"), workspaceDir: cwd });
	store.load();
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

it("refuses a stale capture when a manual write occurs before the real write tool executes", async () => {
	writeFileSync(file, "original\n");
	const input = { path: file, content: "agent\n" };
	store.stage("write", file, { sessionId: "session", turnId: "turn", toolName: "write", input });
	writeFileSync(file, "manual before actual write\n");
	await createWriteTool(cwd).execute("write", input);
	store.commit("write", false, "session");
	const row = store.list(cwd)[0];
	expect(row.revertible).toBe(false);
	expect(store.preview([row.id]).files[0].canRevert).toBe(false);
});

it("refuses ambiguous deleted text restoration when repeated surrounding blocks are removed manually", () => {
	writeFileSync(file, "A\ndeleted by agent\nB\nA\nB\n");
	store.stage("write", file, {
		sessionId: "session",
		turnId: "turn",
		toolName: "write",
		input: { content: "A\nB\nA\nB\n" },
	});
	store.recordMutationBefore("session:write", "A\nB\nA\nB\n");
	writeFileSync(file, "A\nB\nA\nB\n");
	store.commit("write", false, "session");
	// The user removed the first A/B block. Its bytes are identical to the remaining block.
	writeFileSync(file, "A\nB\n");
	const row = store.list(cwd)[0];
	expect(row.revertible).toBe(true);
	const preview = store.preview([row.id]);
	expect(preview.files[0].canRevert).toBe(false);
	expect(preview.files[0].reason).toContain("重复内容");
	expect(readFileSync(file, "utf8")).toBe("A\nB\n");
});
