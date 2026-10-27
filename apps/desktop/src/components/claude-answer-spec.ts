/**
 * Claude 回答流的排版规格。
 *
 * 规格来源：Claude Desktop 打包渲染层（ion-dist/assets/v1/c05b96c7f-DklIyA-P.js）
 * 的分组器 `ie()` 与行校验 `sc()`，以及实机截图对照。
 *
 * Claude 一轮回答的节奏：
 *
 *   Searched code ⌄                              ← 组头：纯文字、模型撰写的标题
 *   Need sidebar padding to compute ...            ← 模型的一句想法（正文级）
 *   Searched code, read and edited style.css, ...  ← 动作总结行 + diff 统计
 *   管理端侧栏的 Logo 现在也换成了...              ← 正文
 *   • 样式：改在 style.css 的 .brand 这一段 ...    ← 正文，行内 code 按改动染色
 *
 * 组头折叠时只留标题；展开后整组是一个圆角盒，盒内每条工具一行，
 * 点开某条就在行下显示原始输出（带行号）。
 */

import type { ToolCard } from "../hooks/transcript.ts";

/**
 * Claude 的动作动词。前端兜底用；模型自己写了标题时优先用模型的。
 *
 * 取词有据可查，不是自拟：
 *  - Searched / Ran —— 用户实机截图里的工具行标题（"Searched loean-{mark|word}|stylesheet"、"ran a command"）。
 *  - Read / Created / Edited —— Claude Desktop 渲染层 `Pg()` 对本地工具名的兜底映射
 *    （read/view/open_file → Read，write/create_file → Created，edit/multi_edit → Edited）。
 *  - Listed —— claude-code CLI bundle 里的目录列举措辞（"Listing"/"Listed"）。
 * 全部是过去时，和 Claude 标题的语法一致。
 */
export const CLAUDE_VERBS = {
	read: "Read",
	write: "Created",
	edit: "Edited",
	grep: "Searched",
	find: "Found",
	ls: "Listed",
	bash: "Ran",
	powershell: "Ran",
	web_search: "Searched",
	task: "Delegated",
	glob: "Found",
} as const;

/** 一个工具组：Claude 的一条标题 + 组内若干次调用。 */
export type ClaudeToolGroup = {
	/** 组标题：模型撰写的（如 "Searched code"）；没有时用兜底动词 + 数量。 */
	title: string;
	/** 兜底标题是否由前端合成（模型没写）。 */
	synthetic: boolean;
	/** 组内工具。 */
	cards: ToolCard[];
};

/**
 * 一行动作短语。
 *
 * Claude 的标题由后端生成，wire 上是 `title_parts: { verb, object }`，
 * 前端只做校验（label 必须是 `verb object` 或 `verb: object`）。
 * owl 的协议里没有这个字段，所以这里按同样的动词表 + 同样的对象粒度合成。
 */
export type ClaudeActionLine = {
	/** 动词（Read / Searched / Ran …）。 */
	verb: string;
	/** 对象：文件名、搜索模式、命令摘要。 */
	object: string;
};

function argsOf(args: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(args);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 路径只取文件名（Claude 的对象粒度是文件名，不是全路径）。 */
function baseName(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).at(-1) || normalized;
}

/** 命令只取首段（Claude 的 "Ran a command" 只说做了什么，不贴整条命令）。 */
function commandHead(command: string): string {
	const first = command.split(/[\n;]/)[0]?.trim() ?? "";
	return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/**
 * 工具名 → Claude 的动词。
 *
 * 与模型标题无关：组标题的兜底合成需要动词，即使这条工具的标题是模型写的。
 */
export function claudeVerbOf(card: ToolCard): string | undefined {
	switch (card.name) {
		case "read":
			return CLAUDE_VERBS.read;
		case "write":
			return CLAUDE_VERBS.write;
		case "edit":
			return CLAUDE_VERBS.edit;
		case "grep":
			return CLAUDE_VERBS.grep;
		case "find":
		case "glob":
			return CLAUDE_VERBS.find;
		case "ls":
			return CLAUDE_VERBS.ls;
		case "bash":
		case "powershell":
			return CLAUDE_VERBS.bash;
		case "web_search":
			return CLAUDE_VERBS.web_search;
		case "task":
			return CLAUDE_VERBS.task;
		default:
			return undefined;
	}
}

/**
 * 把一次工具调用转成 Claude 的「动词 + 对象」。
 *
 * 对象粒度按 Claude 的习惯：
 *  - 读文件 → 文件名（Read index.html）
 *  - 搜索 → 搜索模式（Searched loean-{mark|word}）
 *  - 命令 → 命令首段（Ran npm run check）
 *
 * 模型自己写了标题（`card.output.title`）时用它 —— Claude Desktop 的工具行标题
 * 就是模型写的，前端只做兜底合成。
 */
export function claudeActionLine(card: ToolCard): ClaudeActionLine | undefined {
	const authored = card.output?.title?.trim();
	if (authored !== undefined && authored !== "") return { verb: "", object: authored };
	const args = argsOf(card.args);
	switch (card.name) {
		case "read":
		case "write":
		case "edit": {
			const path = str(args.path);
			if (path === undefined) return undefined;
			return { verb: claudeVerbOf(card)!, object: baseName(path) };
		}
		case "grep": {
			const pattern = str(args.pattern);
			if (pattern === undefined) return undefined;
			return { verb: CLAUDE_VERBS.grep, object: pattern };
		}
		case "find":
		case "glob": {
			const pattern = str(args.pattern);
			if (pattern === undefined) return undefined;
			return { verb: CLAUDE_VERBS.find, object: pattern };
		}
		case "ls": {
			const path = str(args.path);
			if (path === undefined) return undefined;
			return { verb: CLAUDE_VERBS.ls, object: baseName(path) };
		}
		case "bash":
		case "powershell": {
			const command = str(args.command);
			if (command === undefined) return undefined;
			return { verb: CLAUDE_VERBS.bash, object: commandHead(command) };
		}
		case "web_search": {
			const query = str(args.query);
			if (query === undefined) return undefined;
			return { verb: CLAUDE_VERBS.web_search, object: query };
		}
		default:
			return undefined;
	}
}

/** 动作短语的整行文本：`Searched loean-{mark|word}`。 */
export function claudeActionText(line: ClaudeActionLine): string {
	// 模型自己写的标题已经是完整短语，不再拼动词。
	if (line.verb === "") return line.object;
	return `${line.verb} ${line.object}`;
}

/**
 * 组标题：模型为这批工具写的标题。
 *
 * Claude 的组头（"Searched code"）是**模型写的**，来源是服务端在批次结束后
 * 另起的一次无工具模型请求（Claude 的 `tool_use_summary`）。owl 用同样的
 * 机制：服务端把标签随事件下发，落在组内每张工具卡的 `batchLabel` 上。
 *
 * 模型没写（或那次调用失败）时，按组内**主动词**合成一个可读的组名：
 * 搜索 → "Searched code"；读文件 → "Read files"；其余 → "Ran N commands"。
 *
 * 注意：单条工具的标题（`output.title`）**不**拿来当组标题 —— Claude 的
 * 组头说的是这批工具整体在干什么，不是第一条工具的细节。
 */
export function claudeGroupTitle(cards: ToolCard[]): string {
	if (cards.length === 0) return "";
	// 模型写的组标题（服务端为这批工具生成的标签）。
	const batchLabel = cards.find((card) => card.batchLabel?.trim() !== undefined && card.batchLabel.trim() !== "")?.batchLabel?.trim();
	if (batchLabel !== undefined && batchLabel !== "") return batchLabel;
	const verbs = cards.map((card) => claudeVerbOf(card)).filter((verb): verb is string => verb !== undefined);
	if (verbs.length === 0) return cards.length === 1 ? "Ran 1 command" : `Ran ${cards.length} commands`;
	const verb = verbs[0]!;
	const noun = groupNoun(verb);
	if (noun !== undefined) return `${verb} ${noun}`;
	return cards.length === 1 ? "Ran 1 command" : `Ran ${cards.length} commands`;
}

function groupNoun(verb: string): string | undefined {
	switch (verb) {
		case CLAUDE_VERBS.grep:
		case CLAUDE_VERBS.web_search:
			return "code";
		case CLAUDE_VERBS.read:
			return "files";
		case CLAUDE_VERBS.find:
		case CLAUDE_VERBS.glob:
			return "files";
		case CLAUDE_VERBS.write:
		case CLAUDE_VERBS.edit:
			return "files";
		default:
			return undefined;
	}
}

/**
 * 轮末的动作总结行。
 *
 * Claude 的形态是「动词列举 + diff 统计」：
 *   Searched code, read and edited style.css, ran a command  +90 −7
 * 前半句是本轮做过的事，后半句是本轮的代码增删。
 */
export type ClaudeTurnSummary = {
	/** 总结文本（不含 diff 统计）。 */
	text: string;
	/** 新增行数。 */
	added?: number;
	/** 删除行数。 */
	removed?: number;
};

/** 总结行里的一项。 */
type SummaryItem = {
	/** 动词（读/改/写…），文件操作会合并多个动词。 */
	verbs?: string[];
	/** 动词作用的对象（文件名）。 */
	file?: string;
	/** 模型写好的整句（组标题），有它就不再拼动词。 */
	label?: string;
};

/** 总结行里最多列几件事（Claude 的这行也是三项封顶）。 */
const SUMMARY_MAX_ITEMS = 3;

/** 文件操作在总结行里的动词（Claude: "read and edited style.css"）。 */
const FILE_OP_VERBS: Record<string, string> = {
	read: "read",
	write: "wrote",
	edit: "edited",
};

/** 取一条工具卡上的文件操作（动词 + 文件名）。 */
function fileOpOf(card: ToolCard): { verb: string; file: string } | undefined {
	const verb = FILE_OP_VERBS[card.name];
	if (verb === undefined) return undefined;
	const path = str(argsOf(card.args).path);
	if (path === undefined) return undefined;
	return { verb, file: baseName(path) };
}

/** 把一项总结拼成文字。 */
function summaryItemText(item: SummaryItem): string {
	if (item.label !== undefined) return item.label;
	const verbs = item.verbs ?? [];
	if (verbs.length === 0 || item.file === undefined) return "";
	const joined =
		verbs.length === 1 ? verbs[0]! : `${verbs.slice(0, -1).join(", ")} and ${verbs.at(-1)!}`;
	return `${joined} ${item.file}`;
}

/**
 * 从本轮工具里归纳一句「做过什么」。
 *
 * 拼法照着 Claude 的截图：
 *  - 搜索类用模型写的组标题（"Searched code"），没有就用动作短语；
 *  - 同一个文件上的读和改合并成一句（"read and edited style.css"）；
 *  - 命令统一说 "ran a command"；
 *  - 首项大写，其余小写并列。
 */
export function claudeTurnSummaryText(cards: ToolCard[]): string {
	const items: SummaryItem[] = [];
	const fileSlots = new Map<string, number>();

	for (const card of cards) {
		const op = fileOpOf(card);
		if (op !== undefined) {
			const slot = fileSlots.get(op.file);
			if (slot !== undefined) {
				const existing = items[slot]!;
				if (!(existing.verbs ?? []).includes(op.verb)) (existing.verbs ??= []).push(op.verb);
				continue;
			}
			fileSlots.set(op.file, items.length);
			items.push({ verbs: [op.verb], file: op.file });
			continue;
		}
		if (card.name === "bash" || card.name === "powershell") {
			items.push({ label: "ran a command" });
			continue;
		}
		// 搜索类：模型为这批写的组标题优先。
		const batch = card.batchLabel?.trim();
		if (batch !== undefined && batch !== "") {
			items.push({ label: batch });
			continue;
		}
		const line = claudeActionLine(card);
		if (line === undefined) continue;
		items.push({ label: line.verb === "" ? line.object : `${line.verb} ${line.object}` });
	}

	const texts: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const text = summaryItemText(item);
		if (text === "" || seen.has(text)) continue;
		seen.add(text);
		texts.push(text);
		if (texts.length >= SUMMARY_MAX_ITEMS) break;
	}
	if (texts.length === 0) return "";
	// 首项大写起头，其余小写并列（Claude 的写法）。
	const head = texts[0]!;
	const capitalized = head.length > 0 ? head[0]!.toUpperCase() + head.slice(1) : head;
	const rest = texts.slice(1).map((text) => (text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text));
	return [capitalized, ...rest].join(", ");
}
