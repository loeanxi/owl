/**
 * Claude 的「工具名 → 文案」表。
 *
 * 逆向来源：Claude Desktop 打包渲染层
 * （Claude_2.42304.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1/shared-130-DnUXVlYq.js）
 *
 *  - `kH`  工具名 → 类别
 *          read / view / open_file → read，write / create_file → write，
 *          edit / multi_edit / str_replace / update_file → edit，
 *          glob / file_search → glob，grep → grep，web_search → web，
 *          web_fetch → web_fetch，bash / bash_tool / power_shell → bash，
 *          task / agent → task，skill → skill，…
 *  - `IH`  类别 + 组内次数 → 这一批工具的汇总文案
 *          read  → "Read a file" / "Read 3 files"
 *          write → "Created a file" / "Created 2 files"
 *          edit  → "Edited a file" / "Edited 2 files"
 *          glob  → "Looked for files"
 *          grep  → "Searched files"
 *          web   → "Searched the web"
 *          bash  → "Ran a command" / "Ran 2 commands"
 *          task  → "Ran an agent" / "Ran 2 agents"
 *          …
 *  - `RF`  少数工具的完成态单次文案：ls → "Listed files"。
 *
 * Claude Desktop 上组头**通常**是模型写的（服务端批次结束后的 tool_use_summary）。
 * 这张表只在模型没写、或那次请求失败时兜底 —— 所以文案要跟 Claude 自己的兜底一字不差，
 * 不能自拟一个"读起来也说得通"的组名。
 */

/** Claude 的工具类别（`kH` 的值域，外加 owl 自己的 ls）。 */
export type ClaudeToolCategory =
	| "read"
	| "view"
	| "write"
	| "edit"
	| "delete_file"
	| "glob"
	| "grep"
	| "web"
	| "web_fetch"
	| "code"
	| "bash"
	| "task"
	| "skill"
	| "notebook_edit"
	| "share"
	| "ls"
	| "past_chats"
	| "project_knowledge"
	| "auto_memory_read"
	| "auto_memory_create"
	| "auto_memory_edit"
	| "drive_search"
	| "preview"
	| "screenshot"
	| "plan"
	| "todo"
	| "kill_bash"
	| "tmux"
	| "tool_search"
	| "exit_plan_mode"
	| "browser";

/**
 * owl 的工具名 → Claude 的类别。
 *
 * 只映射 owl 真有的工具；其余工具名（Claude 的 repl / notebook_edit 等）
 * 留给 `claudeGroupPhrase` 直接按类别调用。
 */
const TOOL_CATEGORY: Record<string, ClaudeToolCategory> = {
	read: "read",
	write: "write",
	edit: "edit",
	grep: "grep",
	// owl 的 find 就是「按 glob 模式找文件」，Claude 侧同类工具归到 glob。
	find: "glob",
	glob: "glob",
	bash: "bash",
	powershell: "bash",
	task: "task",
	web_search: "web",
	// ls 在 Claude 的 kH 里没有分类，它的单次文案取自 RF：ls → "Listed files"。
	ls: "ls",
};

/** 一次工具调用归到哪一类；owl 没有的工具返回 undefined。 */
export function claudeToolCategory(toolName: string): ClaudeToolCategory | undefined {
	return TOOL_CATEGORY[toolName];
}

/** `IH` 的第四个参数（`r`）里的两个开关。 */
export type ClaudeGroupPhraseOptions = {
	/** 分享文件时按文件计数（Claude 的 `shareCountsFiles`）。 */
	shareCountsFiles?: boolean;
	/** 浏览器动作失败时的措辞（Claude 的 `r.failed`）。 */
	failed?: boolean;
};

/**
 * 一批工具的汇总文案（Claude 的 `IH`）。
 *
 * `count` 是**同一类别**在这批里的次数 —— Claude 的分组统计也是按类别来的。
 */
export function claudeGroupPhrase(
	category: ClaudeToolCategory,
	count: number,
	options: ClaudeGroupPhraseOptions = {},
): string {
	switch (category) {
		case "read":
		case "view":
			return count === 1 ? "Read a file" : `Read ${count} files`;
		case "write":
			return count === 1 ? "Created a file" : `Created ${count} files`;
		case "edit":
			return count === 1 ? "Edited a file" : `Edited ${count} files`;
		case "delete_file":
			return count === 1 ? "Deleted a file" : `Deleted ${count} files`;
		case "glob":
			return "Looked for files";
		case "grep":
			return "Searched files";
		case "web":
			return "Searched the web";
		case "web_fetch":
			return count === 1 ? "Read a page" : `Read ${count} pages`;
		case "code":
			return count === 1 ? "Ran code" : `Ran code ${count} times`;
		case "bash":
			return count === 1 ? "Ran a command" : `Ran ${count} commands`;
		case "task":
			return count === 1 ? "Ran an agent" : `Ran ${count} agents`;
		case "skill":
			return count === 1 ? "Loaded a skill" : `Loaded ${count} skills`;
		case "notebook_edit":
			return count === 1 ? "Edited a notebook" : `Edited ${count} notebooks`;
		case "share":
			if (options.shareCountsFiles !== true) return "Shared files";
			return count === 1 ? "Shared a file" : `Shared ${count} files`;
		case "ls":
			// ls 在 Claude 侧没有组级分类，只有单次文案 "Listed files"。
			return "Listed files";
		case "past_chats":
			return "Searched past chats";
		case "project_knowledge":
			return "Searched project knowledge";
		case "auto_memory_read":
			return count === 1 ? "Read memory" : `Read ${count} memories`;
		case "auto_memory_create":
			return count === 1 ? "Added to memory" : `Added ${count} memories`;
		case "auto_memory_edit":
			return count === 1 ? "Updated memory" : `Updated ${count} memories`;
		case "drive_search":
			return "Searched Google Drive";
		case "preview":
			return "Used the browser";
		case "screenshot":
			return count === 1 ? "Desktop screenshot" : "Desktop screenshots";
		case "plan":
			return "Updated the plan";
		case "todo":
			return "Updated tasks";
		case "kill_bash":
			return count === 1 ? "Stopped a command" : `Stopped ${count} commands`;
		case "tmux":
			return "Ran terminal";
		case "tool_search":
			return "Loaded tools";
		case "exit_plan_mode":
			return "Proposed a plan";
		case "browser":
			if (options.failed === true) {
				return count === 1
					? "Failed to use Claude in Chrome"
					: `Failed to use Claude in Chrome (${count} attempts)`;
			}
			return count === 1 ? "Used Claude in Chrome" : `Used Claude in Chrome (${count} actions)`;
		default:
			return "";
	}
}
