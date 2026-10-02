/**
 * 工具调用的人话摘要 —— 把工具参数翻译成「关键参数」单行摘要,替代裸 JSON 上屏。
 * 摘要里的 `反引号` 由 ChatStream 的 InlineSummary 渲染成 code 样式。
 * 未知工具(websearch_search 等)走兜底:工具名 + 第一个字符串参数。
 */

export type ToolSummary = {
	/** 一行摘要,如「`ls -la src`」 */
	summary: string;
	/** 展开后的参数细节(完整命令/完整路径);与摘要重复时可省 */
	detail?: string;
};

const trimSpaces = (text: string): string => text.replace(/\s+/g, " ").trim();

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 路径缩短到末两段(…/src/foo.ts),时间轴上不占地方 */
function shortPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length <= 2) return normalized;
	return `…/${parts.slice(-2).join("/")}`;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function firstString(args: Record<string, unknown>): string {
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return "";
}

/** 把一次工具调用的参数翻译成摘要。 */
export function summarizeToolCall(name: string, args: unknown): ToolSummary {
	const a = (args ?? {}) as Record<string, unknown>;
	switch (name) {
		case "bash":
		case "powershell": {
			const command = str(a.command);
			if (!command) return { summary: `运行 ${name === "bash" ? "bash" : "PowerShell"} 命令` };
			return { summary: `\`${clip(trimSpaces(command), 80)}\``, detail: command };
		}
		case "read": {
			const path = str(a.path);
			return path ? { summary: `读取 \`${shortPath(path)}\``, detail: path } : { summary: "读取文件" };
		}
		case "write": {
			const path = str(a.path);
			return path ? { summary: `写入 \`${shortPath(path)}\``, detail: path } : { summary: "写入文件" };
		}
		case "edit": {
			const path = str(a.path);
			const count = Array.isArray(a.edits) ? a.edits.length : 0;
			if (!path) return { summary: "编辑文件" };
			return {
				summary: `编辑 \`${shortPath(path)}\`${count > 1 ? `(${count} 处)` : ""}`,
				detail: path,
			};
		}
		case "find": {
			const pattern = str(a.pattern);
			return pattern ? { summary: `查找文件 \`${clip(pattern, 48)}\`` } : { summary: "查找文件" };
		}
		case "grep": {
			const pattern = str(a.pattern);
			return pattern ? { summary: `搜索 \`${clip(pattern, 40)}\`` } : { summary: "搜索文件内容" };
		}
		case "ls": {
			const path = str(a.path);
			return path ? { summary: `浏览 \`${shortPath(path)}\`` } : { summary: "浏览目录" };
		}
		case "todo":
			return { summary: "更新任务清单" };
		case "ask_user_question": {
			const count = Array.isArray(a.questions) ? a.questions.length : 0;
			return { summary: count > 0 ? `向你提了 ${count} 个问题` : "向你提问" };
		}
		default: {
			const first = firstString(a);
			return { summary: first ? `${name} \`${clip(trimSpaces(first), 48)}\`` : name };
		}
	}
}

/**
 * 连续同名工具的合组标题;不在表里的工具不合组(todo 有专属卡,ask_user 是轮次边界)。
 */
export function toolGroupLabel(name: string, count: number): string | undefined {
	switch (name) {
		case "bash":
		case "powershell":
			return `运行了 ${count} 条命令`;
		case "read":
			return `读取了 ${count} 个文件`;
		case "write":
			return `写入了 ${count} 个文件`;
		case "edit":
			return `编辑了 ${count} 个文件`;
		case "find":
			return `查找了 ${count} 次文件`;
		case "grep":
			return `搜索了 ${count} 次`;
		case "ls":
			return `浏览了 ${count} 个目录`;
		default:
			return undefined;
	}
}

/**
 * 权限确认框的参数说明:人话多行,让用户看得懂在批什么。
 * 写入/编辑类把内容载荷也带上(批准的就是内容本身);未知工具退回 JSON。
 */
export function describeToolInput(name: string, input: unknown): string {
	const json = (): string => JSON.stringify(input, null, 2);
	const a = (input ?? {}) as Record<string, unknown>;
	switch (name) {
		case "bash":
		case "powershell": {
			const command = str(a.command);
			return command || json();
		}
		case "read":
		case "ls": {
			const path = str(a.path);
			return path || json();
		}
		case "write": {
			const path = str(a.path);
			const content = str(a.content);
			if (!path) return json();
			return content ? `${path}\n\n${content}` : path;
		}
		case "edit": {
			const path = str(a.path);
			if (!path) return json();
			const edits = Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [];
			const blocks = edits.map((edit) => {
				const oldText = clip(str(edit.oldText), 200);
				const newText = clip(str(edit.newText), 200);
				return `- ${oldText}\n+ ${newText}`;
			});
			return [path, ...blocks].join("\n\n");
		}
		case "find":
		case "grep": {
			const pattern = str(a.pattern);
			if (!pattern) return json();
			const where = str(a.path);
			return where ? `${pattern} @ ${where}` : pattern;
		}
		default:
			return json();
	}
}
