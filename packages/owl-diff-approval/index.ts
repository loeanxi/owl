/**
 * owl「改动审批」插件：声明每次 write/edit 的会话、轮次、工具调用归属。
 * 宿主工具在真实本地写入边界捕获 before/after，成功结果才进入待审清单。
 *
 * tool_call 注册归属，tool_result 成功才落库；执行期间文件变化、工具归属
 * 不唯一、远程文件操作都不能伪装为可撤销的本地记录。查询/保留/撤销不在
 * 本插件：桌面桥 serve.ts 经 core/diff-approval 注册表读同一份工作区存储，
 * 每次落库经广播接缝推 diffApproval.changed 给 UI。
 *
 * 移植自 9087/dsh-diff-approval（MIT）的核心语义，按 owl 自己的扩展 API 全新
 * 实现：无 DSH slot/侧栏体系，UI 走工作台 tab；暂不移植逐块保留、VCS 导入、
 * 行引用对齐等外围能力。
 */
import {
	getAgentDir,
	getWorkspaceDiffApprovalStore,
	resolveToCwd,
	type ExtensionAPI,
} from "@owl/owl-coding-agent";

/** 只追踪直接改文件的两个工具；shell 造成的改动不在捕获范围（对齐上游口径）。 */
const TRACKED_TOOLS = new Set(["write", "edit"]);

export default function createDiffApprovalExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const storeFor = (cwd: string) => getWorkspaceDiffApprovalStore(agentDir, cwd);

	pi.on("tool_call", (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		const path = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string" || !path.trim()) return;
		const branch = ctx.sessionManager.getBranch();
		const turn = branch.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		storeFor(ctx.cwd).stage(event.toolCallId, resolveToCwd(path, ctx.cwd), {
			sessionId: ctx.sessionManager.getSessionId(),
			turnId: turn?.id ?? "",
			toolName: event.toolName as "write" | "edit",
			input: event.input,
		});
	});

	pi.on("tool_result", (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		storeFor(ctx.cwd).commit(event.toolCallId, event.isError === true, ctx.sessionManager.getSessionId());
	});
}
