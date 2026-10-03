import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";

/** 模拟 mcp-lite 产出的 codemode 暴露工具：注册即可被 codemode 脚本调用，不声明给模型。 */
function fakeMcpTool(name: string, exposure: "codemode" | "direct" | "deferred"): ToolDefinition {
	return {
		name,
		label: name,
		description: `fake mcp tool ${name}`,
		parameters: Type.Object({ q: Type.Optional(Type.String()) }),
		...(exposure !== "direct" ? { exposure } : {}),
		namespace: { name: "mcp_fake", description: "Fake MCP server." },
		async execute() {
			return { content: [{ type: "text", text: `result-of-${name}` }], details: undefined };
		},
	} as ToolDefinition;
}

describe("MCP codemode wiring", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `owl-mcp-codemode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionWith(tools: ToolDefinition[], defaultTools?: string[]) {
		if (defaultTools) {
			await import("node:fs").then((fs) =>
				fs.writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools }), "utf-8"),
			);
		}
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "mcp-wiring-test" });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [...builtInExtensions],
		});
		await resourceLoader.reload();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: tools,
		});
		return session;
	}

	it("activates the codemode tool when codemode-exposed tools are registered", async () => {
		const session = await createSessionWith([fakeMcpTool("mcp_fake_search", "codemode")]);
		try {
			expect(session.getActiveToolNames()).toContain("codemode");
			expect(session.getCallableToolNames()).toContain("mcp_fake_search");
			// codemode 激活但 MCP 工具本身不直接声明给模型
			expect(session.getActiveToolNames()).not.toContain("mcp_fake_search");
		} finally {
			session.dispose();
		}
	});

	it("does not auto-activate codemode when the user excluded it via defaultTools", async () => {
		const session = await createSessionWith([fakeMcpTool("mcp_fake_search", "codemode")], ["-codemode"]);
		try {
			expect(session.getActiveToolNames()).not.toContain("codemode");
		} finally {
			session.dispose();
		}
	});

	it("direct-only MCP tools do not drag codemode in", async () => {
		const session = await createSessionWith([fakeMcpTool("mcp_fake_direct", "direct")]);
		try {
			expect(session.getActiveToolNames()).toContain("mcp_fake_direct");
			expect(session.getActiveToolNames()).not.toContain("codemode");
		} finally {
			session.dispose();
		}
	});
});
