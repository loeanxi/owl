/**
 * 「我的助理」数据层：owl-myself 目录（每天一个 `YYYY-MM-DD.md`）的桥读取、
 * markdown 解析与勾选回写。
 *
 * 文件结构约定（与 owl-myself/ 示例数据一致，段标题顺序不敏感）：
 * `# 日期（周X）` + `## 待办（手记）` + `## AI 提炼（自动）` + `## 对话` + `## 完成情况`。
 * 勾选回写按行翻转 `[ ]`/`[x]` 标记，其余内容原样保留——两个清单段落里同名
 * 条目一起翻，避免「待办」与「完成情况」状态漂移。
 *
 * 数据目录按候选顺序探测（fs.tree 探活，全部失败进空态让用户填绝对路径）：
 * localStorage 覆盖 > 固定助理目录（D:/owl/owl-myself）> `<工作区>/owl-myself` > `<agentDir>/myself`。
 */
import type { BridgeClient } from "../../bridge/client.ts";
import type { FsListing, FsReadResult } from "../../bridge/protocol.ts";
import { ASSISTANT_DIR } from "../../utils/paths.ts";

export interface MyselfTodo {
	text: string;
	done: boolean;
}

export interface MyselfDistilled {
	title: string;
	detail: string;
}

export interface MyselfChatLine {
	time: string;
	who: string;
	text: string;
}

export interface MyselfDay {
	/** 文件名里的日期键（YYYY-MM-DD）。 */
	date: string;
	/** `#` 一级标题（含日期），缺省时由 date 生成。 */
	title: string;
	todos: MyselfTodo[];
	distilled: MyselfDistilled[];
	chat: MyselfChatLine[];
	/** 未识别段落的纯文本行（自由记录兜底展示）。 */
	notes: string[];
	raw: string;
}

export interface MyselfDayEntry {
	date: string;
	/** 剩余未完成条数（解析后填）。 */
	remaining: number;
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** 本地日期键（不是 UTC 的 toISOString——时区会漂一天）。 */
export function dayKeyOf(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function todayKey(): string {
	return dayKeyOf(new Date());
}

// ---------------------------------------------------------------------------
// markdown 解析与回写
// ---------------------------------------------------------------------------

const CHECK_RE = /^(\s*(?:[-*]|\d+[.、])\s+)\[([ xX])\]\s*(.*)$/;

/** 解析一天的 markdown。解析规则宽容：段标题按 `## ` 前缀识别，顺序不敏感。 */
export function parseDay(raw: string, date: string): MyselfDay {
	const lines = raw.split(/\r?\n/);
	const day: MyselfDay = { date, title: date, todos: [], distilled: [], chat: [], notes: [], raw };
	let section = "";
	// 「待办」与「完成情况」是同一份清单的两个投影：合并去重，状态以「完成情况」为准。
	const todoDraft: MyselfTodo[] = [];
	const doneDraft: MyselfTodo[] = [];

	for (const line of lines) {
		if (line.startsWith("# ") && day.title === date) {
			day.title = line.slice(2).trim();
			continue;
		}
		if (line.startsWith("## ")) {
			section = line.slice(3).trim();
			continue;
		}
		const check = CHECK_RE.exec(line);
		if (check && (isTodoSection(section) || isDoneSection(section))) {
			(isTodoSection(section) ? todoDraft : doneDraft).push({ text: check[3].trim(), done: check[2].toLowerCase() === "x" });
			continue;
		}
		const distilled = parseDistilledLine(line);
		if (distilled && isDistilledSection(section)) {
			day.distilled.push(distilled);
			continue;
		}
		const chat = /^>\s*(\d{1,2}:\d{2})\s+([^：:]{1,24})[：:]\s*(.*)$/.exec(line);
		if (chat && isChatSection(section)) {
			day.chat.push({ time: chat[1]!, who: chat[2]!.trim(), text: chat[3]! });
			continue;
		}
		if (line.trim() !== "" && line.trim() !== "---") day.notes.push(line);
	}

	const statusBy = new Map(doneDraft.map((todo) => [normalizeTodoText(todo.text), todo.done]));
	const seen = new Set<string>();
	for (const todo of todoDraft) {
		const key = normalizeTodoText(todo.text);
		seen.add(key);
		day.todos.push({ text: todo.text, done: statusBy.get(key) ?? todo.done });
	}
	for (const todo of doneDraft) {
		if (!seen.has(normalizeTodoText(todo.text))) day.todos.push(todo);
	}
	return day;
}

function isTodoSection(section: string): boolean {
	return section.startsWith("待办") || /^todo/i.test(section);
}
function isDoneSection(section: string): boolean {
	return section.startsWith("完成") || /^done|completed/i.test(section);
}
function isDistilledSection(section: string): boolean {
	return section.includes("提炼") || /^distilled|focus/i.test(section);
}
function isChatSection(section: string): boolean {
	return section.startsWith("对话") || /^chat|log/i.test(section);
}

/** 提炼行：`1. **标题** —— 说明`，也容忍没有加粗/破折号的普通编号行。 */
function parseDistilledLine(line: string): MyselfDistilled | undefined {
	const m = /^\s*\d+[.、]\s+(.+)$/.exec(line);
	if (!m) return undefined;
	const body = m[1]!;
	const bold = /^\*\*(.+?)\*\*(?:\s*[—–-]+\s*(.*))?$/.exec(body);
	if (bold) return { title: bold[1]!.trim(), detail: (bold[2] ?? "").trim() };
	const dash = /^(.+?)\s*[—–]{1,2}\s*(.+)$/.exec(body);
	if (dash) return { title: dash[1]!.trim(), detail: dash[2]!.trim() };
	return { title: body.trim(), detail: "" };
}

/**
 * 翻转某条待办的勾选标记并返回新全文。所有同名清单行（「待办」与「完成情况」
 * 两个段落）一起翻；文本按去除空白后比较。找不到匹配行时原文返回。
 */
export function toggleTodoInRaw(raw: string, text: string, done: boolean): string {
	const needle = normalizeTodoText(text);
	const lines = raw.split(/\r?\n/);
	let hit = false;
	for (let i = 0; i < lines.length; i++) {
		const check = CHECK_RE.exec(lines[i]!);
		if (!check || normalizeTodoText(check[3]!) !== needle) continue;
		lines[i] = `${check[1]}[${done ? "x" : " "}] ${check[3]}`;
		hit = true;
	}
	return hit ? lines.join("\n") : raw;
}

function normalizeTodoText(text: string): string {
	return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 把一轮对话（用户或 Owl Si）追加进「对话」段的引用行里：`> HH:MM 谁：内容`。
 * 没有对话段时在文末补一个；正文压成单行（引用行格式），其余内容不动。
 */
export function appendChatLine(raw: string, time: string, who: string, text: string): string {
	const line = `> ${time} ${who}：${text.replace(/\s*\r?\n\s*/g, " ").trim()}`;
	const lines = raw.split(/\r?\n/);
	let sectionStart = -1;
	let insertAt = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("## ")) {
			if (isChatSection(lines[i]!.slice(3).trim())) sectionStart = i;
			else if (sectionStart >= 0) {
				insertAt = i;
				break;
			}
		}
	}
	if (sectionStart < 0) {
		const trimmed = raw.replace(/\s*$/, "");
		return `${trimmed}${trimmed ? "\n\n" : ""}## 对话\n\n${line}\n`;
	}
	if (insertAt < 0) insertAt = lines.length;
	lines.splice(insertAt, 0, line);
	return lines.join("\n");
}

/** 新建一天的初始文件内容（段落骨架与示例数据一致）。 */
export function newDayTemplate(dateKey: string, lang: "zh" | "en"): string {
	const weekday = new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", { weekday: "long" }).format(new Date(`${dateKey}T12:00:00`));
	if (lang === "en") {
		return `# ${dateKey} (${weekday})\n\n## Todos\n\n- [ ] \n\n## AI distilled\n\n1. \n\n## Chat\n\n## Completed\n`;
	}
	return `# ${dateKey}（${weekday}）\n\n## 待办（手记）\n\n- [ ] \n\n## AI 提炼（自动）\n\n1. \n\n## 对话\n\n## 完成情况\n`;
}

// ---------------------------------------------------------------------------
// 桥调用：目录探测 / 列天 / 读天 / 写天
// ---------------------------------------------------------------------------

function trimSlashes(path: string): string {
	return path.replace(/[\\/]+$/, "");
}

/** 用户在面板里手动指定的数据目录（绝对路径），优先于自动探测。 */
export const MYSELF_DIR_LS_KEY = "owl.myself.dir";

export function myselfDirCandidates(workspaceDir?: string, agentDir?: string): string[] {
	const out: string[] = [];
	const override = localStorage.getItem(MYSELF_DIR_LS_KEY)?.trim();
	if (override) out.push(override);
	// 助理目录固定：默认数据根就是示例目录 D:/owl/owl-myself，不随工作区漂移。
	out.push(ASSISTANT_DIR);
	if (workspaceDir?.trim()) out.push(`${trimSlashes(workspaceDir)}/owl-myself`);
	if (agentDir?.trim()) out.push(`${trimSlashes(agentDir)}/myself`);
	return [...new Set(out)];
}

/** 依次探测候选目录，返回第一个能列出来的；全失败返回 null。 */
export async function resolveMyselfDir(client: BridgeClient, workspaceDir?: string, agentDir?: string): Promise<string | null> {
	for (const candidate of myselfDirCandidates(workspaceDir, agentDir)) {
		try {
			await client.request<FsListing>({ type: "fs.tree", cwd: candidate, path: "" }).then((r) => {
				if (!r.ok) throw new Error(r.error ?? "fs.tree failed");
			});
			return candidate;
		} catch {
			// 目录不存在/不可读：试下一个候选。
		}
	}
	return null;
}

/** 列出目录里的天文件（YYYY-MM-DD.md），按日期倒序。 */
export async function listMyselfDays(client: BridgeClient, dir: string): Promise<string[]> {
	const response = await client.request<FsListing>({ type: "fs.tree", cwd: dir, path: "" });
	if (!response.ok) throw new Error(response.error ?? "fs.tree failed");
	const dates = (response.result?.entries ?? [])
		.filter((entry) => !entry.isDir && !entry.hidden)
		.map((entry) => DAY_FILE_RE.exec(entry.name)?.[1])
		.filter((date): date is string => Boolean(date));
	return dates.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

export async function readMyselfDay(client: BridgeClient, dir: string, date: string): Promise<string> {
	const response = await client.request<FsReadResult>({ type: "fs.read", cwd: dir, path: `${date}.md` });
	if (!response.ok) throw new Error(response.error ?? "fs.read failed");
	if (response.result?.kind !== "text") throw new Error("not a text file");
	return response.result.content;
}

export async function writeMyselfDay(client: BridgeClient, dir: string, date: string, content: string): Promise<void> {
	const response = await client.request<{ path: string; size: number }>({ type: "fs.write", cwd: dir, path: `${date}.md`, content });
	if (!response.ok) throw new Error(response.error ?? "fs.write failed");
}

/**
 * 新对话线程首条提示词的角色铺垫：告诉 agent 它是谁、数据目录长什么样、
 * 今天文件的内容。后续轮次靠会话记忆，不再重复（避免引用行越滚越长）。
 */
export function myselfPrimer(dateKey: string, raw: string, lang: "zh" | "en"): string {
	if (lang === "en") {
		return [
			`You are Owl Si, the user's personal assistant in the "My assistant" panel.`,
			`The workspace is the user's schedule folder: one \`YYYY-MM-DD.md\` per day with sections Todos / AI distilled / Chat / Completed.`,
			`Today is \`${dateKey}.md\`, current content:`,
			"```",
			raw.trim(),
			"```",
			`Read/write these files with tools to plan and update; keep the section structure. Be concise.`,
			`---`,
			"",
		].join("\n");
	}
	return [
		`你是用户的个人助理 Owl Si,运行在「我的助理」面板里。`,
		`当前工作区是用户的日程数据目录:每天一个 \`YYYY-MM-DD.md\`,段落为 待办(手记)/AI 提炼(自动)/对话/完成情况。`,
		`今天的文件是 \`${dateKey}.md\`,当前内容:`,
		"```",
		raw.trim(),
		"```",
		`用户会在这里跟你商量安排;需要时直接用工具读写目录里的文件,保持四段结构。回答简洁。`,
		`---`,
		"",
	].join("\n");
}
