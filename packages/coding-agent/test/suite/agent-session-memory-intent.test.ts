import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { readMemoryEntries } from "../../src/core/memory/store.ts";
import { createOwlMemoryExtension } from "../../src/extensions/owl-memory/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const request = "owl左下角的语言支持直接在这里改 如右图";
const mistakenFact = "Owl 左下角语言菜单支持直接切换跟随系统、English 和中文简体。";

describe("foreground memory write intent", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		vi.unstubAllEnvs();
	});

	it("rejects the captured remember call for a UI implementation request and allows work to continue", async () => {
		harness = await createHarness({ extensionFactories: [createOwlMemoryExtension()] });
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const output = join(harness.tempDir, "language-menu.txt");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("remember", { content: mistakenFact, scope: "global" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("write", { path: output, content: "language menu implementation fixture" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("已继续执行界面修改。"),
		]);

		await harness.session.prompt(request);

		expect(readMemoryEntries(agentDir)).toEqual([]);
		expect(existsSync(join(agentDir, "memories", "entries.json"))).toBe(false);
		expect(getToolResult(harness, "remember").isError).toBe(true);
		expect(readFileSync(output, "utf-8")).toBe("language menu implementation fixture");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("allows an explicit memory request without granting later work requests permission to write memories", async () => {
		harness = await createHarness({ extensionFactories: [createOwlMemoryExtension()] });
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("remember", { content: "用户偏好中文回复", scope: "global" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已记住回复语言偏好。"),
			fauxAssistantMessage(fauxToolCall("remember", { content: mistakenFact, scope: "global" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("继续处理界面需求。"),
		]);

		await harness.session.prompt("请记住：我偏好中文回复。");
		expect(getToolResult(harness, "remember").isError).toBe(false);
		expect(readMemoryEntries(agentDir).map((entry) => entry.content)).toEqual(["用户偏好中文回复"]);
		await harness.session.prompt(request);
		expect(getToolResult(harness, "remember").isError).toBe(true);
		expect(readMemoryEntries(agentDir).map((entry) => entry.content)).toEqual(["用户偏好中文回复"]);
	});

	it("honors the memory switch even when the user requests a memory", async () => {
		harness = await createHarness({
			settings: { owlMemory: { enabled: false } },
			extensionFactories: [createOwlMemoryExtension()],
		});
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("remember", { content: "用户偏好中文回复" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("记忆功能当前关闭。"),
		]);

		await harness.session.prompt("请记住我偏好中文回复。");

		expect(getToolResult(harness, "remember").isError).toBe(true);
		expect(readMemoryEntries(agentDir)).toEqual([]);
	});

	it("applies the same foreground boundary to user impressions", async () => {
		const writes: string[] = [];
		harness = await createHarness({
			extensionFactories: [
				createOwlMemoryExtension(),
				(pi) => {
					pi.registerTool({
						name: "update_user_impression",
						label: "User impression",
						description: "Save a user impression",
						parameters: Type.Object({ impression: Type.String() }),
						execute: async (_id, params) => {
							writes.push(params.impression);
							return { content: [{ type: "text", text: "saved" }], details: {} };
						},
					});
				},
			],
		});
		vi.stubEnv(ENV_AGENT_DIR, join(harness.tempDir, "agent"));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_user_impression", { impression: mistakenFact }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("继续执行界面需求。"),
			fauxAssistantMessage(fauxToolCall("update_user_impression", { impression: "用户偏好中文回复" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已更新语言偏好。"),
		]);

		await harness.session.prompt(request);
		expect(getToolResult(harness, "update_user_impression").isError).toBe(true);
		expect(writes).toEqual([]);
		await harness.session.prompt("请更新用户印象：我偏好中文回复。");
		expect(getToolResult(harness, "update_user_impression").isError).toBe(false);
		expect(writes).toEqual(["用户偏好中文回复"]);
	});

	it.each([
		{ initial: request, delivered: "请记住：我偏好中文回复。", allowed: true },
		{ initial: "请记住：我偏好中文回复。", delivered: "不要再记了，继续修改语言菜单。", allowed: false },
	])(
		"uses delivered steering messages rather than the initial prompt: $allowed",
		async ({ initial, delivered, allowed }) => {
			harness = await createHarness({ extensionFactories: [createOwlMemoryExtension()] });
			const agentDir = join(harness.tempDir, "agent");
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			const session = harness.session;
			harness.setResponses([
				async () => {
					await session.steer(delivered);
					return fauxAssistantMessage("收到，继续处理。 ");
				},
				fauxAssistantMessage(fauxToolCall("remember", { content: "用户偏好中文回复" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("已处理当前请求。"),
			]);

			await session.prompt(initial);

			expect(getToolResult(harness, "remember").isError).toBe(!allowed);
			expect(readMemoryEntries(agentDir)).toHaveLength(allowed ? 1 : 0);
		},
	);

	it("does not borrow permission from a follow-up that has not been delivered yet", async () => {
		harness = await createHarness({ extensionFactories: [createOwlMemoryExtension()] });
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const session = harness.session;
		harness.setResponses([
			async () => {
				await session.followUp("请记住：我偏好中文回复。");
				return fauxAssistantMessage(fauxToolCall("remember", { content: mistakenFact }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("当前需求继续按界面修改处理。"),
			fauxAssistantMessage(fauxToolCall("remember", { content: "用户偏好中文回复" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已保存明确要求的偏好。"),
		]);

		await session.prompt(request);

		const results = session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "remember",
		);
		expect(results.map((result) => result.isError)).toEqual([true, false]);
		expect(readMemoryEntries(agentDir).map((entry) => entry.content)).toEqual(["用户偏好中文回复"]);
	});
});
