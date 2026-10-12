/**
 * owl-context —— 上下文洞察插件。
 *
 * 在每次 LLM 请求组装点（context_with_system 事件）把当次请求的六类上下文
 * 构成（系统提示/注入/用户/回复/工具结果/工具 schema）的 token 估算与
 * transcript 快照写入 core/context-insight 注册表；流式增量、工具执行与
 * agent 起止补齐耗时与文件活动；压缩、思考档位切换记为上下文事件。
 * 桌面桥的「上下文」页经 context.get / context.detail / context.item 读取。
 * 洞察只读旁路：任何失败都静默吞掉，绝不影响请求本身。
 *
 * 设计与分类思路参考 bowenliang123/dsh-context（Apache-2.0）——把 Agent
 * 上下文的构成与演进透明化；代码按 owl 的扩展 API（pi 系）全新实现，
 * 数据在请求组装点现采，不解析会话日志。
 */

import {
	appendContextLive,
	classifyRequestMessages,
	type ContextStreamKind,
	type ContextUsageInfo,
	contextUsageOf,
	estimateToolDeclarations,
	type ExtensionAPI,
	recordContextAgent,
	recordContextCompaction,
	recordContextEvent,
	recordContextRequest,
	recordContextResponse,
	recordContextStream,
	recordContextToolEnd,
	recordContextToolStart,
	recordContextTools,
} from "@owl/owl-coding-agent";

const STREAM_KINDS: Record<string, ContextStreamKind> = {
	thinking_delta: "thinking",
	text_delta: "answer",
	toolcall_delta: "toolArgs",
};

const THINKING_LABELS: Record<string, string> = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
};

export default function (pi: ExtensionAPI): void {
	// 每次 LLM 请求组装点：六类构成 + 工具 schema 估算 + transcript 快照。
	pi.on("context_with_system", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			const composition = classifyRequestMessages(event.messages);

			// 使用模型实际收到的声明：包含 model-only、codemode 以及增强后的描述。
			// 工具注册表只用于来源标注，不能决定请求的工具集合。
			const tools = estimateToolDeclarations(pi.getAllTools(), event.messages);
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
				contextUsageOf(lastAssistant?.usage),
				event.messages,
				tools.refs.map((ref) => ref.name),
			);
			recordContextTools(sessionId, ctx.cwd, tools.refs);
		} catch {
			// 洞察绝不能弄丢一次请求
		}
	});

	// 流式增量：TTFT 与思考/回复/工具参数的生成耗时
	pi.on("message_update", (event, ctx) => {
		try {
			const kind = STREAM_KINDS[event.assistantMessageEvent.type];
			if (!kind) return;
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) recordContextStream(sessionId, kind);
		} catch {
			// 静默
		}
	});

	// 消息结束：助手消息回填计费、耗时与回复简报；其余消息计入「当前」尾巴
	pi.on("message_end", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			if (event.message.role === "assistant") recordContextResponse(sessionId, event.message);
			else appendContextLive(sessionId, event.message);
		} catch {
			// 静默
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) recordContextToolStart(sessionId, event.toolCallId, event.toolName, event.args);
		} catch {
			// 静默
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) recordContextToolEnd(sessionId, event.toolCallId, event.toolName, event.isError);
		} catch {
			// 静默
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) recordContextAgent(sessionId, ctx.cwd, "start");
		} catch {
			// 静默
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) recordContextAgent(sessionId, ctx.cwd, "end");
		} catch {
			// 静默
		}
	});

	// 压缩事件：开启新纪元，趋势图上的 ✂ 标记
	pi.on("session_compact", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			const reasonText =
				event.reason === "manual" ? "手动" : event.reason === "threshold" ? "阈值触发" : "溢出恢复";
			recordContextCompaction(sessionId, ctx.cwd, `压缩上下文（${reasonText}）`, event.reason);
		} catch {
			// 静默
		}
	});

	pi.on("thinking_level_select", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId || event.level === event.previousLevel) return;
			const label = (level: string) => THINKING_LABELS[level] ?? level;
			recordContextEvent(sessionId, ctx.cwd, {
				kind: "mode",
				label: `思考档位：${label(event.previousLevel)} → ${label(event.level)}`,
			});
		} catch {
			// 静默
		}
	});
}
