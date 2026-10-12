import { createHash } from "node:crypto";
import type * as fileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/index.ts";
import { normalizeResearchResult } from "../src/core/research/agent.ts";
import type { ResearchReaClient } from "../src/core/research/rea-client.ts";
import { createResearchReaTool } from "../src/core/research/rea-tools.ts";
import type { ResearchResult } from "../src/core/research/types.ts";

const roots: string[] = [];
const ownerSessionId = "test-research-session";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const evidenceId = `ev_${"a".repeat(64)}`;
const persistence = vi.hoisted(() => ({ abort: undefined as AbortController | undefined }));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fileSystem>();
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof fileSystem.writeFile>) => {
			await actual.writeFile(...args);
			if (typeof args[0] === "string" && args[0].endsWith("report.json"))
				persistence.abort?.abort(new Error("cancel during final report"));
		},
	};
});

afterEach(async () => {
	persistence.abort = undefined;
	for (const root of roots.splice(0)) {
		if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("owl-rea-tools-"))
			throw new Error("Unsafe fixture cleanup");
		await rm(root, { recursive: true, force: true });
	}
});

async function workspace() {
	const root = await mkdtemp(join(tmpdir(), "owl-rea-tools-"));
	roots.push(root);
	return root;
}

function context(cwd: string, sessionId = ownerSessionId): ExtensionToolContext {
	return { cwd, sessionManager: { getSessionId: () => sessionId } } as ExtensionToolContext;
}

function backend(result: CallToolResult) {
	const call = vi.fn<ResearchReaClient["call"]>(async (name, params) => {
		if (name === "open_binary") return { content: [], structuredContent: { result: { opened: true } } };
		if (name === "export_evidence_bundle") {
			await writeFile(String(params.path), JSON.stringify({ records: [result.structuredContent], complete: true }), {
				flag: "wx",
			});
			return { content: [], structuredContent: { result: { path: params.path } } };
		}
		return result;
	});
	return {
		ownerSessionId,
		call,
		inventory: vi.fn<ResearchReaClient["inventory"]>(async () => ({
			status: "available",
			version: "6.4.0",
			configPath: "synthetic-host-config",
			message: "synthetic installed backend",
		})),
		close: vi.fn<ResearchReaClient["close"]>(async () => ({ status: "complete", ownerSessionId, errors: [] })),
	};
}

function observed(subjectHash = hash("fixture")): CallToolResult {
	return {
		content: [{ type: "text", text: "original provider text" }],
		structuredContent: {
			evidence_id: evidenceId,
			subject: { digest: { sha256: subjectHash } },
			normalized_result: {
				procedures: 2,
				pseudocode: "int entry(void) { return 2; }",
				limitations: ["static coverage"],
			},
			limitations: ["未进行运行时验证"],
			raw_result: { original: true },
		},
	};
}

describe("research-only REA adapter and evidence persistence", () => {
	it("selects one JavaScript source, saves complete response and bundle, and publishes a valid evidence card", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "business.js"), "export const search = (q) => q.trim();");
		const client = backend(observed());
		const tool = createResearchReaTool(client);
		const result = await tool.execute(
			"js",
			{ action: "javascript", path: "business.js" },
			undefined,
			undefined,
			context(cwd),
		);
		expect(client.call.mock.calls[0][0]).toBe("analyze_javascript_application");
		const params = client.call.mock.calls[0][1];
		expect(params).toMatchObject({ detail: "summary" });
		expect(params).not.toHaveProperty("source_paths");
		expect(await readFile(join(String(params.input_path), "business.js"), "utf8")).toBe(
			"export const search = (q) => q.trim();",
		);
		const details = result.details as {
			researchResult: ResearchResult;
			researchRea: { artifacts: Array<{ path: string; sha256: string }>; targetExecuted: boolean };
		};
		const { id, createdAt, ...cardInput } = details.researchResult;
		expect(id).toBeTruthy();
		expect(createdAt).toBeTruthy();
		expect(normalizeResearchResult(cardInput)).toMatchObject({ mode: "web", status: "partial" });
		expect(details.researchRea.targetExecuted).toBe(false);
		const response = details.researchRea.artifacts.find((artifact) => artifact.path.endsWith("response.json"));
		if (!response) throw new Error("Missing raw response");
		const raw = await readFile(response.path, "utf8");
		expect(JSON.parse(raw)).toEqual(observed());
		expect(hash(raw)).toBe(response.sha256);
		expect(details.researchRea.artifacts.some((artifact) => artifact.path.endsWith("session-evidence.json"))).toBe(
			true,
		);
		expect(details.researchResult.findings.some((finding) => finding.kind === "unverified")).toBe(true);
		await expect(
			tool.execute("file-view", { action: "view", evidenceId }, undefined, undefined, context(cwd)),
		).resolves.toHaveProperty("details.researchResult");
	});

	it("binds every native function query to the selected file and its observed digest", async () => {
		const cwd = await workspace();
		const path = join(cwd, "toy.exe");
		await writeFile(path, "fixture");
		const client = backend(observed());
		await createResearchReaTool(client).execute(
			"native",
			{ action: "native_function", path, procedure: "0x1000" },
			undefined,
			undefined,
			context(cwd),
		);
		expect(client.call.mock.calls.slice(0, 2).map((call) => call.slice(0, 2))).toMatchObject([
			["open_binary", { path: await realpath(path), provider_id: "ghidra" }],
			["analyze_function", { procedure: "0x1000" }],
		]);
		const mismatch = backend(observed("b".repeat(64)));
		await expect(
			createResearchReaTool(mismatch).execute(
				"stale",
				{ action: "native_overview", path },
				undefined,
				undefined,
				context(cwd),
			),
		).rejects.toThrow("不同输入哈希");
	});

	it("rejects cross-session reuse, runtime actions, relative escapes, and JSC before calling REA", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "index.jsc"), "synthetic bytecode");
		const client = backend(observed());
		const tool = createResearchReaTool(client);
		await expect(
			tool.execute("scope", { action: "inventory" }, undefined, undefined, context(cwd, "ordinary")),
		).rejects.toThrow("不属于当前研究会话");
		await expect(
			tool.execute("runtime", { action: "capture_process" as "inventory" }, undefined, undefined, context(cwd)),
		).rejects.toThrow("参数无效");
		await expect(
			tool.execute("escape", { action: "javascript", path: "../outside.js" }, undefined, undefined, context(cwd)),
		).rejects.toThrow("超出工作区");
		await expect(
			tool.execute("jsc", { action: "javascript", path: "index.jsc" }, undefined, undefined, context(cwd)),
		).rejects.toThrow("research_decompile");
		expect(client.call).not.toHaveBeenCalled();
	});

	it("only resolves evidence retained in this tool's own session and invalidates it on close", async () => {
		const cwd = await workspace();
		await mkdir(join(cwd, "app"));
		const client = backend(observed());
		const tool = createResearchReaTool(client);
		await expect(
			tool.execute("unknown", { action: "view", evidenceId }, undefined, undefined, context(cwd)),
		).rejects.toThrow("当前会话已返回");
		await tool.execute("produce", { action: "javascript", path: "app" }, undefined, undefined, context(cwd));
		await tool.execute(
			"view",
			{ action: "view", evidenceId, view: "modules", offset: 32, limit: 16 },
			undefined,
			undefined,
			context(cwd),
		);
		expect(client.call.mock.calls.find(([name]) => name === "inspect_analysis_view")?.[1]).toEqual({
			source: { kind: "retained-evidence", evidence_id: evidenceId },
			view: { kind: "page", collection: "modules", offset: 32, limit: 16 },
		});
		await tool.execute("close", { action: "close" }, undefined, undefined, context(cwd));
		await expect(
			tool.execute("cleared", { action: "view", evidenceId }, undefined, undefined, context(cwd)),
		).rejects.toThrow("当前会话已返回");
	});

	it("keeps raw typed failures without publishing successful cards", async () => {
		const cwd = await workspace();
		await mkdir(join(cwd, "app"));
		const client = backend({
			isError: true,
			content: [{ type: "text", text: JSON.stringify({ error: { code: "unsupported_target" } }) }],
		});
		await expect(
			createResearchReaTool(client).execute(
				"fail",
				{ action: "javascript", path: "app" },
				undefined,
				undefined,
				context(cwd),
			),
		).rejects.toThrow("完整诊断已保存");
		const records = await readdir(join(cwd, ".owl", "research", "rea"), { recursive: true });
		expect(records.filter((path) => String(path).endsWith("response.json"))).toHaveLength(1);
		expect(records.some((path) => String(path).endsWith("report.json"))).toBe(false);
	});

	it("rejects a linked artifact output directory instead of writing beyond the workspace", async () => {
		const cwd = await workspace();
		const outside = await workspace();
		await mkdir(join(cwd, "app"));
		await symlink(outside, join(cwd, ".owl"), process.platform === "win32" ? "junction" : "dir");
		const client = backend(observed());
		await expect(
			createResearchReaTool(client).execute(
				"link",
				{ action: "javascript", path: "app" },
				undefined,
				undefined,
				context(cwd),
			),
		).rejects.toThrow("包含链接");
		expect(await readdir(outside)).toEqual([]);
		expect(client.call).not.toHaveBeenCalled();
	});

	it("reports export gaps as partial and does not turn a cancelled call into a completed card", async () => {
		const cwd = await workspace();
		await mkdir(join(cwd, "app"));
		const client = backend(observed());
		client.call.mockImplementation(async (name) =>
			name === "export_evidence_bundle"
				? { isError: true, content: [{ type: "text", text: "export failed" }] }
				: observed(),
		);
		const result = await createResearchReaTool(client).execute(
			"export",
			{ action: "javascript", path: "app" },
			undefined,
			undefined,
			context(cwd),
		);
		expect(
			(result.details as { researchResult: ResearchResult }).researchResult.findings.some((item) =>
				item.text.includes("导出失败"),
			),
		).toBe(true);
		const controller = new AbortController();
		controller.abort();
		await expect(
			createResearchReaTool(client).execute(
				"cancel",
				{ action: "javascript", path: "app" },
				controller.signal,
				undefined,
				context(cwd),
			),
		).rejects.toThrow();
	});

	it("binds summary views to parent Evidence and uses the native facet contract for function views", async () => {
		const cwd = await workspace();
		await mkdir(join(cwd, "app"));
		const parent = `ev_${"b".repeat(64)}`;
		const client = backend({
			content: [],
			structuredContent: {
				evidence_id: evidenceId,
				normalized_result: { parent_evidence_id: parent, summary: "observed application" },
			},
		});
		const tool = createResearchReaTool(client);
		const js = await tool.execute("js", { action: "javascript", path: "app" }, undefined, undefined, context(cwd));
		expect((js.details as { researchRea: { evidenceId: string } }).researchRea.evidenceId).toBe(parent);
		await tool.execute("view", { action: "view", evidenceId: parent }, undefined, undefined, context(cwd));
		expect(client.call.mock.calls.find(([name]) => name === "inspect_analysis_view")?.[1]).toMatchObject({
			source: { evidence_id: parent },
		});
		await writeFile(join(cwd, "toy.exe"), "fixture");
		const native = backend(observed());
		const nativeTool = createResearchReaTool(native);
		await nativeTool.execute(
			"function",
			{ action: "native_function", path: "toy.exe", procedure: "0x1000" },
			undefined,
			undefined,
			context(cwd),
		);
		const card = await nativeTool.execute(
			"pseudocode",
			{ action: "view", evidenceId, view: "pseudocode" },
			undefined,
			undefined,
			context(cwd),
		);
		expect(native.call.mock.calls.find(([name]) => name === "inspect_analysis_view")?.[1]).toMatchObject({
			view: { kind: "native", facet: "pseudocode" },
		});
		expect((card.details as { researchResult: ResearchResult }).researchResult.mode).toBe("binary");
		await expect(
			nativeTool.execute(
				"wrong-view",
				{ action: "view", evidenceId, view: "modules" },
				undefined,
				undefined,
				context(cwd),
			),
		).rejects.toThrow("原生函数证据");
	});

	it("copies only selected directory sources and never recurses into its own workspace evidence", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "main.js"), "export const value = 42;");
		await writeFile(join(cwd, "unselected.js"), "export const privateValue = 7;");
		const client = backend(observed());
		const tool = createResearchReaTool(client);
		await tool.execute(
			"selected",
			{ action: "javascript", path: cwd, sourcePaths: ["main.js"] },
			undefined,
			undefined,
			context(cwd),
		);
		const selected = String(client.call.mock.calls[0][1].input_path);
		expect(await readdir(selected)).toEqual(["main.js"]);
		await tool.execute("workspace", { action: "javascript", path: cwd }, undefined, undefined, context(cwd));
		const sourceCall = client.call.mock.calls.filter(([name]) => name === "analyze_javascript_application")[1];
		expect((await readdir(String(sourceCall[1].input_path))).sort()).toEqual(["main.js", "unselected.js"]);
	});

	it("does not publish or retain a result cancelled while its final report is being written", async () => {
		const cwd = await workspace();
		await mkdir(join(cwd, "app"));
		const controller = new AbortController();
		persistence.abort = controller;
		const tool = createResearchReaTool(backend(observed()));
		await expect(
			tool.execute("late-cancel", { action: "javascript", path: "app" }, controller.signal, undefined, context(cwd)),
		).rejects.toThrow("cancel during final report");
		persistence.abort = undefined;
		await expect(
			tool.execute("cancelled-evidence", { action: "view", evidenceId }, undefined, undefined, context(cwd)),
		).rejects.toThrow("当前会话已返回");
	});
});
