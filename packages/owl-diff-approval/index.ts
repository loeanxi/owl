/**
 * owl「改动审批」插件：追踪 AI 的每次成功 write/edit，把「改前基线」汇总进
 * 工作区待审清单，供桌面工作台「改动审批」卡片逐文件保留/回滚。
 *
 * 捕获节奏与内置 owl-rewind 对齐：tool_call（执行前）暂存改前内容，
 * tool_result 成功才落库——失败的调用不产生待审条目。查询/保留/回滚不在
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
		storeFor(ctx.cwd).stage(event.toolCallId, resolveToCwd(path, ctx.cwd));
	});

	pi.on("tool_result", (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		storeFor(ctx.cwd).commit(event.toolCallId, event.isError === true);
	});
}
