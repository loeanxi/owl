/**
 * 普通会话的静态分析扩展。
 *
 * 研究工作台注册整套研究工具；普通对话只借用 REA 的静态分析能力。两者共用同一个
 * ResearchReaClient 与 createResearchReaTool，所以工具白名单、路径校验、输入快照和
 * 证据留存完全一致。这里不注册 REA 的完整 MCP 目录，也不开放运行、调试注入、ADB 与
 * 安装动作；每个会话仍只持有一个 REA 子进程和一份 Evidence 账本。
 */
import { getAgentDir } from "../../config.ts";
import type { InlineExtension } from "../extensions/index.ts";
import type { SessionManager } from "../session-manager.ts";
import { ResearchReaClient } from "./rea-client.ts";
import { createResearchReaTool, RESEARCH_REA_TOOL } from "./rea-tools.ts";
import { staticAnalysisInstructions } from "./static-analysis-policy.ts";

export function createStaticAnalysisExtension(
	sessionManager: SessionManager,
	agentDir = getAgentDir(),
): InlineExtension {
	return {
		name: "owl-static-analysis",
		factory: (pi) => {
			const rea = new ResearchReaClient(sessionManager.getSessionId(), { agentDir });
			pi.registerTool(createResearchReaTool(rea));
			pi.on("session_shutdown", async () => {
				const closed = await rea.close();
				if (closed.status === "cleanupIncomplete")
					throw new Error(`REA 会话清理未完成：${closed.errors.join("；")}`);
			});
			pi.on("before_agent_start", (event) => {
				// 预设收窄工具集时（极简、Pi、显式工具表）这个工具不可达，
				// 此时不注入说明，避免在没有该能力时占用提示词预算。
				if (!pi.getAllTools().some((tool) => tool.name === RESEARCH_REA_TOOL)) return;
				event.systemPromptOptions.sections.owl_static_analysis = staticAnalysisInstructions();
			});
		},
	};
}
