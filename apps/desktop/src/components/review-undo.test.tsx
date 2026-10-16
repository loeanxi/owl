import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type DiffApprovalChangedHandler } from "../bridge/client.ts";
import type { DesktopClientRequestWithoutId, DiffApprovalFileSummary, DiffApprovalPreviewResult } from "../bridge/protocol.ts";
import { createSidebarApi } from "../sidebar/api.ts";
import { SidebarStore } from "../sidebar/store.ts";
import { ReviewTab } from "../sidebar/tabs/ReviewTab.tsx";
import { ReviewChangesCard, type ReviewChangesCardProps } from "./ReviewChangesCard.tsx";
import { DiffApprovalStore } from "../../../../packages/coding-agent/src/core/diff-approval/store.ts";

interface Envelope { ok: boolean; result?: unknown; error?: string }
let root: Root;
let container: HTMLElement;
let client: BridgeClient;
let props: ReviewChangesCardProps;
let records: DiffApprovalFileSummary[];
let changed: DiffApprovalChangedHandler;
let respond: (request: DesktopClientRequestWithoutId) => Promise<Envelope>;
let calls: DesktopClientRequestWithoutId[];

function record(id: string, path = "a.ts", overrides: Partial<DiffApprovalFileSummary> = {}): DiffApprovalFileSummary {
	return { id, path: `D:/project/${path}`, displayPath: path, status: "pending", originalExisted: true, currentExists: true, added: 1, removed: 1, size: 20, baselineAt: "2026-10-15T01:00:00.000Z", resolvedAt: null, toolCallId: id, sessionId: "session-a", scope: "operation", ...overrides };
}

function preview(ids: string[], blocked: string[] = []): DiffApprovalPreviewResult {
	return { token: "revision-one", mode: "operations", expiresAt: new Date(Date.now() + 60_000).toISOString(), files: ids.map((id) => ({ path: `D:/project/${id}.ts`, displayPath: `${id}.ts`, entryIds: [id], canRevert: !blocked.includes(id), ...(blocked.includes(id) ? { reason: "Later manual edit overlaps this operation" } : {}), diff: `diff --git a/${id}.ts b/${id}.ts\n--- a/${id}.ts\n+++ b/${id}.ts\n@@ -1 +1 @@\n-current-${id}\n+original-${id}\n`, truncated: false, currentExists: true, targetExists: true })) };
}

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = dom.document.getElementById("root")!;
	root = createRoot(container);
	client = new BridgeClient("ws://review.test");
	calls = [];
	records = [record("op-a")];
	respond = async (request) => {
		if (request.type === "diffApproval.list") return { ok: true, result: { files: records } };
		if (request.type === "diffApproval.preview") return { ok: true, result: preview(request.entryIds) };
		if (request.type === "diffApproval.resolve") {
			records = records.map((item) => request.entryIds.includes(item.id) ? { ...item, status: request.action === "keep" ? "kept" : "reverted" } : item);
			return { ok: true, result: { resolved: request.entryIds.length, resolvedIds: request.entryIds, failed: [] } };
		}
		if (request.type === "diffApproval.diff") return { ok: true, result: { diff: preview([request.entryId]).files[0].diff, truncated: false } };
		throw new Error(`Unexpected request: ${request.type}`);
	};
	vi.spyOn(client, "request").mockImplementation(async <T,>(request: DesktopClientRequestWithoutId & { id?: string }) => {
		calls.push(request);
		const result = await respond(request);
		return { ...result, result: result.result as T };
	});
	vi.spyOn(client, "onDiffApprovalChanged").mockImplementation((listener) => { changed = listener; return () => {}; });
	props = { files: [{ path: "a.ts", title: "a.ts", kind: "code", action: "edited", toolId: "op-a" }], cwd: "D:/project", sessionId: "session-a", client, onOpenFile: vi.fn(), onOpenReview: vi.fn() };
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(overrides: Partial<ReviewChangesCardProps> = {}): Promise<void> {
	props = { ...props, ...overrides };
	await act(async () => root.render(<ReviewChangesCard {...props} />));
}

function button(label: string): HTMLButtonElement {
	const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
	if (!result) throw new Error(`Missing button: ${label}\n${container.textContent}`);
	return result;
}

async function click(label: string): Promise<void> { await act(async () => button(label).click()); }
function requests(type: string): DesktopClientRequestWithoutId[] { return calls.filter((request) => request.type === type); }

describe("turn undo with typed bridge API responses", () => {
	it("confirms through the actual store API and preserves later and manual disk content", async () => {
		const directory = mkdtempSync(join(tmpdir(), "owl-review-dom-"));
		try {
			const path = join(directory, "a.ts");
			const store = new DiffApprovalStore({ filePath: join(directory, "review.json"), workspaceDir: directory });
			writeFileSync(path, "original\nspacer\nlater-base\nmanual-base\n");
			store.stage("op-a", path, { sessionId: "session-a", turnId: "turn-a", toolName: "write", input: { content: "turn-a\nspacer\nlater-base\nmanual-base\n" } });
			store.recordMutationBefore("session-a:op-a", "turn-a\nspacer\nlater-base\nmanual-base\n");
			writeFileSync(path, "turn-a\nspacer\nlater-base\nmanual-base\n");
			store.commit("op-a", false, "session-a");
			store.stage("op-b", path, { sessionId: "session-a", turnId: "turn-b", toolName: "write", input: { content: "turn-a\nspacer\nturn-b\nmanual-base\n" } });
			store.recordMutationBefore("session-a:op-b", "turn-a\nspacer\nturn-b\nmanual-base\n");
			writeFileSync(path, "turn-a\nspacer\nturn-b\nmanual-base\n");
			store.commit("op-b", false, "session-a");
			writeFileSync(path, "turn-a\nspacer\nturn-b\nmy-edit\n");
			respond = async (request) => {
				if (request.type === "diffApproval.list") return { ok: true, result: { files: store.list(request.cwd, request.scope) } };
				if (request.type === "diffApproval.preview") return { ok: true, result: store.preview(request.entryIds, request.mode) };
				if (request.type === "diffApproval.resolve") return { ok: true, result: await store.resolve(request.entryIds, request.action, request.previewToken) };
				throw new Error(`Unexpected integration request: ${request.type}`);
			};
			await render({ cwd: directory });
			await click("仅撤销本轮改动");
			expect(container.textContent).toContain("original");
			expect(readFileSync(path, "utf8")).toContain("turn-a");
			await act(async () => {
				button("确认撤销可处理文件").click();
				await vi.waitFor(() => expect(readFileSync(path, "utf8")).toBe("original\nspacer\nturn-b\nmy-edit\n"));
			});
			expect(container.textContent).toContain("撤销完成");
			expect(readFileSync(path, "utf8")).toBe("original\nspacer\nturn-b\nmy-edit\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("matches tool provenance instead of another round's record at the same path, including all operations in this turn", async () => {
		records = [record("op-a"), record("op-a2"), record("later"), record("other", "a.ts", { toolCallId: "op-a", sessionId: "other-session" })];
		await render({ files: [{ ...props.files[0], toolId: "op-a2", toolIds: ["op-a", "op-a2"] }] });
		expect(requests("diffApproval.list")[0]).toMatchObject({ scope: { toolCallIds: ["op-a", "op-a2"], sessionId: "session-a" } });
		await click("仅撤销本轮改动");
		expect(requests("diffApproval.preview")[0]).toMatchObject({ entryIds: ["op-a", "op-a2"], mode: "operations" });
		expect(requests("diffApproval.resolve")).toHaveLength(0);
	});

	it("shows exact proposed patches and only writes after explicit confirmation using the preview token", async () => {
		await render();
		await click("仅撤销本轮改动");
		expect(container.textContent).toContain("original-op-a");
		expect(container.textContent).toContain("后续修改和手动修改");
		expect(requests("diffApproval.resolve")).toHaveLength(0);
		await click("确认撤销可处理文件");
		expect(requests("diffApproval.resolve")[0]).toMatchObject({ entryIds: ["op-a"], action: "revert", previewToken: "revision-one" });
		expect(container.textContent).toContain("撤销完成");
		expect(container.textContent).toContain("已处理操作: 1");
	});

	it("leaves overlapping conflicts visible and refuses an all-conflict confirmation", async () => {
		const ordinary = respond;
		respond = (request) => request.type === "diffApproval.preview" ? Promise.resolve({ ok: true, result: preview(request.entryIds, request.entryIds) }) : ordinary(request);
		await render();
		await click("仅撤销本轮改动");
		expect(container.textContent).toContain("Later manual edit overlaps");
		expect(container.textContent).toContain("没有可以安全撤销的文件");
		expect(button("确认撤销可处理文件").disabled).toBe(true);
		expect(requests("diffApproval.resolve")).toHaveLength(0);
	});

	it("keeps partial failures after list refresh and retries only failed operations through a fresh preview", async () => {
		records.push(record("op-b", "b.ts"));
		const ordinary = respond;
		respond = async (request) => {
			if (request.type === "diffApproval.resolve") {
				records[0] = { ...records[0], status: "reverted" };
				return { ok: true, result: { resolved: 1, resolvedIds: ["op-a"], failed: [{ path: "b.ts", reason: "File changed after preview" }] } };
			}
			return ordinary(request);
		};
		await render({ files: [...props.files, { path: "b.ts", title: "b.ts", kind: "code", action: "edited", toolId: "op-b" }] });
		await click("仅撤销本轮改动");
		await click("确认撤销可处理文件");
		await act(async () => changed({ type: "diffApproval.changed", cwd: "D:/project" }));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("File changed after preview");
		expect(container.textContent).toContain("已处理操作: 1");
		await click("重新预览并重试");
		expect(requests("diffApproval.preview").at(-1)).toMatchObject({ entryIds: ["op-b"] });
	});

	it("retains an I/O recovery path without claiming a failed file was unchanged", async () => {
		const ordinary = respond;
		const reason = "写入和恢复失败，请从 D:/project/.a.ts.undo-backup 恢复原文";
		respond = (request) => request.type === "diffApproval.resolve"
			? Promise.resolve({ ok: true, result: { resolved: 0, resolvedIds: [], failed: [{ path: "a.ts", reason }] } })
			: ordinary(request);
		await render();
		await click("仅撤销本轮改动");
		await click("确认撤销可处理文件");
		const feedback = container.querySelector('[role="alert"]')?.textContent;
		expect(feedback).toContain(reason);
		expect(feedback).not.toContain("文件保持不变");
		expect(button("重新预览并重试").disabled).toBe(false);
	});

	it("shows retained backup warnings after a successful undo without offering to undo it again", async () => {
		const ordinary = respond;
		const reason = "撤销已完成，未能清理原文备份：D:/project/.a.ts.undo-backup";
		respond = (request) => request.type === "diffApproval.resolve"
			? Promise.resolve({ ok: true, result: { resolved: 1, resolvedIds: ["op-a"], failed: [], warnings: [{ path: "a.ts", reason }] } })
			: ordinary(request);
		await render();
		await click("仅撤销本轮改动");
		await click("确认撤销可处理文件");
		expect(container.textContent).toContain("撤销完成");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(reason);
		expect([...container.querySelectorAll("button")].some((item) => item.textContent === "重新预览并重试")).toBe(false);
	});

	it("shows bridge failures and requires another preview before retrying an uncertain mutation", async () => {
		const ordinary = respond;
		respond = (request) => request.type === "diffApproval.resolve" ? Promise.reject(new Error("bridge disconnected")) : ordinary(request);
		await render();
		await click("仅撤销本轮改动");
		await click("确认撤销可处理文件");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("bridge disconnected");
		await click("重新预览并重试");
		expect(requests("diffApproval.preview")).toHaveLength(2);
		expect(requests("diffApproval.resolve")).toHaveLength(1);
	});

	it("blocks duplicate clicks for preview and confirmation while each acknowledgement is pending", async () => {
		const waitPreview = Promise.withResolvers<Envelope>();
		const waitResolve = Promise.withResolvers<Envelope>();
		const ordinary = respond;
		respond = (request) => request.type === "diffApproval.preview" ? waitPreview.promise : request.type === "diffApproval.resolve" ? waitResolve.promise : ordinary(request);
		await render();
		await act(async () => { const action = button("仅撤销本轮改动"); action.click(); action.click(); });
		expect(requests("diffApproval.preview")).toHaveLength(1);
		await act(async () => waitPreview.resolve({ ok: true, result: preview(["op-a"]) }));
		await act(async () => { const action = button("确认撤销可处理文件"); action.click(); action.click(); });
		expect(requests("diffApproval.resolve")).toHaveLength(1);
		await act(async () => waitResolve.resolve({ ok: true, result: { resolved: 1, resolvedIds: ["op-a"], failed: [] } }));
	});

	it("ignores late previews after switching session or workspace", async () => {
		const pending = Promise.withResolvers<Envelope>();
		const ordinary = respond;
		respond = (request) => request.type === "diffApproval.preview" ? pending.promise : ordinary(request);
		await render();
		await click("仅撤销本轮改动");
		await render({ sessionId: "session-b", cwd: "D:/other" });
		await act(async () => pending.resolve({ ok: true, result: preview(["op-a"]) }));
		expect(container.textContent).not.toContain("确认撤销可处理文件");
		expect(container.textContent).not.toContain("original-op-a");
		expect(requests("diffApproval.resolve")).toHaveLength(0);
	});

	it("ignores late list responses from the previous workspace", async () => {
		const pending = Promise.withResolvers<Envelope>();
		const ordinary = respond;
		respond = (request) => request.type === "diffApproval.list" && request.cwd === "D:/project" ? pending.promise : ordinary(request);
		await render();
		await render({ cwd: "D:/other", sessionId: "session-b" });
		await act(async () => pending.resolve({ ok: true, result: { files: [record("op-a")] } }));
		expect(container.textContent).not.toContain("仅撤销本轮改动");
	});

	it("ignores late operation diff and mutation responses after another session replaces the card", async () => {
		const pendingDiff = Promise.withResolvers<Envelope>();
		const pendingMutation = Promise.withResolvers<Envelope>();
		const ordinary = respond;
		respond = (request) => request.type === "diffApproval.diff" ? pendingDiff.promise : request.type === "diffApproval.resolve" ? pendingMutation.promise : ordinary(request);
		await render();
		await click("仅撤销本轮改动");
		await click("审查");
		await click("确认撤销可处理文件");
		await render({ sessionId: "session-b" });
		await act(async () => {
			pendingDiff.resolve({ ok: true, result: { diff: preview(["old-session"]).files[0].diff, truncated: false } });
			pendingMutation.resolve({ ok: true, result: { resolved: 0, resolvedIds: [], failed: [{ path: "old-session", reason: "old failure" }] } });
		});
		expect(container.textContent).not.toContain("old-session");
		expect(container.textContent).not.toContain("old failure");
		expect(container.textContent).not.toContain("撤销未完成");
	});

	it("includes file suboperations only after matching the tool and session provenance", async () => {
		records = [record("one", "a.ts", { toolCallId: "op-a/file-1" }), record("two", "b.ts", { toolCallId: "op-a/file-2" })];
		await render();
		await click("仅撤销本轮改动");
		expect(requests("diffApproval.preview")[0]).toMatchObject({ entryIds: ["one"] });
	});

	it("shows untracked older turns without offering path-based undo, and prevents writes while the agent runs", async () => {
		records = [record("different-tool")];
		await render();
		expect(container.textContent).not.toContain("仅撤销本轮改动");
		records = [record("op-a")];
		await act(async () => changed({ type: "diffApproval.changed", cwd: "D:/project" }));
		await click("仅撤销本轮改动");
		await render({ disabled: true });
		expect(button("确认撤销可处理文件").disabled).toBe(true);
		expect(button("仅撤销本轮改动").disabled).toBe(true);
	});
});

describe("workspace review undo", () => {
	it("previews the full selected batch and keeps conflict feedback after the pushed list refresh", async () => {
		records.push(record("op-b", "b.ts"));
		const ordinary = respond;
		respond = async (request) => request.type === "diffApproval.resolve" ? { ok: true, result: { resolved: 1, resolvedIds: ["op-a"], failed: [{ path: "b.ts", reason: "Permission denied" }] } } : ordinary(request);
		const api = createSidebarApi(client);
		await act(async () => root.render(<ReviewTab api={api} cwd="D:/project" client={client} store={new SidebarStore("D:/project")} tab={{ id: "review", kind: "review", title: "Review" }} onOpenFile={() => {}} gitStatus={undefined} onGitRefresh={() => {}} />));
		const batch = container.querySelector<HTMLButtonElement>('button[title="预览撤销范围"]')!;
		await act(async () => batch.click());
		expect(requests("diffApproval.preview")[0]).toMatchObject({ entryIds: ["op-a", "op-b"] });
		await click("确认撤销可处理文件");
		await act(async () => changed({ type: "diffApproval.changed", cwd: "D:/project" }));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Permission denied");
		expect(container.textContent).toContain("按操作审查工作区改动");
	});
});
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
