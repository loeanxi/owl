import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { getWorkspaceDiffApprovalStore } from "../src/core/diff-approval/registry.ts";
import { type DiffApprovalRequest, handleDiffApprovalRequest } from "../src/modes/desktop/handlers/workbench.ts";
import type {
	DiffApprovalListResult,
	DiffApprovalPreviewResult,
	DiffApprovalResolveResult,
} from "../src/modes/desktop/protocol.ts";

describe("diff approval bridge handler with real isolated files", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	const ws = {} as WebSocket;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "owl-review-handler-"));
		cwd = join(root, "workspace");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function request<T>(message: DiffApprovalRequest): Promise<{ ok: boolean; result?: T; error?: string }> {
		let response: { ok: boolean; result?: unknown; error?: string } | undefined;
		await handleDiffApprovalRequest(ws, message, {
			defaultAgentDir: () => agentDir,
			reply: (_socket, id, value) => {
				expect(id).toBe(message.id);
				response = value;
			},
		});
		expect(response).toBeDefined();
		return response as { ok: boolean; result?: T; error?: string };
	}

	function writeOperation(toolId: string, content: string, path = "a.ts", sessionId = "session-a"): void {
		const store = getWorkspaceDiffApprovalStore(agentDir, cwd);
		const absolute = join(cwd, path);
		store.stage(toolId, absolute, {
			sessionId,
			turnId: `turn-${toolId}`,
			toolName: "write",
			input: { path, content },
		});
		store.recordMutationBefore(`${sessionId}:${toolId}`, content);
		writeFileSync(absolute, content);
		store.commit(toolId, false, sessionId);
	}

	it("forwards session and tool scope, previews only that round, and preserves later and manual edits on confirmation", async () => {
		writeFileSync(join(cwd, "a.ts"), "original\nspacer\nlater-base\nmanual-base\n");
		writeOperation("first", "first-round\nspacer\nlater-base\nmanual-base\n");
		writeOperation("second", "first-round\nspacer\nlater-round\nmanual-base\n");
		writeFileSync(join(cwd, "a.ts"), "first-round\nspacer\nlater-round\nmanual-edit\n");
		writeOperation("other-session", "other\n", "other.ts", "session-b");
		const scoped = await request<DiffApprovalListResult>({
			type: "diffApproval.list",
			id: "list",
			cwd,
			scope: { sessionId: "session-a", toolCallIds: ["first"] },
		});
		expect(scoped.ok).toBe(true);
		expect(scoped.result?.files).toHaveLength(1);
		const ids = scoped.result!.files.map((file) => file.id);
		const planned = await request<DiffApprovalPreviewResult>({
			type: "diffApproval.preview",
			id: "preview",
			cwd,
			entryIds: ids,
			mode: "operations",
		});
		expect(planned.ok).toBe(true);
		expect(planned.result?.files).toHaveLength(1);
		expect(planned.result?.files[0].canRevert).toBe(true);
		expect(planned.result?.files[0].diff).toContain("+original");
		expect(readFileSync(join(cwd, "a.ts"), "utf8")).toContain("first-round");
		const resolved = await request<DiffApprovalResolveResult>({
			type: "diffApproval.resolve",
			id: "resolve",
			cwd,
			entryIds: ids,
			action: "revert",
			previewToken: planned.result!.token,
		});
		expect(resolved.result).toEqual({ resolved: 1, resolvedIds: ids, failed: [] });
		expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("original\nspacer\nlater-round\nmanual-edit\n");
		expect(readFileSync(join(cwd, "other.ts"), "utf8")).toBe("other\n");
	});

	it("forwards stale token failures per file after a manual edit without overwriting that file", async () => {
		writeFileSync(join(cwd, "a.ts"), "before\n");
		writeOperation("first", "after\n");
		const listed = await request<DiffApprovalListResult>({ type: "diffApproval.list", id: "list", cwd });
		const ids = listed.result!.files.map((file) => file.id);
		const planned = await request<DiffApprovalPreviewResult>({
			type: "diffApproval.preview",
			id: "preview",
			cwd,
			entryIds: ids,
		});
		writeFileSync(join(cwd, "a.ts"), "my-manual-change\n");
		const resolved = await request<DiffApprovalResolveResult>({
			type: "diffApproval.resolve",
			id: "resolve",
			cwd,
			entryIds: ids,
			action: "revert",
			previewToken: planned.result!.token,
		});
		expect(resolved.ok).toBe(true);
		expect(resolved.result?.resolved).toBe(0);
		expect(resolved.result?.failed).toHaveLength(1);
		expect(resolved.result?.failed[0].reason).toMatch(/预览|变化/);
		expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("my-manual-change\n");
	});
});
