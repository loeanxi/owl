/**
 * Claude Desktop 的工具行标签生成器。
 *
 * 规格来源：Claude Desktop 打包产物
 *   - `shared-130-DnUXVlYq.js` 的 `lL()`：标签生成主函数（running / done / cancelled 三态）
 *   - 同文件的 `kF` / `RF` / `zF` 三张表：通用、完成、中断
 *   - `c05b96c7f-DklIyA-P.js` 的 `Y_()`：标签优先级链
 *
 * Claude 有**两种语域**，别混：
 *
 *  1. **兜底标签**（本模块）—— 现在进行时、泛指：
 *     "Reading a file" / "Searching files" / "Running a command" / "Listed files"。
 *     这三张表逐字取自 bundle，不是自拟。
 *  2. **模型撰写的标题**（`card.output.title`）—— 过去时 + 最有辨识度的名词：
 *     "Read index.html" / "Searched loean-{mark|word}"。
 *     来自 wire 上的 `title_parts`，优先级最高。
 *
 * 两种语域同时存在，是因为 Claude 的模型标题提示词原文就是
 * 「Keep the verb in past tense」；而前端兜底表用的是进行时。
 *
 * 优先级链（`Y_()`）：
 *   模型标题 → 输入里的 description → wire 上的 label → 兜底表
 *
 * 对象的去留：Claude 的兜底标签**不带对象**（就是 "Reading a file"），
 * 具体路径/模式/命令放在行首的 tooltip 里（Claude 的 `labelTooltip`）。
 */

import type { ToolCard } from "../hooks/transcript.ts";
import { trimClaudeLabel } from "./claude-label-trim.ts";

/** 标签状态：对应 Claude 的 running / done / cancelled。 */
export type ClaudeToolState = "running" | "done" | "cancelled";

/**
 * Claude 的通用标签（进行时）。逐字取自 bundle 的 `kF`。
 *
 * 只收 owl 用得到的工具；Claude 自己的 read/grep/edit 这些名字 owl 也有，
 * 所以这一张表基本可以整份搬过来。
 */
export const CLAUDE_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
	read: "Reading a file",
	write: "Creating a file",
	edit: "Editing a file",
	multi_edit: "Editing files",
	str_replace: "Editing a file",
	str_replace_editor: "Editing a file",
	notebook_edit: "Editing a notebook",
	view: "Reading a file",
	create_file: "Creating a file",
	open_file: "Opening file",
	update_file: "Updating file",
	close_file: "Closing file",
	delete_file: "Deleting file",
	file_search: "Searching files",
	glob: "Looking for files",
	grep: "Searching files",
	ls: "Listing files",
	repl: "Running code",
	java_script: "Running code",
	web_fetch: "Reading a page",
	web_search: "Searching the web",
	web_search_fast: "Searching the web",
	project_knowledge_search: "Searching project knowledge",
	project_memory_read: "Reading memory",
	project_memory_write: "Updating memory",
	drive_search: "Searching Google Drive",
	recent_chats: "Searching past chats",
	conversation_search: "Searching past chats",
	todo_write: "Updating the plan",
	task: "Running an agent",
	agent: "Running an agent",
	skill: "Running skill",
	tool_search: "Loading tools",
	ask_user_question: "Asking a question",
	bash_output: "Checking command output",
	enter_plan_mode: "Starting a plan",
	exit_plan_mode: "Proposing a plan",
	kill_bash: "Stopping a command",
	push_notification: "Sending notification",
	send_user_message: "Sending message",
	send_user_file: "Sharing files",
	present_files: "Sharing files",
	list_mcp_resources: "Listing resources",
	list_mcp_resources_tool: "Listing resources",
	read_resource_link: "Reading resource",
	read_mcp_resource_tool: "Reading resource",
	read_widget_context: "Reading widget context",
});

/**
 * Claude 的完成态标签。逐字取自 bundle 的 `RF`。
 *
 * 注意 Claude 只给一部分工具有完成态说法；其余的完成态沿用通用标签
 * （Claude 的 `kF` 里 "Reading a file" 就同时是 running 和 done 的说法）。
 */
export const CLAUDE_TOOL_LABELS_DONE: Readonly<Record<string, string>> = Object.freeze({
	ask_user_question: "Asked a question",
	bash_output: "Checked command output",
	enter_plan_mode: "Started a plan",
	exit_plan_mode: "Proposed a plan",
	java_script: "Ran code",
	ls: "Listed files",
	repl: "Ran code",
	push_notification: "Sent notification",
	present_files: "Shared files",
	send_user_file: "Shared files",
	send_user_message: "Sent message",
	skill: "Ran skill",
	tool_search: "Loaded tools",
});

/**
 * Claude 的中断态标签。逐字取自 bundle 的 `zF`。
 *
 * 中断指的是用户把这次调用停掉了，不是工具失败 —— 失败在 Claude 那边
 * 仍然是完成态（靠颜色表达），owl 也一样。
 */
export const CLAUDE_TOOL_LABELS_CANCELLED: Readonly<Record<string, string>> = Object.freeze({
	read: "Stopped reading file",
	write: "Stopped creating file",
	recent_chats: "Stopped searching past chats",
	conversation_search: "Stopped searching past chats",
	project_knowledge_search: "Stopped searching project knowledge",
	tool_search: "Stopped loading tools",
	bash: "Stopped running the command",
	bash_tool: "Stopped running the command",
	power_shell: "Stopped running the command",
});

/**
 * owl 的工具名 → Claude 的工具名。
 *
 * 名字对不上时以 Claude 的为准：owl 的 `find` 是按 glob 找文件，
 * 对应 Claude 的 `glob`（"Looking for files"）；owl 的 `powershell`
 * 对应 Claude 的 `power_shell`。
 */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
	read: "read",
	write: "write",
	edit: "edit",
	multi_edit: "multi_edit",
	grep: "grep",
	find: "glob",
	glob: "glob",
	ls: "ls",
	bash: "bash",
	powershell: "power_shell",
	web_search: "web_search",
	web_fetch: "web_fetch",
	task: "task",
	todo: "todo_write",
	ask_user: "ask_user_question",
	skill: "skill",
});

/** Claude 的 bash 说法（bundle 的 `lL()` 里 bash 分支的三态）。 */
const CLAUDE_BASH_LABELS: Readonly<Record<ClaudeToolState, string>> = Object.freeze({
	running: "Running a command",
	done: "Ran a command",
	cancelled: "Stopped running the command",
});

/** owl 的工具名 → Claude 的工具名。 */
export function claudeToolName(name: string): string {
	return CLAUDE_TOOL_NAMES[name] ?? name;
}

/**
 * 工具状态：owl 的卡片状态 → Claude 的三态。
 *
 * 失败的工具在 Claude 那边仍然是完成态（红色是另外表达的），
 * 所以 `error` 落在 `done` 上。
 */
export function claudeToolState(card: Pick<ToolCard, "status">): ClaudeToolState {
	return card.status === "running" || card.status === "pending" ? "running" : "done";
}

/**
 * 短路径：Claude 的 `QI()`。
 *
 * 路径超过两段时保留最后两段（"admin/index.html"），否则只留文件名。
 */
export function claudeShortPath(path: string): string {
	const parts = path.split("/");
	return parts.length > 2 ? parts.slice(-2).join("/") : (parts[parts.length - 1] ?? path);
}

/**
 * 文件类工具带对象的说法（Claude 的 `shortenPaths` 分支）。
 *
 * Claude 对 read / write / edit / delete 这一族用「动词 + 短路径」，
 * 其余工具（grep / ls / bash …）用泛指说法。
 */
function claudeFileOpLabel(name: string, args: ClaudeToolArgs): string | undefined {
	const path = str(args.path) ?? str(args.file_path);
	if (path === undefined) return undefined;
	const short = claudeShortPath(path);
	switch (name) {
		case "read":
		case "view":
		case "open_file":
			return `Reading ${short}`;
		case "write":
		case "create_file":
			return `Writing ${short}`;
		case "edit":
		case "multi_edit":
		case "update_file":
		case "str_replace":
		case "str_replace_editor":
			return `Editing ${short}`;
		case "delete_file":
			return `Deleting ${short}`;
		default:
			return undefined;
	}
}

/**
 * 兜底标签：按 Claude 的三张表拼出工具行标题。
 *
 * 没有对应说法时返回 undefined —— 调用方据此退回卡片自己的 summary。
 */
export function claudeToolLabel(name: string, state: ClaudeToolState, args: ClaudeToolArgs = {}): string | undefined {
	const claude = claudeToolName(name);
	if (claude === "bash" || claude === "bash_tool" || claude === "power_shell") {
		return CLAUDE_BASH_LABELS[state];
	}
	if (state === "cancelled") {
		const cancelled = CLAUDE_TOOL_LABELS_CANCELLED[claude];
		if (cancelled !== undefined) return cancelled;
	}
	if (state === "done") {
		const done = CLAUDE_TOOL_LABELS_DONE[claude];
		if (done !== undefined) return done;
	}
	// 文件类工具带短路径（Claude 的 shortenPaths 分支）。
	const fileOp = claudeFileOpLabel(name, args);
	if (fileOp !== undefined) return fileOp;
	return CLAUDE_TOOL_LABELS[claude];
}

/** 工具入参。 */
export type ClaudeToolArgs = Record<string, unknown>;

function argsOf(args: string): ClaudeToolArgs {
	try {
		const parsed: unknown = JSON.parse(args);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ClaudeToolArgs) : {};
	} catch {
		return {};
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 工具的细节：路径 / 模式 / 命令 / 查询。
 *
 * Claude 的兜底标签不带对象，对象进 tooltip（`labelTooltip`）。
 * owl 的行首 title 属性就是那个位置。
 */
export function claudeToolDetail(name: string, args: ClaudeToolArgs): string | undefined {
	switch (name) {
		case "read":
		case "write":
		case "edit":
		case "multi_edit":
		case "ls":
			return str(args.path);
		case "grep":
		case "find":
		case "glob":
			return str(args.pattern);
		case "bash":
		case "powershell":
			return str(args.command);
		case "web_search":
			return str(args.query);
		default:
			return undefined;
	}
}

/**
 * 工具行的完整标签。
 *
 * 优先级（对齐 Claude 的 `Y_()`）：
 *   1. 模型自己写的标题（`card.output.title`）—— 过去时 + 对象，原样用；
 *   2. 兜底表 —— 现在进行时、泛指。
 */
export function claudeToolLabelFor(card: ToolCard): { text: string; detail?: string; authored: boolean } {
	const authored = card.output?.title?.trim();
	if (authored !== undefined && authored !== "") {
		// 模型写的标题末尾常带「…」「...」，Claude 渲染前统一剪掉（Qp()）。
		return { text: trimClaudeLabel(authored), authored: true };
	}
	const args = argsOf(card.args);
	const detail = claudeToolDetail(card.name, args);
	const fallback = claudeToolLabel(card.name, claudeToolState(card), args);
	if (fallback === undefined) {
		return { text: card.summary, authored: false };
	}
	return { text: fallback, ...(detail !== undefined ? { detail } : {}), authored: false };
}
