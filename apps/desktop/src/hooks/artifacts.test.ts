import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactKindForPath, collectArtifacts, collectHistoricalArtifacts, workspaceArtifactPath } from "./artifacts.ts";
import { rebuild, type ChatEntry, type ToolCard, type ToolStatus } from "./transcript.ts";

function tool(id: string, name: string, path: unknown, status: ToolStatus = "ok"): ToolCard {
	return { id, name, args: JSON.stringify({ path }), summary: name, status };
}

function assistant(tools: ToolCard[]): ChatEntry {
	return { kind: "assistant", text: "报告已经生成 report.md", thinking: "", tools };
}

test("file tools produce outputs only after successful execution, not from prose or shell output", () => {
	const entries = [assistant([
		tool("w", "write", "report.md"),
		tool("failed", "write", "failed.md", "error"),
		tool("running", "write", "running.md", "running"),
		tool("pending", "write", "pending.md", "pending"),
		tool("cancelled", "write", "cancelled.md", "cancelled"),
		tool("read", "read", "input.md"),
		{ ...tool("bash", "bash", "shell.md"), output: { text: "Successfully wrote shell.md", totalLines: 1 } },
		{ ...tool("bad", "write", "bad.md"), args: "invalid json" },
		tool("bad-path", "write", 123),
	])];
	assert.deepEqual(collectArtifacts(entries, "D:/owl").map((artifact) => artifact.path), ["report.md"]);
	assert.deepEqual(collectArtifacts([assistant([])], "D:/owl"), []);
});

test("the current turn is isolated, while a session lists the latest call for each file first", () => {
	const entries: ChatEntry[] = [
		{ kind: "user", text: "上一轮" },
		assistant([tool("old", "write", "REPORT.md"), tool("other", "write", "other.md")]),
		{ kind: "user", text: "继续" },
		assistant([tool("new", "edit", "report.md"), tool("latest", "write", "new.csv")]),
	];
	assert.deepEqual(collectArtifacts(entries, "D:/owl").map((artifact) => artifact.toolId), ["latest", "new"]);
	assert.deepEqual(collectArtifacts(entries, "D:/owl", { scope: "session" }).map((artifact) => artifact.toolId), ["latest", "new", "other"]);
	assert.equal(collectArtifacts(entries, "D:/owl")[1].action, "edited");
	assert.equal(collectArtifacts(entries, "D:/owl")[0].kind, "sheet");
});

test("a new question moves prior deliverables before that question and leaves its footer empty", () => {
	const entries: ChatEntry[] = [
		{ kind: "user", text: "生成报告" },
		assistant([tool("report", "write", "report.md")]),
		{ kind: "user", text: "你是什么模型" },
		assistant([]),
	];
	assert.deepEqual([...collectHistoricalArtifacts(entries, "D:/owl")].map(([beforeIndex, artifacts]) => ({
		beforeIndex, paths: artifacts.map((artifact) => artifact.path),
	})), [{ beforeIndex: 2, paths: ["report.md"] }]);
	assert.deepEqual(collectArtifacts(entries, "D:/owl"), []);
	assert.deepEqual([...collectHistoricalArtifacts(entries.slice(0, 2), "D:/owl")], []);
	assert.equal(collectArtifacts(entries.slice(0, 2), "D:/owl")[0].path, "report.md");
});

test("the same file can belong to several questions without cross-turn deduplication", () => {
	const entries: ChatEntry[] = [
		{ kind: "user", text: "生成报告" },
		assistant([tool("first", "write", "REPORT.md"), tool("first-latest", "edit", "report.md")]),
		{ kind: "user", text: "修改报告" },
		assistant([tool("second", "edit", "report.md")]),
		{ kind: "user", text: "生成表格" },
		assistant([tool("current", "write", "result.xlsx")]),
	];
	assert.deepEqual([...collectHistoricalArtifacts(entries, "D:/owl")].map(([beforeIndex, artifacts]) => ({
		beforeIndex, toolIds: artifacts.map((artifact) => artifact.toolId),
	})), [{ beforeIndex: 2, toolIds: ["first-latest"] }, { beforeIndex: 4, toolIds: ["second"] }]);
	assert.deepEqual(collectArtifacts(entries, "D:/owl").map((artifact) => artifact.toolId), ["current"]);
});

test("restored plugin results retain their original question placement and safe workspace path", () => {
	const entries = rebuild([
		{ role: "user", content: "生成办公文件" },
		{ role: "assistant", content: [{ type: "toolCall", id: "office", name: "univer_export", arguments: {} }] },
		{ role: "toolResult", toolCallId: "office", details: { artifacts: [
			{ path: "D:/owl/费用测试.univer", action: "edited" },
			{ path: "../outside.xlsx", action: "written" },
		] } },
		{ role: "assistant", content: [{ type: "text", text: "请审阅" }] },
		{ role: "user", content: "你是什么模型" },
		{ role: "assistant", content: [{ type: "text", text: "模型信息" }] },
	]);
	assert.deepEqual([...collectHistoricalArtifacts(entries, "D:/owl")].map(([beforeIndex, artifacts]) => ({
		beforeIndex, files: artifacts.map(({ path, action }) => ({ path, action })),
	})), [{ beforeIndex: 3, files: [{ path: "费用测试.univer", action: "edited" }] }]);
	assert.deepEqual(collectArtifacts(entries, "D:/owl"), []);
});

test("user-less prefixes keep their outputs before the first question and empty turns add no cards", () => {
	const prefix = assistant([tool("prefix", "write", "initial.md")]);
	const entries: ChatEntry[] = [prefix, { kind: "user", text: "新问题" }, assistant([]), { kind: "user", text: "再问" }];
	assert.deepEqual([...collectHistoricalArtifacts(entries, "D:/owl")].map(([beforeIndex, artifacts]) => ({
		beforeIndex, toolIds: artifacts.map((artifact) => artifact.toolId),
	})), [{ beforeIndex: 1, toolIds: ["prefix"] }]);
	assert.deepEqual(collectArtifacts([prefix], "D:/owl").map((artifact) => artifact.toolId), ["prefix"]);
	assert.deepEqual([...collectHistoricalArtifacts([prefix], "D:/owl")], []);
	assert.deepEqual([...collectHistoricalArtifacts([], "D:/owl")], []);
});

test("code changes have a separate category and are hidden from general deliverables by default", () => {
	const entries = [assistant([tool("code", "edit", "src/App.tsx"), tool("config", "write", "package.json"), tool("doc", "write", "notes.md")])];
	assert.deepEqual(collectArtifacts(entries, "/workspace").map((artifact) => artifact.path), ["notes.md"]);
	assert.equal(collectArtifacts(entries, "/workspace", { includeCode: true }).length, 3);
	assert.equal(artifactKindForPath("report.PDF"), "document");
	assert.equal(artifactKindForPath("slides.pptx"), "presentation");
	assert.equal(artifactKindForPath("chart.svg"), "image");
});

test("codemode's persisted nested write outcomes survive transcript reconstruction", () => {
	const entries = rebuild([
		{ role: "user", content: "生成报告" },
		{ role: "assistant", content: [{ type: "toolCall", id: "parent", name: "codemode", arguments: {} }] },
		{ role: "toolResult", toolCallId: "parent", content: [{ type: "text", text: "completed" }], nestedCalls: {
			calls: [
				{ id: "written", name: "write", arguments: { path: "report.md", content: "report" }, status: "ok" },
				{ id: "failed", name: "write", arguments: { path: "failed.md" }, status: "error", error: "disk full" },
				{ id: "unfinished", name: "write", arguments: { path: "unfinished.md" }, status: "unfinished" },
			], complete: true,
		} },
	]);
	assert.deepEqual(collectArtifacts(entries, "/workspace").map((artifact) => artifact.toolId), ["written"]);
});

test("sidebar_open requires the real successful response, because its failure is ordinary text", () => {
	const succeeded = { ...tool("opened", "sidebar_open", "D:/owl/report.pdf"), output: { text: "已在侧边栏打开 report.pdf。", totalLines: 1 } };
	const failed = { ...tool("failed", "sidebar_open", "missing.pdf"), output: { text: "文件不存在：missing.pdf", totalLines: 1 } };
	const mismatched = { ...tool("mismatch", "sidebar_open", "wrong.pdf"), output: { text: "已在侧边栏打开 other.pdf。", totalLines: 1 } };
	const nestedWithoutResult = tool("nested", "sidebar_open", "unknown.pdf");
	assert.deepEqual(collectArtifacts([assistant([succeeded, failed, mismatched, nestedWithoutResult])], "D:/owl").map((artifact) => artifact.path), ["report.pdf"]);
	assert.equal(collectArtifacts([assistant([succeeded])], "D:/owl")[0].action, "opened");
});

test("Windows, UNC, POSIX, shell and file URL paths resolve to the same safe wire format", () => {
	assert.equal(workspaceArtifactPath("reports\\summary.md", "D:\\owl"), "reports/summary.md");
	assert.equal(workspaceArtifactPath("d:\\OWL\\reports\\summary.md", "D:/owl/"), "reports/summary.md");
	assert.equal(workspaceArtifactPath("./reports/../summary.md", "D:/owl"), "summary.md");
	assert.equal(workspaceArtifactPath("/D:/owl/summary.md", "D:/owl"), "summary.md");
	assert.equal(workspaceArtifactPath("/mnt/d/owl/summary.md", "D:/owl"), "summary.md");
	assert.equal(workspaceArtifactPath("file:///D:/owl/%E6%8A%A5%E5%91%8A%20%231.md", "D:/owl"), "报告 #1.md");
	assert.equal(workspaceArtifactPath("/D:/owl/%E6%8A%A5%E5%91%8A%20%231.md", "D:/owl", { encoded: true }), "报告 #1.md");
	assert.equal(workspaceArtifactPath("literal%20.md", "D:/owl"), "literal%20.md");
	assert.equal(workspaceArtifactPath("/workspace/Report.md", "/workspace"), "Report.md");
	assert.equal(workspaceArtifactPath("\\\\server\\share\\owl\\report.md", "//SERVER/SHARE/owl"), "report.md");
	assert.equal(workspaceArtifactPath("file://server/share/owl/report.md", "//server/share/owl"), "report.md");
});

test("outside, ambiguous, invalid and URL paths never reach the workspace file API", () => {
	for (const input of ["../outside.md", "reports/../../outside.md", "D:/owl-other/report.md", "E:/owl/report.md", "D:report.md", "/root/report.md", "~/report.md", "https://example.com/report.md", "mailto:user@example.com", "file:///D:/outside.md", "D:/owl", "report.md/", "//?/D:/owl/report.md", "report.md\u0000"]) {
		assert.equal(workspaceArtifactPath(input, "D:/owl"), undefined, input);
	}
	assert.equal(workspaceArtifactPath("/Workspace/report.md", "/workspace"), undefined);
	assert.equal(workspaceArtifactPath("%2e%2e/outside.md", "D:/owl", { encoded: true }), undefined);
	assert.equal(workspaceArtifactPath("%00report.md", "D:/owl", { encoded: true }), undefined);
	assert.equal(workspaceArtifactPath("report%ZZ.md", "D:/owl", { encoded: true }), undefined);
	assert.equal(workspaceArtifactPath("report.md", ""), undefined);
});

test("plugin artifacts survive persisted results and remain scoped to the workspace", () => {
	const entries = rebuild([
		{ role: "user", content: "导出办公文件" },
		{ role: "assistant", content: [{ type: "toolCall", id: "office", name: "univer_export", arguments: { output: "result.xlsx" } }] },
		{ role: "toolResult", toolCallId: "office", content: [{ type: "text", text: "exported" }], details: { artifacts: [
			{ path: "D:/owl/result.xlsx", action: "written" },
			{ path: "../outside.xlsx", action: "written" },
			{ path: "https://example.com/fake.xlsx", action: "written" },
			{ path: "bad.xlsx", action: "invalid" },
			null,
		] } },
	]);
	assert.deepEqual(collectArtifacts(entries, "D:/owl").map(({ path, kind, action }) => ({ path, kind, action })), [
		{ path: "result.xlsx", kind: "sheet", action: "written" },
	]);
	const failed = rebuild([
		{ role: "assistant", content: [{ type: "toolCall", id: "failed", name: "univer_export", arguments: {} }] },
		{ role: "toolResult", toolCallId: "failed", isError: true, details: { artifacts: [{ path: "failed.xlsx", action: "written" }] } },
	]);
	assert.deepEqual(collectArtifacts(failed, "D:/owl"), []);
});
