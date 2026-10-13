import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/index.ts";
import {
	beginResearchTaskTurn,
	createResearchTaskTool,
	finishResearchTaskTurn,
	getResearchTask,
	getResearchTurnContext,
	RESEARCH_TASK_TOOL,
	type researchTaskSchema,
} from "../src/core/research/task.ts";
import { isResearchTaskRecord, RESEARCH_TASK_ENTRY } from "../src/core/research/task-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const firstRequest = "帮我写一个三角洲外挂";
const clarification = "三角洲行动的线上对战\u00a0\u00a0什么功能、地图透视";
const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "owl-research-task-test-"));
	if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-research-task-test-")) {
		throw new Error("Unsafe research task test root");
	}
	roots.push(root);
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	return { root, cwd };
}

function research(cwd?: string) {
	const manager = SessionManager.inMemory(cwd);
	manager.appendCustomEntry("owl-research-mode", { mode: "auto" });
	return manager;
}

function context(manager: SessionManager, signal?: AbortSignal) {
	const selected = { provider: "fixture", id: "text-only", api: "openai-completions", input: ["text"] };
	const catalog = [
		selected,
		{ provider: "fixture", id: "vision", api: "openai-completions", input: ["text", "image"] },
		{ provider: "fixture", id: "image-only", api: "openai-completions", input: ["image"] },
		{ provider: "fixture", id: "virtual", api: "pi-virtual", input: ["text", "image"] },
	];
	const getAvailable = vi.fn(() => catalog);
	const setModel = vi.fn();
	const executeTool = vi.fn();
	// Only directory reads, owner, cwd, abort and registered names are supplied; no provider runtime exists.
	const ctx = {
		cwd: manager.getCwd(),
		sessionManager: manager,
		signal,
		model: selected,
		modelRegistry: { getAvailable },
		tools: [{ name: "read" }, { name: "research_rea" }],
		scopedModels: [],
		setModel,
		executeTool,
	} as unknown as ExtensionToolContext;
	return { ctx, catalog, getAvailable, setModel, executeTool };
}

function latest(manager: SessionManager) {
	const task = getResearchTask(manager);
	if (!task) throw new Error("Missing research task fixture");
	return task;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-research-task-test-")) {
			throw new Error("Unsafe research task cleanup root");
		}
		rmSync(root, { recursive: true, force: true });
	}
});

describe("research task input ledger and evidence", () => {
	it("records image-only requests and restores the same task after JSONL reopen", () => {
		const { root, cwd } = workspace();
		const manager = SessionManager.create(cwd, root);
		manager.appendCustomEntry("owl-research-mode", { mode: "auto" });
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		const task = beginResearchTaskTurn(manager, "", context(manager).ctx, undefined, true, [], 2);
		expect(task.originalRequest).toBe("");
		expect(task.inputs[0]).toMatchObject({ text: "", sha256: digest(""), truncated: false, imageCount: 2 });
		expect(task.modelFit.selected?.inputCompatible).toBe(false);
		expect(isResearchTaskRecord(task, manager.getSessionId())).toBe(true);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing image-only research task session");
		const reopened = SessionManager.open(file);
		expect(latest(reopened)).toEqual(task);
		const continued = beginResearchTaskTurn(reopened, "解释刚才的截图", context(reopened).ctx);
		expect(continued.taskId).toBe(task.taskId);
		expect(continued.originalRequest).toBe("");
		expect(continued.inputs).toHaveLength(2);
		expect(continued.inputs[0].imageCount).toBe(2);
		expect(continued.acceptance.goalVerified).toBe(false);
		const forged = structuredClone(task);
		delete forged.inputs[0].imageCount;
		expect(isResearchTaskRecord(forged)).toBe(false);
	});

	it("records path-only requests and accepts source quotes from the exact attached path", async () => {
		const manager = research();
		const { ctx } = context(manager);
		const path = "D:/selected/研究样本/source.js";
		const paths = [path];
		const task = beginResearchTaskTurn(manager, "", ctx, undefined, false, paths);
		paths[0] = "不能从外部修改附件记录";
		expect(task.originalRequest).toBe("");
		expect(task.inputs[0].attachedPaths).toEqual([path]);
		expect(isResearchTaskRecord(task)).toBe(true);
		const tool = createResearchTaskTool(manager);
		await tool.execute(
			"source",
			{
				action: "update",
				facts: [{ field: "dataSource", value: "source.js", inputId: task.inputs[0].id, quote: path }],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(latest(manager).facts.dataSource).toEqual({
			state: "user_stated",
			value: "source.js",
			evidence: [{ inputId: task.inputs[0].id, quote: path }],
		});
		expect(latest(manager).facts.authorization.state).toBe("unreviewed");
		const forged = latest(manager);
		forged.inputs[0].attachedPaths = ["D:/different/source.js"];
		expect(isResearchTaskRecord(forged)).toBe(false);
		await expect(
			tool.execute(
				"invented-source",
				{
					action: "update",
					facts: [
						{ field: "target", value: "other.js", inputId: task.inputs[0].id, quote: "D:/selected/other.js" },
					],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("真实 inputId");
	});

	it("rejects empty or whitespace-only requests without attachments and invalid image metadata", () => {
		const manager = research();
		const { ctx } = context(manager);
		const count = manager.getEntryCount();
		for (const prompt of ["", "\n\t "]) expect(() => beginResearchTaskTurn(manager, prompt, ctx)).toThrow("不能保存");
		expect(() => beginResearchTaskTurn(manager, "", ctx, undefined, true, [], 65)).toThrow("不能保存");
		expect(() => beginResearchTaskTurn(manager, "", ctx, undefined, true, [], 1.5)).toThrow("不能保存");
		expect(manager.getEntryCount()).toBe(count);
		expect(getResearchTask(manager)).toBeUndefined();
	});

	it("does not discard new attachments when migrating a historical last request with the same text", () => {
		const manager = research();
		manager.appendMessage({ role: "user", content: "继续分析", timestamp: Date.now() });
		const path = "D:/selected/new-input.js";
		const task = beginResearchTaskTurn(manager, "继续分析", context(manager).ctx, undefined, false, [path]);
		expect(task.inputs.at(-1)?.attachedPaths).toEqual([path]);
		expect(task.inputs.at(-1)?.text).toBe("继续分析");
		expect(task.originalRequest).toBe("继续分析");
	});

	it("does not turn an authorization word in a file name into a user authorization statement", async () => {
		const manager = research();
		const { ctx } = context(manager);
		const path = "D:/selected/授权样本.js";
		const task = beginResearchTaskTurn(manager, "", ctx, undefined, false, [path]);
		await expect(
			createResearchTaskTool(manager).execute(
				"filename-auth",
				{
					action: "update",
					facts: [{ field: "authorization", value: "授权", inputId: task.inputs[0].id, quote: path }],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow();
		expect(latest(manager).facts.authorization.state).toBe("unreviewed");
	});

	it("captures exact original requests before any model response, retaining unknown and unreviewed separately", async () => {
		const manager = research();
		const { ctx } = context(manager);
		const first = beginResearchTaskTurn(manager, firstRequest, ctx);
		expect(first.originalRequest).toBe(firstRequest);
		expect(first.inputs[0]).toMatchObject({ text: firstRequest, sha256: digest(firstRequest), truncated: false });
		expect(first.response.state).toBe("not_started");
		for (const fact of Object.values(first.facts))
			expect(fact).toEqual({ state: "unreviewed", value: null, evidence: [] });
		const second = beginResearchTaskTurn(manager, clarification, ctx);
		expect(second.taskId).toBe(first.taskId);
		expect(second.originalRequest).toBe(firstRequest);
		expect(second.inputs.map((input) => input.text)).toEqual([firstRequest, clarification]);
		expect(second.inputs[1].sha256).toBe(digest(clarification));
		expect(second.inputHash).not.toBe(first.inputHash);
		await createResearchTaskTool(manager).execute(
			"unknown",
			{ action: "update", facts: [{ field: "authorization", state: "unknown" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(latest(manager).facts.authorization).toEqual({ state: "unknown", value: null, evidence: [] });
		expect(latest(manager).facts.dataSource.state).toBe("unreviewed");
		expect(latest(manager).acceptance.goalVerified).toBe(false);
	});

	it("records bounded previews truthfully while hashing the complete unmodified input", () => {
		const manager = research();
		const prompt = "用户材料".repeat(1400);
		const task = beginResearchTaskTurn(manager, prompt, context(manager).ctx);
		expect(task.originalRequest).toBe(prompt);
		expect(task.inputs[0]).toMatchObject({ text: prompt.slice(0, 4096), sha256: digest(prompt), truncated: true });
		expect(isResearchTaskRecord(task, manager.getSessionId())).toBe(true);
	});

	it("accepts only values contained in real input quotes and never infers authorization from online wording", async () => {
		const manager = research();
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const task = beginResearchTaskTurn(manager, clarification, ctx);
		const inputId = task.inputs[1].id;
		const tool = createResearchTaskTool(manager);
		await tool.execute(
			"facts",
			{
				action: "update",
				facts: [
					{ field: "target", value: "三角洲行动", inputId, quote: "三角洲行动" },
					{ field: "function", value: "地图透视", inputId, quote: "地图透视" },
					{ field: "environment", value: "线上对战", inputId, quote: "线上对战" },
					{ field: "authorization", state: "unknown" },
					{ field: "dataSource", state: "unknown" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(latest(manager).facts.environment).toEqual({
			state: "user_stated",
			value: "线上对战",
			evidence: [{ inputId, quote: "线上对战" }],
		});
		expect(latest(manager).facts.authorization.value).toBeNull();
		const before = manager.getEntryCount();
		for (const fact of [
			{ field: "target", value: "三角洲行动", inputId: "invented", quote: "三角洲行动" },
			{ field: "function", value: "地图透视", inputId, quote: "不存在的原文" },
			{ field: "environment", value: "自研离线", inputId, quote: "线上对战" },
			{ field: "authorization", value: "线上对战", inputId, quote: "线上对战" },
			{ field: "authorization", state: "unknown", value: "没有授权" },
		]) {
			await expect(
				tool.execute(
					"invalid",
					{ action: "update", facts: [fact] } as Static<typeof researchTaskSchema>,
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow();
		}
		expect(manager.getEntryCount()).toBe(before);
		expect(latest(manager).facts.authorization.state).toBe("unknown");
	});

	it("records explicit authorization words only as a user statement, with no permission side effects", async () => {
		const manager = research();
		const { ctx, setModel, executeTool } = context(manager);
		const prompt = "我已获授权，材料来自我自己的测试程序。";
		const task = beginResearchTaskTurn(manager, prompt, ctx);
		await createResearchTaskTool(manager).execute(
			"auth",
			{
				action: "update",
				facts: [{ field: "authorization", value: "已获授权", inputId: task.inputs[0].id, quote: "我已获授权" }],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(latest(manager).facts.authorization.state).toBe("user_stated");
		expect(latest(manager).acceptance.goalVerified).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
		expect(executeTool).not.toHaveBeenCalled();
	});

	it.each([
		{ quote: "I own this demo application and authorize static analysis.", value: "authorize static analysis" },
		{ quote: "这是我自己写的本地程序", value: "我自己写的本地程序" },
	])("records a user's explicit ownership or authorization statement: $quote", async ({ quote, value }) => {
		const manager = research();
		const { ctx, setModel, executeTool } = context(manager);
		const task = beginResearchTaskTurn(manager, quote, ctx);
		const inputId = task.inputs[0].id;
		await createResearchTaskTool(manager).execute(
			"declaration",
			{ action: "update", facts: [{ field: "authorization", value, inputId, quote }] },
			undefined,
			undefined,
			ctx,
		);
		expect(latest(manager).facts.authorization).toEqual({
			state: "user_stated",
			value,
			evidence: [{ inputId, quote }],
		});
		expect(latest(manager).ownerSessionId).toBe(manager.getSessionId());
		expect(latest(manager).acceptance.goalVerified).toBe(false);
		expect(latest(manager).inputs[0]).toEqual(task.inputs[0]);
		expect(setModel).not.toHaveBeenCalled();
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("does not use an English authorized filename as an authorization declaration", async () => {
		const manager = research();
		const { ctx } = context(manager);
		const path = "D:/selected/authorized-static-demo.js";
		const task = beginResearchTaskTurn(manager, "", ctx, undefined, false, [path]);
		await expect(
			createResearchTaskTool(manager).execute(
				"filename-only",
				{
					action: "update",
					facts: [{ field: "authorization", value: "authorized", inputId: task.inputs[0].id, quote: path }],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow();
		expect(latest(manager).facts.authorization.state).toBe("unreviewed");
	});

	it("initializes a new goal from only the latest input, preserving attachment metadata in the input hash", async () => {
		const manager = research();
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const oldTask = latest(manager);
		const oldEntryId = manager.getBranch().at(-1)!.id;
		const paths = ["D:/selected/my-map.json"];
		const current = beginResearchTaskTurn(
			manager,
			"另一个新任务：分析我自己的静态地图JSON",
			ctx,
			undefined,
			true,
			paths,
			2,
		);
		const input = current.inputs.at(-1)!;
		await createResearchTaskTool(manager).execute(
			"new-goal",
			{ action: "update", newTask: true },
			undefined,
			undefined,
			ctx,
		);
		const created = latest(manager);
		expect(created.taskId).not.toBe(oldTask.taskId);
		expect(created.originalRequest).toBe(input.text);
		expect(created.inputs).toEqual([input]);
		expect(created.inputHash).toBe(digest(JSON.stringify([[input.id, input.sha256, paths, 2]])));
		expect(created.ownerSessionId).toBe(oldTask.ownerSessionId);
		expect(created.acceptance.goalVerified).toBe(false);
		expect(manager.getEntries().find((entry) => entry.id === oldEntryId)).toMatchObject({ data: oldTask });
		expect(created.inputs[0].sha256).toBe(digest(input.text));
	});

	it("separates the latest request from saved previous-task facts and returns detached context data", async () => {
		const manager = research();
		const { ctx } = context(manager);
		const original = beginResearchTaskTurn(manager, firstRequest, ctx);
		await createResearchTaskTool(manager).execute(
			"old-facts",
			{
				action: "update",
				facts: [{ field: "target", value: "三角洲", inputId: original.inputs[0].id, quote: "三角洲" }],
				missingMaterials: ["旧目标的实际坐标来源"],
				toolNeeds: [{ operation: "核对旧材料", tools: ["read"] }],
			},
			undefined,
			undefined,
			ctx,
		);
		const newText = "另一个新任务：检查我自己写的静态地图JSON";
		const task = beginResearchTaskTurn(manager, newText, ctx, undefined, true, ["D:/selected/my-map.json"], 2);
		const snapshot = structuredClone(task);
		const count = manager.getEntryCount();
		const turn = getResearchTurnContext(task);
		expect(turn.latestInput).toEqual(task.inputs.at(-1));
		expect(turn.latestInput.text).toBe(newText);
		expect(turn.latestInput.attachedPaths).toEqual(["D:/selected/my-map.json"]);
		expect(turn.latestInput.imageCount).toBe(2);
		expect(turn.latestInput).not.toHaveProperty("facts");
		expect(turn.latestInput).not.toHaveProperty("originalRequest");
		expect(turn.previousTask).toMatchObject({
			taskId: original.taskId,
			originalRequest: firstRequest,
			inputs: [original.inputs[0]],
			facts: task.facts,
			missingMaterials: ["旧目标的实际坐标来源"],
		});
		expect(turn.previousTask.inputs).not.toContainEqual(turn.latestInput);
		expect(turn.inputHash).toBe(task.inputHash);
		expect(turn.selectedModel).toEqual(task.modelFit.selected);
		expect(turn.goalVerified).toBe(false);
		turn.latestInput.text = "不能写回当前请求";
		turn.latestInput.attachedPaths?.push("D:/invented/new.js");
		turn.previousTask.inputs[0].text = "不能写回旧请求";
		turn.previousTask.facts.target.value = "不能写回旧事实";
		turn.previousTask.missingMaterials.push("不能写回缺失材料");
		turn.previousTask.toolMatches[0].registeredTools.push("invented-tool");
		turn.selectedModel?.inputTypes.push("invented-modality");
		expect(task).toEqual(snapshot);
		expect(latest(manager)).toEqual(snapshot);
		expect(manager.getEntryCount()).toBe(count);
	});

	it("does not fabricate a latest request when a task context has no inputs", () => {
		const manager = research();
		const task = beginResearchTaskTurn(manager, firstRequest, context(manager).ctx);
		task.inputs = [];
		expect(() => getResearchTurnContext(task)).toThrow("缺少当前输入");
	});

	it("matches same-length NBSP/space quote variants while saving the exact source span", async () => {
		const manager = research();
		const { ctx } = context(manager);
		const task = beginResearchTaskTurn(manager, clarification, ctx);
		const inputId = task.inputs[0].id;
		const tool = createResearchTaskTool(manager);
		await tool.execute(
			"space-quote",
			{
				action: "update",
				facts: [{ field: "function", value: "地图透视", inputId, quote: "线上对战  什么功能、地图透视" }],
			},
			undefined,
			undefined,
			ctx,
		);
		const saved = latest(manager);
		expect(saved.facts.function.evidence).toEqual([{ inputId, quote: "线上对战\u00a0\u00a0什么功能、地图透视" }]);
		expect(saved.inputs[0].text).toBe(clarification);
		expect(saved.inputs[0].sha256).toBe(digest(clarification));
		expect(saved.inputHash).toBe(task.inputHash);
		for (const fact of [
			{ field: "function", value: "地图透视", inputId, quote: "线上对战    什么功能、地图透视" },
			{ field: "function", value: "自动瞄准", inputId, quote: "线上对战  什么功能、自动瞄准" },
		])
			await expect(
				tool.execute(
					"changed-quote",
					{ action: "update", facts: [fact] } as Static<typeof researchTaskSchema>,
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow();
	});

	it("reads only the current branch, refuses corrupt or foreign records and returns detached data", () => {
		const manager = research();
		const base = manager.getBranch()[0].id;
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const a = latest(manager);
		const aEntry = manager.getBranch().at(-1)!.id;
		beginResearchTaskTurn(manager, clarification, ctx);
		manager.branch(base);
		expect(getResearchTask(manager)).toBeUndefined();
		beginResearchTaskTurn(manager, "另一个研究目标", ctx);
		expect(latest(manager).taskId).not.toBe(a.taskId);
		manager.branch(aEntry);
		expect(latest(manager)).toEqual(a);
		const detached = latest(manager);
		detached.inputs[0].text = "不能写回保存的任务";
		expect(latest(manager)).toEqual(a);
		manager.appendCustomEntry(RESEARCH_TASK_ENTRY, { ...a, ownerSessionId: "foreign" });
		expect(() => getResearchTask(manager)).toThrow("会话归属不符");
		manager.appendCustomEntry(RESEARCH_TASK_ENTRY, { malformed: true });
		expect(() => getResearchTask(manager)).toThrow("记录损坏");
	});

	it("rejects ordinary conversations and task fabrication before a research request exists", async () => {
		const ordinary = SessionManager.inMemory();
		expect(() => getResearchTask(ordinary)).toThrow("普通会话");
		expect(() => beginResearchTaskTurn(ordinary, firstRequest, context(ordinary).ctx)).toThrow("普通会话");
		const manager = research();
		await expect(
			createResearchTaskTool(manager).execute(
				"bare",
				{ action: "inspect" },
				undefined,
				undefined,
				context(manager).ctx,
			),
		).rejects.toThrow("尚无用户请求");
	});

	it("rejects forged evidence and original-goal success in the shared wire validator", () => {
		const manager = research();
		beginResearchTaskTurn(manager, clarification, context(manager).ctx);
		const task = latest(manager);
		for (const fact of [
			{ state: "user_stated", value: "线上对战", evidence: [{ inputId: "invented", quote: "线上对战" }] },
			{ state: "user_stated", value: "自研离线", evidence: [{ inputId: task.inputs[0].id, quote: "线上对战" }] },
			{ state: "unknown", value: "没有授权", evidence: [] },
		]) {
			expect(isResearchTaskRecord({ ...task, facts: { ...task.facts, environment: fact } })).toBe(false);
		}
		expect(isResearchTaskRecord({ ...task, acceptance: { ...task.acceptance, goalVerified: true } })).toBe(false);
		expect(isResearchTaskRecord(task, "foreign-owner")).toBe(false);
	});
});

describe("research task directory matching and transport outcomes", () => {
	it("matches registered names and configured input modalities without switching models or executing tools", async () => {
		const manager = research();
		const { ctx, catalog, getAvailable, setModel, executeTool } = context(manager);
		const before = structuredClone(catalog);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		await createResearchTaskTool(manager, undefined, () => ["read", "research_rea"]).execute(
			"match",
			{ action: "update", toolNeeds: [{ operation: "静态函数查询", tools: ["research_rea", "invented_tool"] }] },
			undefined,
			undefined,
			ctx,
		);
		const task = latest(manager);
		expect(task.toolMatches).toEqual([
			{
				operation: "静态函数查询",
				requestedTools: ["research_rea", "invented_tool"],
				registeredTools: ["research_rea"],
				unavailableTools: ["invented_tool"],
			},
		]);
		expect(task.modelFit.selected).toMatchObject({ id: "text-only", inputCompatible: true });
		expect(task.modelFit.candidates.map((model) => model.id)).toEqual(["text-only", "vision"]);
		expect(task.modelFit.basis).toContain("不自动切换模型");
		expect(catalog).toEqual(before);
		expect(getAvailable).toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("preserves required image modality when facts are updated within the same turn", async () => {
		const manager = research();
		const { ctx } = context(manager);
		const initial = beginResearchTaskTurn(manager, "分析这个截图", ctx, undefined, true);
		expect(initial.modelFit.selected?.inputCompatible).toBe(false);
		expect(initial.modelFit.candidates.map((model) => model.id)).toEqual(["vision"]);
		await createResearchTaskTool(manager).execute(
			"update",
			{ action: "update", facts: [{ field: "dataSource", state: "unknown" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(latest(manager).modelFit.selected?.inputCompatible).toBe(false);
		expect(latest(manager).modelFit.candidates.map((model) => model.id)).toEqual(["vision"]);
	});

	it("separates refusal and a normal response from completion and never reroutes on a refusal", () => {
		const manager = research();
		const { ctx, getAvailable, setModel } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const count = getAvailable.mock.calls.length;
		// These are classification inputs, not generated model replies or semantic acceptance evidence.
		const declined = finishResearchTaskTurn(manager, [fauxAssistantMessage("我不能帮助提供该功能。")]);
		expect(declined?.response.state).toBe("declined_candidate");
		expect(declined?.status).toBe("blocked");
		expect(declined?.acceptance.goalVerified).toBe(false);
		expect(getAvailable).toHaveBeenCalledTimes(count);
		expect(setModel).not.toHaveBeenCalled();
		beginResearchTaskTurn(manager, clarification, ctx);
		const received = finishResearchTaskTurn(manager, [fauxAssistantMessage("已经全部完成并通过验证。")]);
		expect(received?.response.state).toBe("received");
		expect(received?.status).toBe("unverified");
		expect(received?.acceptance).toEqual({ state: "not_run", goalVerified: false, checks: [] });
	});

	it("marks a terminal toolUse without a final answer as an incomplete response", () => {
		const manager = research();
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const task = finishResearchTaskTurn(manager, [
			fauxAssistantMessage(fauxToolCall(RESEARCH_TASK_TOOL, { action: "inspect" }), { stopReason: "toolUse" }),
		]);
		expect(task?.response.state).toBe("error");
		expect(task?.status).toBe("blocked");
		expect(task?.acceptance.goalVerified).toBe(false);
	});
});

describe("research task independent artifact checks", () => {
	it("accepts an in-workspace artifact when the current workspace itself is a directory junction", async () => {
		const { root, cwd } = workspace();
		const alias = join(root, "workspace-junction");
		symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
		const bytes = '{"source":"inside the real workspace"}';
		writeFileSync(join(cwd, "inside.json"), bytes);
		const manager = research(alias);
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, "检查当前工作区产物", ctx);
		const tool = createResearchTaskTool(manager);
		await tool.execute(
			"exists",
			{ action: "check", artifactPath: "inside.json", kind: "file_exists", criterion: "当前目录链接内的产物存在" },
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"hash",
			{
				action: "check",
				artifactPath: "inside.json",
				kind: "sha256",
				expectedSha256: digest(bytes),
				criterion: "真实工作区文件哈希正确",
			},
			undefined,
			undefined,
			ctx,
		);
		const task = latest(manager);
		expect(task.acceptance.checks).toHaveLength(2);
		for (const check of task.acceptance.checks)
			expect(check).toMatchObject({ status: "passed", artifactSha256: digest(bytes) });
		expect(task.acceptance.state).toBe("partial");
		expect(task.acceptance.goalVerified).toBe(false);
	});

	it("checks real existence, SHA256 and JSON values, without certifying the original goal", async () => {
		const { cwd } = workspace();
		const manager = research(cwd);
		const { ctx, executeTool } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const original = latest(manager);
		const bytes = '{"coords":{"x":400},"a/b":{"~key":true}}';
		writeFileSync(join(cwd, "component.json"), bytes);
		const tool = createResearchTaskTool(manager);
		for (const input of [
			{ action: "check", artifactPath: "component.json", kind: "file_exists", criterion: "产物存在" },
			{
				action: "check",
				artifactPath: "component.json",
				kind: "sha256",
				expectedSha256: digest(bytes),
				criterion: "产物字节未变",
			},
			{
				action: "check",
				artifactPath: "component.json",
				kind: "json_value",
				jsonPointer: "/coords/x",
				expected: 400,
				criterion: "坐标值为400",
			},
			{
				action: "check",
				artifactPath: "component.json",
				kind: "json_value",
				jsonPointer: "/a~1b/~0key",
				expected: true,
				criterion: "JSON Pointer转义",
			},
		] as const)
			await tool.execute("check", input, undefined, undefined, ctx);
		const task = latest(manager);
		expect(task.acceptance.state).toBe("partial");
		expect(task.acceptance.goalVerified).toBe(false);
		expect(task.status).toBe("partial");
		expect(task.acceptance.checks).toHaveLength(4);
		for (const check of task.acceptance.checks)
			expect(check).toMatchObject({
				taskId: original.taskId,
				inputHash: original.inputHash,
				status: "passed",
				artifactSha256: digest(bytes),
				verifier: "owl-artifact-check-v1",
			});
		expect(executeTool).not.toHaveBeenCalled();
		const next = beginResearchTaskTurn(manager, clarification, ctx);
		expect(next.taskId).toBe(original.taskId);
		expect(next.inputHash).not.toBe(original.inputHash);
		expect(next.acceptance).toEqual({ state: "not_run", goalVerified: false, checks: [] });
	});

	it("keeps missing files, mismatched hashes and invalid JSON checks as failures", async () => {
		const { cwd } = workspace();
		const manager = research(cwd);
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		writeFileSync(join(cwd, "bad.json"), "not JSON");
		const tool = createResearchTaskTool(manager);
		await tool.execute(
			"missing",
			{ action: "check", artifactPath: "missing.json", kind: "file_exists", criterion: "文件存在" },
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"hash",
			{
				action: "check",
				artifactPath: "bad.json",
				kind: "sha256",
				expectedSha256: "0".repeat(64),
				criterion: "哈希匹配",
			},
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"json",
			{
				action: "check",
				artifactPath: "bad.json",
				kind: "json_value",
				jsonPointer: "/x",
				expected: 1,
				criterion: "JSON值",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(latest(manager).acceptance.state).toBe("failed");
		expect(latest(manager).acceptance.checks.map((check) => check.status)).toEqual(["failed", "failed", "failed"]);
		expect(latest(manager).acceptance.checks[0].artifactSha256).toBeNull();
		expect(latest(manager).acceptance.goalVerified).toBe(false);
	});

	it("rejects lexical and real path escapes, directories and files larger than 4 MiB before recording a check", async () => {
		const { root, cwd } = workspace();
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "escape.json"), "{}");
		symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
		writeFileSync(join(cwd, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
		mkdirSync(join(cwd, "directory"));
		const manager = research(cwd);
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const tool = createResearchTaskTool(manager);
		const count = manager.getEntryCount();
		for (const artifactPath of [
			"../outside/escape.json",
			join(outside, "escape.json"),
			"link/escape.json",
			"large.bin",
			"directory",
			".",
			"https://example.invalid/result.json",
		]) {
			await expect(
				tool.execute(
					"unsafe",
					{ action: "check", artifactPath, kind: "file_exists", criterion: "普通工作区产物" },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow();
		}
		expect(manager.getEntryCount()).toBe(count);
		expect(latest(manager).acceptance.checks).toEqual([]);
	});
});

describe("research task tool input and cancellation contract", () => {
	it("exposes a flat object schema and reads empty arguments without appending a record", async () => {
		const manager = research();
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const tool = createResearchTaskTool(manager);
		expect(tool.name).toBe(RESEARCH_TASK_TOOL);
		expect(tool.parameters.type).toBe("object");
		expect("anyOf" in tool.parameters).toBe(false);
		expect("oneOf" in tool.parameters).toBe(false);
		expect(tool.executionMode).toBe("sequential");
		const count = manager.getEntryCount();
		const result = await tool.execute("read", {}, undefined, undefined, ctx);
		expect(result.details).toMatchObject({ researchTask: latest(manager) });
		expect(manager.getEntryCount()).toBe(count);
	});

	it("gives standard-format recovery errors for malformed or partial calls without changing state", async () => {
		const manager = research();
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const tool = createResearchTaskTool(manager);
		const count = manager.getEntryCount();
		for (const input of [
			{ action: "update" },
			{ action: "check" },
			{ action: "invented" },
			{ action: "inspect", facts: [] },
			{ action: "update", facts: [{ field: "environment", value: "缺少引用" }] },
		]) {
			await expect(
				tool.execute("bad", input as Static<typeof researchTaskSchema>, undefined, undefined, ctx),
			).rejects.toThrow("标准格式");
		}
		expect(manager.getEntryCount()).toBe(count);
	});

	it("rejects aborted calls, aborted contexts, foreign owners and replaced sessions before writing", async () => {
		const manager = research();
		const { ctx } = context(manager);
		beginResearchTaskTurn(manager, firstRequest, ctx);
		const tool = createResearchTaskTool(manager);
		const count = manager.getEntryCount();
		const controller = new AbortController();
		controller.abort(new Error("cancelled research task"));
		const input: Static<typeof researchTaskSchema> = {
			action: "update",
			facts: [{ field: "dataSource", state: "unknown" }],
		};
		await expect(tool.execute("aborted", input, controller.signal, undefined, ctx)).rejects.toThrow("cancelled");
		await expect(
			tool.execute("owner-aborted", input, undefined, undefined, context(manager, controller.signal).ctx),
		).rejects.toThrow("cancelled");
		await expect(tool.execute("foreign", input, undefined, undefined, context(research()).ctx)).rejects.toThrow(
			"不属于当前会话",
		);
		expect(manager.getEntryCount()).toBe(count);
		manager.newSession();
		await expect(tool.execute("replaced", input, undefined, undefined, context(manager).ctx)).rejects.toThrow(
			"不属于当前会话",
		);
	});
});
