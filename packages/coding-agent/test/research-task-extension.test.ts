import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResearchExtension, RESEARCH_MODE_ENTRY } from "../src/core/research/agent.ts";
import { getResearchTask, RESEARCH_TASK_TOOL } from "../src/core/research/task.ts";
import { RESEARCH_TASK_ENTRY } from "../src/core/research/task-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// Only attachment transport is under test; image decoding and all provider responses stay local.
vi.mock("../src/utils/image-process.ts", () => ({
	processImage: async (bytes: Uint8Array, mimeType: string) => ({
		ok: true,
		data: Buffer.from(bytes).toString("base64"),
		mimeType,
		hints: [],
	}),
}));

const image = { type: "image" as const, data: "ZmFrZQ==", mimeType: "image/png" };

describe("research task attachment extension transport", () => {
	const roots: string[] = [];
	const harnesses: Harness[] = [];
	const profile = () => {
		const root = mkdtempSync(join(tmpdir(), "owl-research-task-extension-"));
		if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-research-task-extension-")) {
			throw new Error("Unsafe research task extension test root");
		}
		roots.push(root);
		return root;
	};

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("passes an image-only real session prompt through the hook into the task ledger and local provider context", async () => {
		const root = profile();
		const manager = SessionManager.inMemory(root);
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "attachment-vision", input: ["text", "image"] }],
			extensionFactories: [createResearchExtension(manager, root)],
		});
		harnesses.push(harness);
		let providerImageCount = 0;
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				if (user?.role === "user" && typeof user.content !== "string") {
					providerImageCount = user.content.filter((part) => part.type === "image").length;
				}
				return fauxAssistantMessage("本地附件传递测试回执，不代表分析了图片。");
			},
		]);
		await harness.session.prompt("", { images: [image] });
		const task = getResearchTask(manager);
		expect(task?.originalRequest).toBe("");
		expect(task?.inputs[0]).toMatchObject({ text: "", imageCount: 1 });
		expect(task?.modelFit.selected?.inputCompatible).toBe(true);
		expect(task?.acceptance.goalVerified).toBe(false);
		expect(providerImageCount).toBe(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getCurrentSystemPrompt(harness.session.messages)).toContain('"imageCount":1');
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain(RESEARCH_TASK_TOOL);
	});

	it("preserves a path-only prompt and resumes the same task from JSONL before a later clarification", async () => {
		const root = profile();
		const path = join(root, "sample.js");
		writeFileSync(path, "export const value = 1;\n");
		const manager = SessionManager.create(root, root);
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createResearchExtension(manager, root)],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("本地路径传递测试回执，未读取文件。")]);
		await harness.session.prompt("", { attachedPaths: [path] });
		const first = getResearchTask(manager);
		expect(first?.originalRequest).toBe("");
		expect(first?.inputs[0]).toMatchObject({ text: "", attachedPaths: [path] });
		expect(first?.facts.authorization.state).toBe("unreviewed");
		expect(first?.acceptance.goalVerified).toBe(false);
		expect(getCurrentSystemPrompt(harness.session.messages)).toContain("attachedPaths");
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing attachment transport JSONL session");
		const reopened = SessionManager.open(file);
		expect(getResearchTask(reopened)).toEqual(first);
		const resumed = await createHarness({
			sessionManager: reopened,
			extensionFactories: [createResearchExtension(reopened, root)],
		});
		harnesses.push(resumed);
		resumed.setResponses([fauxAssistantMessage("本地恢复测试回执，不代表任务完成。")]);
		await resumed.session.prompt("继续解释这个源文件");
		const next = getResearchTask(reopened);
		expect(next?.taskId).toBe(first?.taskId);
		expect(next?.originalRequest).toBe("");
		expect(next?.inputs).toHaveLength(2);
		expect(next?.inputs[0].attachedPaths).toEqual([path]);
		expect(next?.inputs[1].text).toBe("继续解释这个源文件");
		expect(next?.inputHash).not.toBe(first?.inputHash);
		expect(next?.acceptance.goalVerified).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
		expect(resumed.faux.state.callCount).toBe(1);
	});

	it("keeps text, selected paths and image count together without rewriting the user's text", async () => {
		const root = profile();
		const manager = SessionManager.inMemory(root);
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "web" });
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "combined-vision", input: ["text", "image"] }],
			extensionFactories: [createResearchExtension(manager, root)],
		});
		harnesses.push(harness);
		const text = "核对这张图\u00a0和所选源码";
		const path = join(root, "linked-source.js");
		harness.setResponses([fauxAssistantMessage("只完成本地输入管线测试。")]);
		await harness.session.prompt(text, { attachedPaths: [path], images: [image, image] });
		const task = getResearchTask(manager);
		expect(task?.originalRequest).toBe(text);
		expect(task?.inputs[0]).toMatchObject({ text, attachedPaths: [path], imageCount: 2 });
		expect(task?.acceptance.goalVerified).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not create a research ledger for an ordinary attachment-only conversation", async () => {
		const root = profile();
		const manager = SessionManager.inMemory(root);
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("普通对话的本地附件测试。")]);
		await harness.session.prompt("", { attachedPaths: [join(root, "ordinary.js")] });
		expect(
			manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === RESEARCH_TASK_ENTRY),
		).toBe(false);
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain(RESEARCH_TASK_TOOL);
		expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("<research_task_data>");
		expect(harness.faux.state.callCount).toBe(1);
	});
});
