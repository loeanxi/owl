/**
 * owl-context —— 上下文洞察插件。
 *
 * 在每次 LLM 请求组装点（context_with_system 事件）把当次请求的六类上下文
 * 构成（系统提示/注入/用户/回复/工具结果/工具 schema）的 token 估算写入
 * core/context-insight 注册表，桌面桥的「上下文」卡片经 context.get 读取。
 * 压缩事件（session_compact）也记录在内。洞察只读旁路：任何失败都静默吞掉，
 * 绝不影响请求本身。
 *
 * 设计与分类思路参考 bowenliang123/dsh-context（Apache-2.0）——把 Agent
 * 上下文的构成与演进透明化；代码按 owl 的扩展 API（pi 系）全新实现，
 * 数据在请求组装点现采，不解析会话日志。
 */

import {
	classifyRequestMessages,
	estimateToolDeclarations,
	recordContextEvent,
	recordContextRequest,
	recordContextTools,
	type ContextUsageInfo,
	type ExtensionAPI,
} from "@owl/owl-coding-agent";

function asUsage(usage: Partial<ContextUsageInfo> | undefined): ContextUsageInfo | undefined {
	if (!usage) return undefined;
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	};
}

export default function (pi: ExtensionAPI): void {
	// 每次 LLM 请求组装点：六类构成 + 工具 schema 估算。
	pi.on("context_with_system", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			const composition = classifyRequestMessages(event.messages);

			// 声明给模型的工具（direct 且激活）的 schema 占用与来源
			const active = new Set(pi.getActiveTools());
			const declared = pi.getAllTools().filter((tool) => tool.exposure === "direct" && active.has(tool.name));
			const tools = estimateToolDeclarations(declared);
			composition.toolSchemas = tools.total;

			// 上一条响应的真实计费（本请求 transcript 的最后一条 assistant 消息），
			// 由注册表补填到上一行
			const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as
				| { usage?: Partial<ContextUsageInfo> }
				| undefined;

			const model = ctx.model as { provider?: string; id?: string; contextWindow?: number } | undefined;
			recordContextRequest(
				sessionId,
				ctx.cwd,
				{
					ts: Date.now(),
					model: model?.provider && model?.id ? { provider: model.provider, id: model.id } : undefined,
					composition,
					contextWindow: model?.contextWindow,
				},
				asUsage(lastAssistant?.usage),
			);
			recordContextTools(sessionId, ctx.cwd, tools.refs);
		} catch {
			// 洞察绝不能弄丢一次请求
		}
	});

	// 压缩事件：构成趋势上的分界线
	pi.on("session_compact", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			const reasonText =
				event.reason === "manual" ? "手动" : event.reason === "threshold" ? "阈值触发" : "溢出恢复";
			recordContextEvent(sessionId, ctx.cwd, {
				kind: "compact",
				label: `上下文压缩（${reasonText}）`,
				reason: event.reason,
			});
		} catch {
			// 同上，静默
		}
	});
}
