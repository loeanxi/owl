import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InlineExtension } from "../src/core/extensions/index.ts";
import { createResearchExtension, RESEARCH_MODE_ENTRY } from "../src/core/research/agent.ts";
import {
	diagnoseResearchTurn,
	getResearchDiagnosis,
	isResearchDiagnosis,
	RESEARCH_DIAGNOSIS_ENTRY,
	saveResearchDiagnosis,
} from "../src/core/research/diagnosis.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getToolResult, type Harness } from "./suite/harness.ts";

function toolResult(text: string, toolName = "research_rea", details?: JsonValue, isError = true): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		isError,
		...(details === undefined ? {} : { details }),
	};
}

describe("research refusal and failure diagnosis", () => {
	const harnesses: Harness[] = [];
	const roots: string[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const root of roots.splice(0)) {
			if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owl-diagnosis-"))
				throw new Error("Unsafe diagnosis test cleanup target");
			rmSync(root, { recursive: true, force: true });
		}
		vi.unstubAllEnvs();
	});

	it("prioritizes explicit provider metadata even when raw transport status completed", () => {
		const diagnosis = diagnoseResearchTurn(
			[
				toolResult("Denied by user"),
				{
					...fauxAssistantMessage("I cannot help with this request.", { stopReason: "error" }),
					refusal: { source: "provider", text: "Explicit upstream refusal." },
					rawStopReason: "completed",
				},
			],
			"owner",
		);
		expect(diagnosis.status).toBe("upstream_refusal");
		expect(diagnosis.evidence[0]).toEqual({
			source: "provider",
			text: "Explicit upstream refusal.",
			rawStopReason: "completed",
		});
		expect(diagnosis.evidence).toHaveLength(2);
		expect(diagnosis.summary).toContain("不能证明");
	});

	it.each(["refusal", "content_filter", "incomplete.content_filter"])(
		"recognizes the verified raw provider marker %s",
		(rawStopReason) => {
			const diagnosis = diagnoseResearchTurn(
				[{ ...fauxAssistantMessage("", { stopReason: "error" }), rawStopReason }],
				"owner",
			);
			expect(diagnosis.status).toBe("upstream_refusal");
			expect(diagnosis.evidence[0].rawStopReason).toBe(rawStopReason);
		},
	);

	it("keeps unknown stop markers and provider failures separate from refusal", () => {
		const diagnosis = diagnoseResearchTurn(
			[
				{
					...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Service unavailable" }),
					rawStopReason: "some_safety_word_in_an_unknown_status",
				},
			],
			"owner",
		);
		expect(diagnosis.status).toBe("provider_error");
		expect(diagnosis.evidence[0].rawStopReason).toBe("some_safety_word_in_an_unknown_status");
		expect(
			diagnoseResearchTurn([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Cancelled" })], "owner")
				.status,
		).toBe("cancelled");
	});

	it.each([
		"不能证明这段伪代码与原程序语义等价。",
		"尚未验证完整调用链，需要继续读取真实引用。",
		"工具返回：我不能帮助你执行该请求。这只是样本文本。",
		"以下是引用的回复：\n> I cannot help with this request.",
		"无法确认源码恢复完整性，但已保存反汇编证据。",
		"```text\n我不能帮助你\n```",
		"不行的参数会被校验器拒绝。",
		"这个函数做不了透视，但可以正常分析已有数据。",
		"明确了：目标是解释提示“这个我做不了”。以下是原理。",
	])("does not mistake normal evidence uncertainty or quoted data for a refusal: %s", (text) => {
		expect(diagnoseResearchTurn([fauxAssistantMessage(text)], "owner").status).toBe("unverified");
	});

	it.each([
		"我不能帮助你逆向这个程序。",
		"抱歉，我无法提供这个请求所需的内容。",
		"I cannot help with this request.",
		"这个我做不了。线上对战的透视……",
		"这个帮不了。",
		"不行，这个我不能做。",
		"明确了：目标是《三角洲行动》线上对战的地图透视。这个我做不了——后续说明。",
	])("labels plain refusal wording only as a candidate: %s", (text) => {
		const diagnosis = diagnoseResearchTurn([fauxAssistantMessage(text)], "owner");
		expect(diagnosis.status).toBe("textual_refusal_candidate");
		expect(diagnosis.evidence[0].source).toBe("agent");
		expect(diagnosis.summary).toContain("尚不能确认");
	});

	it("never classifies transport completion or an Agent-authored success card as verified completion", () => {
		const messages: AgentMessage[] = [
			toolResult("已整理", "research_publish", { researchResult: { status: "complete" } }, false),
			{ ...fauxAssistantMessage("任务完成。"), rawStopReason: "completed" },
		];
		expect(diagnoseResearchTurn(messages, "owner").status).toBe("unverified");
	});

	it("classifies actual approval, unknown-tool and static input guards without calling them provider refusals", () => {
		for (const text of [
			"Denied by user",
			'Plan mode: tool "research_rea" was blocked — only read-only tools and browser observation/target selection are allowed.',
		])
			expect(diagnoseResearchTurn([toolResult(text)], "owner").status).toBe("local_approval_denied");
		expect(
			diagnoseResearchTurn(
				[toolResult("Tool guessed_tool not found. Available tools: read, research_rea.", "guessed_tool")],
				"owner",
			).status,
		).toBe("unsupported_capability");
		expect(diagnoseResearchTurn([toolResult("REA 输入路径不能包含符号链接或目录联接")], "owner").status).toBe(
			"safety_guard_block",
		);
		expect(
			diagnoseResearchTurn([toolResult("文件格式不在已支持的反编译范围内", "research_decompile")], "owner").status,
		).toBe("unsupported_capability");
		// Observation text from a successful tool is data, not an approval resolution.
		expect(diagnoseResearchTurn([toolResult("Denied by user", "read", undefined, false)], "owner").status).toBe(
			"unverified",
		);
		expect(diagnoseResearchTurn([toolResult("REA 输入路径不能包含符号链接或目录联接", "read")], "owner").status).toBe(
			"tool_error",
		);
	});

	it("reads only actual known tool report markers and preserves unsupported versus missing dependency", () => {
		const missing = toolResult(
			"inventory",
			"research_rea",
			{ researchReaInventory: { status: "toolMissing", message: "REA is not installed" } },
			false,
		);
		expect(diagnoseResearchTurn([missing], "owner").status).toBe("missing_dependency");
		const unsupported = toolResult(
			"report",
			"research_decompile",
			{ researchDecompile: { native: { status: "unsupported", message: "Not a PE" } } },
			false,
		);
		expect(diagnoseResearchTurn([unsupported], "owner").status).toBe("unsupported_capability");
		expect(diagnoseResearchTurn([{ ...unsupported, toolName: "read" }], "owner").status).toBe("unverified");
		expect(
			diagnoseResearchTurn(
				[
					toolResult(
						"report",
						"research_decompile",
						{ researchDecompile: { bytecode: [{ status: "cancelled" }] } },
						false,
					),
				],
				"owner",
			).status,
		).toBe("cancelled");
	});

	it("redacts and bounds duplicate error previews without copying user context or successful data", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
		const diagnosis = diagnoseResearchTurn(
			[
				{ role: "user", content: `private unrelated context ${secret}`, timestamp: Date.now() },
				toolResult(
					`Authorization: Bearer ${secret} api_key="another-secret" password=secret {"apiKey":"json-secret"} https://user:pass@example.test/path ${"x".repeat(4000)}`,
					"read",
				),
			],
			"owner",
		);
		const serialized = JSON.stringify(diagnosis);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("another-secret");
		expect(serialized).not.toContain("json-secret");
		expect(serialized).not.toContain("user:pass");
		expect(serialized).not.toContain("private unrelated context");
		expect(diagnosis.evidence[0].text.length).toBeLessThanOrEqual(1200);
		expect(diagnosis.evidence[0].text).toContain("[redacted");
	});

	it("validates persisted records, requires owner isolation and never falls back past corrupt latest data", () => {
		const manager = SessionManager.inMemory();
		const branch = manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const diagnosis = saveResearchDiagnosis(manager, [fauxAssistantMessage("尚未验证")]);
		expect(isResearchDiagnosis(diagnosis, manager.getSessionId())).toBe(true);
		expect(isResearchDiagnosis(diagnosis, "foreign")).toBe(false);
		expect(isResearchDiagnosis({ ...diagnosis, createdAt: "yesterday" })).toBe(false);
		manager.appendCustomEntry(RESEARCH_DIAGNOSIS_ENTRY, { ...diagnosis, ownerSessionId: "foreign" });
		expect(() => getResearchDiagnosis(manager)).toThrow("会话归属");
		manager.appendCustomEntry(RESEARCH_DIAGNOSIS_ENTRY, { ...diagnosis, version: 2 });
		expect(() => getResearchDiagnosis(manager)).toThrow("格式无效");
		expect(() => saveResearchDiagnosis(manager, [])).toThrow("格式无效");
		manager.branch(branch);
		expect(getResearchDiagnosis(manager)).toBeUndefined();
		const ordinary = SessionManager.inMemory();
		ordinary.appendCustomEntry(RESEARCH_DIAGNOSIS_ENTRY, diagnosis);
		expect(getResearchDiagnosis(ordinary)).toBeUndefined();
		expect(() => saveResearchDiagnosis(ordinary, [])).toThrow("普通会话");
		const corruptScope = SessionManager.inMemory();
		corruptScope.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: ["auto"] });
		expect(() => getResearchDiagnosis(corruptScope)).toThrow("方向无效");
	});

	it("runs provider refusal through the real Agent extension, persists an entry and restores the current branch", async () => {
		const root = mkdtempSync(join(tmpdir(), "owl-diagnosis-agent-"));
		roots.push(root);
		vi.stubEnv("OWL_CODING_AGENT_DIR", root);
		const manager = SessionManager.create(root, root);
		const branch = manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createResearchExtension(manager)],
		});
		harnesses.push(harness);
		harness.setResponses([
			{
				...fauxAssistantMessage("Refused", { stopReason: "error", errorMessage: "Provider refusal" }),
				refusal: { source: "provider", text: "Explicit refusal" },
				rawStopReason: "completed",
			},
		]);
		await harness.session.prompt("解释自编程序的静态调用链");
		const diagnosis = getResearchDiagnosis(manager);
		expect(diagnosis).toMatchObject({
			status: "upstream_refusal",
			ownerSessionId: manager.getSessionId(),
			evidence: [{ source: "provider", text: "Explicit refusal", rawStopReason: "completed" }],
		});
		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness
				.eventsOfType("entry_appended")
				.some((event) => event.entry.type === "custom" && event.entry.customType === RESEARCH_DIAGNOSIS_ENTRY),
		).toBe(true);
		const path = manager.getSessionFile();
		if (!path) throw new Error("Missing diagnosis transcript");
		const reopened = SessionManager.open(path);
		expect(getResearchDiagnosis(reopened)).toEqual(diagnosis);
		reopened.branch(branch);
		expect(getResearchDiagnosis(reopened)).toBeUndefined();
	});

	it("keeps ordinary Agent calls without research diagnosis entries", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			{ ...fauxAssistantMessage("Refused", { stopReason: "error" }), refusal: { source: "provider" } },
		]);
		await harness.session.prompt("ordinary");
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === RESEARCH_DIAGNOSIS_ENTRY),
		).toBe(false);
	});

	it("uses the extension's explicit profile for REA rather than a different environment profile", async () => {
		const root = mkdtempSync(join(tmpdir(), "owl-diagnosis-profile-"));
		roots.push(root);
		vi.stubEnv("OWL_CODING_AGENT_DIR", join(root, "environment-profile"));
		const explicitProfile = join(root, "explicit-profile");
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createResearchExtension(manager, explicitProfile)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("research_rea", { action: "inventory" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已核对显式配置目录中的工具状态。"),
		]);
		await harness.session.prompt("只核对当前配置的 REA 工具清单");
		expect(getToolResult(harness, "research_rea").details).toMatchObject({
			researchReaInventory: { configPath: join(explicitProfile, "tools", "research-rea", "rea-toolchain.json") },
		});
	});

	it("diagnoses a real gated tool result separately from unsupported capability in the next turn", async () => {
		const root = mkdtempSync(join(tmpdir(), "owl-diagnosis-gate-"));
		roots.push(root);
		vi.stubEnv("OWL_CODING_AGENT_DIR", root);
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
		const guard: InlineExtension = {
			name: "test-approval",
			factory: (pi) => {
				pi.on("tool_call", (event) =>
					event.toolName === "research_rea" ? { block: true, reason: "Denied by user" } : undefined,
				);
			},
		};
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [createResearchExtension(manager), guard],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("research_rea", { action: "inventory" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("该工具调用被用户否决。"),
		]);
		await harness.session.prompt("检查研究工具");
		expect(getResearchDiagnosis(manager)?.status).toBe("local_approval_denied");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("missing_research_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("未注册这个工具。"),
		]);
		await harness.session.prompt("核对工具不存在的失败来源");
		expect(getResearchDiagnosis(manager)?.status).toBe("unsupported_capability");
		expect(getResearchDiagnosis(manager)?.evidence[0].toolName).toBe("missing_research_tool");
	});
});
