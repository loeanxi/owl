import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResearchExtension, RESEARCH_PUBLISH_TOOL } from "../src/core/research/agent.ts";
import { RESEARCH_CHECKPOINT_TOOL } from "../src/core/research/checkpoint.ts";
import { RESEARCH_DECOMPILE_TOOL } from "../src/core/research/decompile-tools.ts";
import { RESEARCH_EXECUTABLE_TOOL } from "../src/core/research/executable-tools.ts";
import { RESEARCH_MODEL_LAB_TOOL } from "../src/core/research/model-lab.ts";
import { ResearchReaClient } from "../src/core/research/rea-client.ts";
import { createStaticAnalysisExtension } from "../src/core/research/rea-extension.ts";
import { RESEARCH_REA_TOOL } from "../src/core/research/rea-tools.ts";
import { staticAnalysisInstructions } from "../src/core/research/static-analysis-policy.ts";
import { RESEARCH_TASK_TOOL } from "../src/core/research/task.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { requiresDesktopConfirmation } from "../src/modes/desktop/browser-permissions.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("ordinary conversation static analysis", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	it("registers the static analysis tool in an ordinary conversation and no research workbench tool", async () => {
		const manager = SessionManager.inMemory();
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createStaticAnalysisExtension(manager)],
		});
		harnesses.push(harness);
		const names = harness.session.getAllTools().map((tool) => tool.name);
		expect(names).toContain(RESEARCH_REA_TOOL);
		for (const name of [
			RESEARCH_PUBLISH_TOOL,
			RESEARCH_CHECKPOINT_TOOL,
			RESEARCH_TASK_TOOL,
			RESEARCH_EXECUTABLE_TOOL,
			RESEARCH_DECOMPILE_TOOL,
			RESEARCH_MODEL_LAB_TOOL,
		]) {
			expect(names).not.toContain(name);
		}
	});

	it("still refuses the research workbench registry for an ordinary conversation", () => {
		const ordinary = SessionManager.inMemory();
		expect(() => createResearchExtension(ordinary)).toThrow("普通会话");
	});

	it("injects the static analysis guidance without the research workbench instructions", async () => {
		const manager = SessionManager.inMemory();
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createStaticAnalysisExtension(manager)],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("普通回答")]);
		await harness.session.prompt("看看这个 exe");
		const prompt = getCurrentSystemPrompt(harness.session.messages);
		expect(prompt).toContain(staticAnalysisInstructions());
		expect(prompt).toContain("research_rea");
		expect(prompt).not.toContain("研究工作台统一提供");
		expect(prompt).not.toContain("<research_progress_data>");
	});

	it("closes the conversation's own rea client on shutdown", async () => {
		const manager = SessionManager.inMemory();
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createStaticAnalysisExtension(manager)],
		});
		harnesses.push(harness);
		const closed: ResearchReaClient[] = [];
		vi.spyOn(ResearchReaClient.prototype, "close").mockImplementation(async function (this: ResearchReaClient) {
			closed.push(this);
			return { status: "complete", ownerSessionId: this.ownerSessionId, errors: [] };
		});
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(closed).toHaveLength(1);
		expect(closed[0].ownerSessionId).toBe(manager.getSessionId());
	});

	it("reports incomplete rea cleanup as a shutdown diagnostic", async () => {
		const manager = SessionManager.inMemory();
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createStaticAnalysisExtension(manager)],
		});
		harnesses.push(harness);
		vi.spyOn(ResearchReaClient.prototype, "close").mockResolvedValue({
			status: "cleanupIncomplete",
			ownerSessionId: manager.getSessionId(),
			errors: ["backend still running"],
		});
		const diagnostics: string[] = [];
		harness.session.extensionRunner.onError((error) => {
			diagnostics.push(error.error);
		});
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(diagnostics).toContain("REA 会话清理未完成：backend still running");
	});
});

describe("static analysis approval", () => {
	it("asks once before a static analysis even in auto mode, but not for inventory", () => {
		expect(requiresDesktopConfirmation(RESEARCH_REA_TOOL, { action: "javascript" }, "auto")).toBe(true);
		expect(requiresDesktopConfirmation(RESEARCH_REA_TOOL, { action: "native_overview" }, "auto")).toBe(true);
		expect(requiresDesktopConfirmation(RESEARCH_REA_TOOL, { action: "inventory" }, "auto")).toBe(false);
		expect(requiresDesktopConfirmation(RESEARCH_REA_TOOL, { action: "inventory" }, "confirm")).toBe(true);
		expect(requiresDesktopConfirmation(RESEARCH_REA_TOOL, { action: "javascript" }, "confirm")).toBe(true);
	});

	it("keeps ordinary auto mode hands-off for other tools", () => {
		expect(requiresDesktopConfirmation("bash", { command: "ls" }, "auto")).toBe(false);
		expect(requiresDesktopConfirmation("read", { path: "a.ts" }, "auto")).toBe(false);
		expect(requiresDesktopConfirmation("bash", { command: "ls" }, "confirm")).toBe(true);
		expect(requiresDesktopConfirmation("read", { path: "a.ts" }, "plan")).toBe(false);
	});
});
