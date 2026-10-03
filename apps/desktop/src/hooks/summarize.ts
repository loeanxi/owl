/**
 * 工具调用的人话摘要 —— 把工具参数翻译成「关键参数」单行摘要,替代裸 JSON 上屏。
 * 摘要里的 `反引号` 由 ChatStream 的 InlineSummary 渲染成 code 样式。
 * 未知工具(websearch_search 等)走兜底:工具名 + 第一个字符串参数。
 */

import { t } from "../i18n/index.ts";

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
			if (!command) return { summary: t("sum.runCommand", { shell: name === "bash" ? "bash" : "PowerShell" }) };
			return { summary: `\`${clip(trimSpaces(command), 80)}\``, detail: command };
		}
		case "read": {
			const path = str(a.path);
			return path ? { summary: t("sum.readPath", { path: shortPath(path) }), detail: path } : { summary: t("sum.read") };
		}
		case "write": {
			const path = str(a.path);
			return path ? { summary: t("sum.writePath", { path: shortPath(path) }), detail: path } : { summary: t("sum.write") };
		}
		case "edit": {
			const path = str(a.path);
			const count = Array.isArray(a.edits) ? a.edits.length : 0;
			if (!path) return { summary: t("sum.edit") };
			return {
				summary: t("sum.editPath", { path: shortPath(path) }) + (count > 1 ? t("sum.editCount", { n: count }) : ""),
				detail: path,
			};
		}
		case "find": {
			const pattern = str(a.pattern);
			return pattern ? { summary: t("sum.findPath", { pattern: clip(pattern, 48) }) } : { summary: t("sum.find") };
		}
		case "grep": {
			const pattern = str(a.pattern);
			return pattern ? { summary: t("sum.grepPath", { pattern: clip(pattern, 40) }) } : { summary: t("sum.grep") };
		}
		case "ls": {
			const path = str(a.path);
			return path ? { summary: t("sum.lsPath", { path: shortPath(path) }) } : { summary: t("sum.ls") };
		}
		case "todo":
			return { summary: t("sum.todo") };
		case "ask_user_question": {
			const count = Array.isArray(a.questions) ? a.questions.length : 0;
			return { summary: count > 0 ? t("sum.askCount", { n: count }) : t("sum.ask") };
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
			return t("sum.groupBash", { n: count });
		case "read":
			return t("sum.groupRead", { n: count });
		case "write":
			return t("sum.groupWrite", { n: count });
		case "edit":
			return t("sum.groupEdit", { n: count });
		case "find":
			return t("sum.groupFind", { n: count });
		case "grep":
			return t("sum.groupGrep", { n: count });
		case "ls":
			return t("sum.groupLs", { n: count });
		default:
			return undefined;
	}
}

/** 混合工具族的组显示名(浏览器套件等),未收录的族退回通用文案。 */
const FAMILY_LABELS: Record<string, (vars: { n: number }) => string> = {
	browser: ({ n }) => t("sum.familyBrowser", { n }),
	websearch: ({ n }) => t("sum.familyWebsearch", { n }),
};

/**
 * 一段连续工具调用(名称可不同)的组标题:全部同名用专名文案(「运行了 4 条命令」),
 * 同一前缀族(browser_snapshot/browser_screenshot…)用族名,其余退回通用文案。
 * todo / ask_user_question 不进组,由 ChatStream 侧排除。
 */
export function toolRunLabel(names: string[], count: number): string {
	const first = names[0] ?? "tool";
	if (names.every((name) => name === first)) {
		return toolGroupLabel(first, count) ?? `${first} × ${count}`;
	}
	const family = first.split("_")[0] ?? first;
	if (family && names.every((name) => (name.split("_")[0] ?? name) === family)) {
		const label = FAMILY_LABELS[family];
		if (label) return label({ n: count });
	}
	return t("sum.groupGeneric", { n: count });
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
