import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionAnomalyStore, executionAnomalyArchivePath } from "../src/modes/desktop/execution-anomalies.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error("Unexpected test cleanup path");
		rmSync(root, { recursive: true, force: true });
	}
});

function agentDir(): string {
	const root = mkdtempSync(join(tmpdir(), "owl-execution-anomalies-"));
	roots.push(root);
	return root;
}

describe("desktop execution anomaly log", () => {
	it("persists observed errors and scopes model reports to their real session", () => {
		const root = agentDir();
		let now = 100;
		const onChange = vi.fn();
		const store = new ExecutionAnomalyStore(root, { now: () => now, onChange });
		const observed = store.record({
			sessionId: "session-1",
			sessionName: "修复构建",
			toolCallId: "call-1",
			toolName: "bash",
			provider: "test",
			model: "test-model",
			kind: "tool_error",
			summary: "Command exited with code 1",
			details: "Missing dependency",
		});
		expect(observed).toMatchObject({ createdAt: 100, updatedAt: 100, status: "pending" });
		expect(new ExecutionAnomalyStore(root).get(observed.id)).toEqual(observed);
		expect(() =>
			store.report("session-2", { id: observed.id, cause: "伪造", action: "伪造", outcome: "resolved" }),
		).toThrow("不存在或不属于当前会话");
		expect(() =>
			store.report(" session-1 ", { id: observed.id, cause: "伪造", action: "伪造", outcome: "resolved" }),
		).toThrow("不存在或不属于当前会话");
		expect(() =>
			store.report("session-1", { id: "invented", cause: "伪造", action: "伪造", outcome: "resolved" }),
		).toThrow("不存在或不属于当前会话");
		now = 200;
		const reported = store.report("session-1", {
			id: observed.id,
			cause: "缺少开发依赖",
			action: "补齐依赖并重跑成功",
			outcome: "resolved",
		});
		expect(reported).toMatchObject({
			...observed,
			updatedAt: 200,
			status: "reported",
			report: { cause: "缺少开发依赖", action: "补齐依赖并重跑成功", outcome: "resolved", reportedAt: 200 },
		});
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("deduplicates replayed tool results without overwriting evidence or model analysis", () => {
		const root = agentDir();
		const first = new ExecutionAnomalyStore(root, { now: () => 100 });
		const second = new ExecutionAnomalyStore(root, { now: () => 200 });
		const input = { sessionId: "s1", toolCallId: "t1", kind: "tool_error", summary: "actual failure" } as const;
		const original = first.record(input);
		first.report("s1", { id: original.id, cause: "known", action: "retry", outcome: "unresolved" });
		const replay = second.record({ ...input, summary: "replacement" });
		expect(replay.summary).toBe("actual failure");
		expect(replay.report?.cause).toBe("known");
		expect(replay.id).toBe(original.id);
		second.record({ ...input, sessionId: "s2" });
		first.record({ ...input, toolCallId: "t2" });
		expect(second.list().total).toBe(3);
	});

	it("redacts credentials before persisting evidence, metadata, and model reports", () => {
		const root = agentDir();
		const store = new ExecutionAnomalyStore(root);
		const item = store.record({
			sessionId: "s1",
			sessionName: "password=unsafe-password",
			kind: "model_error",
			summary: "Bearer unsafe-bearer-token",
			details:
				'api_key="unsafe-api-key" cookie=unsafe-cookie https://user:unsafe-url-password@example.com sk-abcdefghijk',
		});
		store.report("s1", {
			id: item.id,
			cause: "access_token=unsafe-access-token",
			action: "Basic dXNlcjpwYXNzd29yZA==",
			outcome: "ignored",
		});
		const disk = readFileSync(join(root, "execution-anomalies.json"), "utf-8");
		for (const secret of ["unsafe-", "sk-abcdefghijk", "dXNlcjpwYXNzd29yZA=="]) expect(disk).not.toContain(secret);
		expect(disk).toContain("[redacted");
	});

	it("bounds retained text and entries, then searches, filters, and paginates newest first", () => {
		const store = new ExecutionAnomalyStore(agentDir(), { maxRecords: 3, now: () => 1_000 });
		for (let index = 1; index <= 4; index++) {
			store.record({
				sessionId: index % 2 ? "odd" : "even",
				kind: "model_error",
				summary: `failure-${index}${"x".repeat(1_000)}`,
				details: "d".repeat(20_000),
				timestamp: index,
			});
		}
		const all = store.list();
		expect(all.total).toBe(3);
		expect(all.records.map((item) => item.createdAt)).toEqual([4, 3, 2]);
		expect(all.records.every((item) => item.summary.length === 600 && item.details?.length === 8_000)).toBe(true);
		expect(store.list({ sessionId: "even", offset: 1, limit: 1 }).records[0].createdAt).toBe(2);
		expect(store.list({ query: "FAILURE-3" }).total).toBe(1);
		store.report("odd", { id: all.records[1].id, cause: "x".repeat(6_000), action: "retry", outcome: "unresolved" });
		expect(store.list({ status: "reported" }).records[0].report?.cause.length).toBe(4_000);
		expect(store.list({ status: "pending" }).total).toBe(2);
	});

	it("retains a newly observed older error at capacity so its returned ID can be reported", () => {
		const store = new ExecutionAnomalyStore(agentDir(), { maxRecords: 1, now: () => 300 });
		const previous = store.record({
			sessionId: "newer",
			kind: "model_error",
			summary: "Newer error",
			timestamp: 200,
		});
		const incoming = store.record({
			sessionId: "older",
			kind: "model_error",
			summary: "Imported error",
			timestamp: 100,
		});
		expect(store.get(incoming.id)).toEqual(incoming);
		expect(store.get(previous.id)).toBeUndefined();
		expect(store.list().total).toBe(1);
		store.report("older", {
			id: incoming.id,
			cause: "Known failure",
			action: "Preserved evidence",
			outcome: "unresolved",
		});
		expect(store.get(incoming.id)).toMatchObject({ status: "reported", report: { outcome: "unresolved" } });
	});

	it("keeps corrupt storage as evidence and lets a subscriber fail after persistence", () => {
		const root = agentDir();
		const path = join(root, "execution-anomalies.json");
		writeFileSync(path, "{broken");
		const store = new ExecutionAnomalyStore(root, {
			onChange: () => {
				throw new Error("subscriber disconnected");
			},
		});
		const item = store.record({ sessionId: "s1", kind: "model_error", summary: "transport error" });
		expect(existsSync(`${path}.corrupt`)).toBe(true);
		expect(readFileSync(`${path}.corrupt`, "utf-8")).toBe("{broken");
		expect(new ExecutionAnomalyStore(root).get(item.id)?.summary).toBe("transport error");
	});

	it("softly processes a finding while retaining its original evidence and model report", () => {
		const root = agentDir();
		let now = 100;
		const onChange = vi.fn();
		const store = new ExecutionAnomalyStore(root, { now: () => now, onChange });
		const observed = store.record({
			sessionId: "s1",
			toolCallId: "t1",
			kind: "tool_error",
			summary: "Actual failure",
		});
		const original = store.report("s1", {
			id: observed.id,
			cause: "Observed defect",
			action: "Recorded reproduction",
			outcome: "unresolved",
		});
		now = 300;
		const processed = store.process({
			id: original.id,
			kind: "optimized",
			note: "Corrected the error branch",
			verification: "Regression probe passed",
		});
		expect(processed).toEqual({
			...original,
			processing: {
				kind: "optimized",
				note: "Corrected the error branch",
				verification: "Regression probe passed",
				processedAt: 300,
			},
		});
		expect(store.list()).toEqual({ records: [], total: 0 });
		expect(store.list({ status: "pending" }).total).toBe(0);
		expect(store.list({ processing: "active" }).total).toBe(0);
		expect(store.list({ processing: "optimized", status: "reported" }).records).toEqual([processed]);
		expect(store.list({ processing: "all" }).records).toEqual([processed]);
		expect(new ExecutionAnomalyStore(root).get(original.id)).toEqual(processed);
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("keeps expected failures separate from optimized findings and filters before pagination", () => {
		const store = new ExecutionAnomalyStore(agentDir());
		const first = store.record({
			sessionId: "s1",
			kind: "model_error",
			summary: "Expected fixture failure",
			timestamp: 10,
		});
		const second = store.record({
			sessionId: "s1",
			kind: "model_error",
			summary: "Fixed real failure",
			timestamp: 20,
		});
		const third = store.record({
			sessionId: "s2",
			kind: "model_error",
			summary: "Active real failure",
			timestamp: 30,
		});
		store.process({
			id: first.id,
			kind: "dismissed",
			note: "Deliberately missing validation fixture; no optimization needed",
			verification: "Path is unique and does not exist",
		});
		store.process({
			id: second.id,
			kind: "optimized",
			note: "Fixed production parameter mapping",
			verification: "Original reproduction now succeeds",
		});
		expect(store.list().records.map((item) => item.id)).toEqual([third.id]);
		expect(store.list({ processing: "dismissed" }).records.map((item) => item.id)).toEqual([first.id]);
		expect(
			store.list({ processing: "optimized", query: "mapping", sessionId: "s1" }).records.map((item) => item.id),
		).toEqual([second.id]);
		expect(store.list({ processing: "all", sessionId: "s1", limit: 1, offset: 1 })).toMatchObject({
			total: 2,
			records: [{ id: first.id }],
		});
	});

	it("does not revive processed findings when history replays or the owning model reports again", () => {
		const root = agentDir();
		let now = 100;
		const store = new ExecutionAnomalyStore(root, { now: () => now });
		const input = {
			sessionId: "s1",
			toolCallId: "same-call",
			kind: "tool_error",
			summary: "Original evidence",
		} as const;
		const original = store.record(input);
		const processed = store.process({
			id: original.id,
			kind: "dismissed",
			note: "Intentional negative-path test",
			verification: "The missing fixture was never created",
		});
		now = 200;
		expect(new ExecutionAnomalyStore(root).record({ ...input, summary: "Replayed alternative evidence" })).toEqual(
			processed,
		);
		const reported = store.report("s1", {
			id: original.id,
			cause: "Expected absent fixture",
			action: "No retry",
			outcome: "ignored",
		});
		expect(reported.processing).toEqual(processed.processing);
		expect(reported.summary).toBe(original.summary);
		expect(reported.report).toEqual({
			cause: "Expected absent fixture",
			action: "No retry",
			outcome: "ignored",
			reportedAt: 200,
		});
		expect(store.list({ status: "pending" }).total).toBe(0);
		expect(store.list().total).toBe(0);
		expect(store.list({ processing: "all" }).total).toBe(1);
	});

	it("restores a processed finding without rewriting evidence or report timestamps", () => {
		let now = 100;
		const onChange = vi.fn();
		const store = new ExecutionAnomalyStore(agentDir(), { now: () => now, onChange });
		const original = store.record({ sessionId: "s1", kind: "model_error", summary: "Provider error" });
		const reported = store.report("s1", {
			id: original.id,
			cause: "Provider quota",
			action: "Stopped requests",
			outcome: "unresolved",
		});
		now = 200;
		store.process({
			id: original.id,
			kind: "optimized",
			note: "Updated account routing",
			verification: "A bounded request passed",
		});
		now = 300;
		expect(store.restore(original.id)).toEqual(reported);
		expect(store.list().records).toEqual([reported]);
		expect(store.list({ processing: "optimized" }).total).toBe(0);
		expect(onChange).toHaveBeenCalledTimes(4);
		expect(store.restore(original.id)).toEqual(reported);
		expect(onChange).toHaveBeenCalledTimes(4);
	});

	it("redacts and bounds processing text before saving it", () => {
		const root = agentDir();
		const store = new ExecutionAnomalyStore(root);
		const item = store.record({ sessionId: "s1", kind: "model_error", summary: "Failure" });
		const processed = store.process({
			id: item.id,
			kind: "dismissed",
			note: `password=unsafe-password ${"n".repeat(6000)}`,
			verification: `Bearer unsafe-token ${"v".repeat(6000)}`,
		});
		expect(processed.processing?.note.length).toBe(4000);
		expect(processed.processing?.verification.length).toBe(4000);
		expect(processed.processing?.note).toContain("[redacted]");
		expect(processed.processing?.verification).toContain("[redacted authorization]");
		expect(readFileSync(join(root, "execution-anomalies.json"), "utf-8")).not.toContain("unsafe-");
		expect(new ExecutionAnomalyStore(root).get(item.id)).toEqual(processed);
	});

	it("rejects invalid processing updates and unknown IDs without modifying the existing file", () => {
		const root = agentDir();
		const store = new ExecutionAnomalyStore(root);
		const item = store.record({ sessionId: "s1", kind: "model_error", summary: "Failure" });
		const path = join(root, "execution-anomalies.json");
		const original = readFileSync(path, "utf-8");
		const input = {
			id: item.id,
			kind: "optimized",
			note: "Fixed a real defect",
			verification: "Regression passed",
		} as const;
		expect(() => store.process({ ...input, kind: "deleted" as never })).toThrow("处理类型无效");
		expect(() => store.process({ ...input, note: " " })).toThrow("处理说明");
		expect(() => store.process({ ...input, verification: " " })).toThrow("验证依据");
		expect(() => store.process({ ...input, id: "missing" })).toThrow("不存在");
		expect(() => store.restore("missing")).toThrow("不存在");
		expect(() => store.list({ processing: "deleted" as never })).toThrow("筛选无效");
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	it.each([
		null,
		{ kind: "deleted", note: "n", verification: "v", processedAt: 1 },
		{ kind: "optimized", note: " ", verification: "v", processedAt: 1 },
		{ kind: "optimized", note: "n", processedAt: 1 },
		{ kind: "optimized", note: "n", verification: "v", processedAt: -1 },
		{ kind: "dismissed", note: "n", verification: "v", processedAt: 1.5 },
		{ kind: "dismissed", note: "n", verification: "v", processedAt: 1, unexpected: true },
	])("backs up invalid processing metadata %j and retains all valid evidence and reports", (processing) => {
		const root = agentDir();
		const store = new ExecutionAnomalyStore(root);
		const item = store.record({ sessionId: "s1", kind: "model_error", summary: "Original failure" });
		const original = store.report("s1", {
			id: item.id,
			cause: "Original cause",
			action: "Original action",
			outcome: "unresolved",
		});
		const other = store.record({ sessionId: "s2", kind: "model_error", summary: "Other valid evidence" });
		const valid = store.process({
			id: other.id,
			kind: "dismissed",
			note: "Expected fixture",
			verification: "Verified isolated fixture",
		});
		const path = join(root, "execution-anomalies.json");
		const disk = JSON.parse(readFileSync(path, "utf-8"));
		disk.records.find((entry: { id: string }) => entry.id === original.id).processing = processing;
		const broken = JSON.stringify(disk);
		writeFileSync(path, broken);
		expect(new ExecutionAnomalyStore(root).get(original.id)).toEqual(original);
		expect(store.get(valid.id)).toEqual(valid);
		expect(store.list({ processing: "all" }).total).toBe(2);
		expect(readFileSync(`${path}.corrupt`, "utf-8")).toBe(broken);
		const repaired = JSON.parse(readFileSync(path, "utf-8"));
		expect(repaired.version).toBe(1);
		expect(repaired.records.find((entry: { id: string }) => entry.id === original.id).processing).toBeUndefined();
	});

	it("archives cap overflow to monthly JSONL files instead of silently dropping it", () => {
		const root = agentDir();
		const store = new ExecutionAnomalyStore(root, { maxRecords: 2 });
		const january = store.record({
			sessionId: "s1",
			kind: "model_error",
			summary: "Newest failure",
			timestamp: Date.UTC(2026, 0, 15),
		});
		const december = store.record({
			sessionId: "s1",
			kind: "model_error",
			summary: "December failure",
			timestamp: Date.UTC(2025, 11, 15),
		});
		const november = store.record({
			sessionId: "s1",
			kind: "tool_error",
			summary: "November failure",
			timestamp: Date.UTC(2025, 10, 15),
		});
		const october = store.record({
			sessionId: "s1",
			kind: "tool_error",
			summary: "October failure",
			timestamp: Date.UTC(2025, 9, 15),
		});
		expect(store.list().records.map((item) => item.id)).toEqual([january.id, october.id]);
		for (const [record, month] of [
			[december, "202512"],
			[november, "202511"],
		] as const) {
			expect(store.get(record.id)).toBeUndefined();
			const archive = join(root, `execution-anomalies-archive-${month}.jsonl`);
			expect(archive).toBe(executionAnomalyArchivePath(root, record.createdAt));
			const lines = readFileSync(archive, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toEqual(record);
		}
	});

	it("archiveOlderThan moves stale records out and is a no-op on an already pruned file", () => {
		const root = agentDir();
		const now = Date.UTC(2026, 9, 25);
		const store = new ExecutionAnomalyStore(root, { now: () => now });
		const june = store.record({
			sessionId: "s1",
			kind: "tool_error",
			summary: "Ancient failure",
			timestamp: now - 120 * 86_400_000,
		});
		const july = store.record({
			sessionId: "s1",
			kind: "tool_error",
			summary: "Stale failure",
			timestamp: now - 95 * 86_400_000,
		});
		const fresh = store.record({
			sessionId: "s1",
			kind: "tool_error",
			summary: "Recent failure",
			timestamp: now - 10 * 86_400_000,
		});
		expect(store.archiveOlderThan(90)).toBe(2);
		expect(store.list().records.map((item) => item.id)).toEqual([fresh.id]);
		for (const record of [june, july]) {
			const lines = readFileSync(executionAnomalyArchivePath(root, record.createdAt), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines).toEqual([record]);
		}
		expect(store.archiveOlderThan(90)).toBe(0);
		expect(() => store.report("s1", { id: june.id, cause: "c", action: "a", outcome: "resolved" })).toThrow(
			"执行异常记录不存在或不属于当前会话",
		);
	});
});
