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

export type MyselfTodoStatus = "todo" | "doing" | "waiting" | "done";

/** 行尾 owl-task JSON 注释；未填写的字段不推断、不补默认值。 */
export interface MyselfTodoMetadata {
	status?: MyselfTodoStatus;
	time?: string;
	category?: string;
	/** 关联目标的标题，目标来自 AI 提炼段。 */
	goal?: string;
}

export interface MyselfTodo extends MyselfTodoMetadata {
	text: string;
	done: boolean;
	status: MyselfTodoStatus;
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
	/** 优先使用 AI 提炼段的目标，不从待办虚构目标。 */
	goals: MyselfDistilled[];
	/** 完成情况内独立的「### 今日总结」正文。 */
	summary: string;
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

function localDay(dateKey: string): Date {
	const date = new Date(`${dateKey}T12:00:00`);
	if (!DAY_FILE_RE.test(`${dateKey}.md`) || !Number.isFinite(date.getTime()) || dayKeyOf(date) !== dateKey) {
		throw new Error(`invalid day: ${dateKey}`);
	}
	return date;
}

export function nextDayKey(dateKey: string): string {
	const date = localDay(dateKey);
	date.setDate(date.getDate() + 1);
	return dayKeyOf(date);
}

/** 周一至周日的本地日期键，包含周末，并正确跨月、跨年。 */
export function weekDaysOf(dateKey: string): string[] {
	const date = localDay(dateKey);
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return Array.from({ length: 7 }, (_, index) => {
		const day = new Date(date);
		day.setDate(day.getDate() + index);
		return dayKeyOf(day);
	});
}

// ---------------------------------------------------------------------------
// markdown 解析与回写
// ---------------------------------------------------------------------------

const CHECK_RE = /^(\s*(?:[-*]|\d+[.、])\s+)\[([ xX])\]\s*(.*)$/;
const TASK_META_RE = /\s*<!--\s*owl-task:\s*(\{.*\})\s*-->\s*$/;

function taskBody(body: string): { text: string; metadata: Record<string, unknown> } {
	const match = TASK_META_RE.exec(body);
	let metadata: Record<string, unknown> = {};
	if (match) {
		try {
			const value: unknown = JSON.parse(match[1]!);
			if (value && typeof value === "object" && !Array.isArray(value)) metadata = value as Record<string, unknown>;
		} catch {
			/* 损坏的元数据不影响原清单文本展示。 */
		}
	}
	return { text: (match ? body.slice(0, match.index) : body).trim(), metadata };
}

function isTodoStatus(value: unknown): value is MyselfTodoStatus {
	return value === "todo" || value === "doing" || value === "waiting" || value === "done";
}

function todoFromCheck(check: RegExpExecArray): { todo: MyselfTodo; explicitStatus: boolean } {
	const { text, metadata } = taskBody(check[3]!);
	const status = check[2]!.toLowerCase() === "x" ? "done" : isTodoStatus(metadata.status) ? metadata.status : "todo";
	const todo: MyselfTodo = { text, done: status === "done", status };
	for (const key of ["time", "category", "goal"] as const) {
		const value = metadata[key];
		if (typeof value === "string" && value.trim()) todo[key] = value.trim();
	}
	return { todo, explicitStatus: isTodoStatus(metadata.status) };
}

/** 解析一天的 markdown。解析规则宽容：段标题按 `## ` 前缀识别，顺序不敏感。 */
export function parseDay(raw: string, date: string): MyselfDay {
	const lines = raw.split(/\r?\n/);
	const day: MyselfDay = {
		date,
		title: date,
		todos: [],
		distilled: [],
		goals: [],
		summary: "",
		chat: [],
		notes: [],
		raw,
	};
	let section = "";
	let subsection = "";
	const summaryLines: string[] = [];
	// 「待办」与「完成情况」是同一份清单的两个投影：合并去重，状态以「完成情况」为准。
	const todoDraft: ReturnType<typeof todoFromCheck>[] = [];
	const doneDraft: ReturnType<typeof todoFromCheck>[] = [];

	for (const line of lines) {
		if (line.startsWith("# ") && day.title === date) {
			day.title = line.slice(2).trim();
			continue;
		}
		if (line.startsWith("## ")) {
			section = line.slice(3).trim();
			subsection = "";
			continue;
		}
		if (line.startsWith("### ")) {
			subsection = line.slice(4).trim();
			continue;
		}
		if (isSummarySection(section) || isSummarySection(subsection)) {
			summaryLines.push(line);
			continue;
		}
		const check = CHECK_RE.exec(line);
		if (check && (isTodoSection(section) || isDoneSection(section))) {
			(isTodoSection(section) ? todoDraft : doneDraft).push(todoFromCheck(check));
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

	const statusBy = new Map(doneDraft.map((draft) => [normalizeTodoText(draft.todo.text), draft]));
	const seen = new Set<string>();
	for (const { todo, explicitStatus } of todoDraft) {
		const key = normalizeTodoText(todo.text);
		if (seen.has(key)) continue;
		seen.add(key);
		const completed = statusBy.get(key);
		const status = completed
			? completed.todo.done || completed.explicitStatus || !explicitStatus
				? completed.todo.status
				: todo.status
			: todo.status;
		day.todos.push({ ...completed?.todo, ...todo, status, done: status === "done" });
	}
	for (const { todo } of doneDraft) {
		const key = normalizeTodoText(todo.text);
		if (!seen.has(key)) {
			day.todos.push(todo);
			seen.add(key);
		}
	}
	day.goals = [...day.distilled];
	day.summary = summaryLines.join("\n").trim();
	return day;
}

function isTodoSection(section: string): boolean {
	return section.startsWith("待办") || /^todo/i.test(section);
}
function isDoneSection(section: string): boolean {
	return section.startsWith("完成") || /^done|completed/i.test(section);
}
function isDistilledSection(section: string): boolean {
	return section.includes("提炼") || /^(?:AI\s+)?(?:distilled|focus)/i.test(section);
}
function isChatSection(section: string): boolean {
	return section.startsWith("对话") || /^chat|log/i.test(section);
}
function isSummarySection(section: string): boolean {
	return /^(?:今日总结|当天总结|总结|daily summary|summary)$/i.test(section);
}

/** 提炼行：`1. **标题** —— 说明`，也容忍没有加粗/破折号的普通编号行。 */
function parseDistilledLine(line: string): MyselfDistilled | undefined {
	const m = /^\s*(?:\d+[.、]\s+|[-*]\s+目标[：:]\s*)(.+)$/.exec(line);
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
	return updateTodoStatusInRaw(raw, text, done ? "done" : "todo");
}

/** 只遍历待办和完成清单，独立总结内的 checklist 不属于任务。 */
function taskLineIndexes(lines: string[], text: string): number[] {
	const needle = normalizeTodoText(text);
	let section = "";
	let subsection = "";
	const indexes: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith("## ")) {
			section = line.slice(3).trim();
			subsection = "";
		} else if (line.startsWith("### ")) subsection = line.slice(4).trim();
		if (
			(!isTodoSection(section) && !isDoneSection(section)) ||
			isSummarySection(section) ||
			isSummarySection(subsection)
		)
			continue;
		const check = CHECK_RE.exec(line);
		if (check && normalizeTodoText(taskBody(check[3]!).text) === needle) indexes.push(i);
	}
	return indexes;
}

function newlineOf(raw: string): string {
	return raw.includes("\r\n") ? "\r\n" : "\n";
}

function withTaskMetadata(line: string, metadata: Record<string, unknown>): string {
	const body = line.replace(TASK_META_RE, "");
	if (Object.keys(metadata).length === 0) return body;
	// JSON 字符串里的 --> 不得提前结束 HTML 注释。
	const json = JSON.stringify(metadata).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
	return `${body} <!-- owl-task:${json} -->`;
}

/** 修改状态，不改任务原文；旧清单仅改 checkbox，不额外添加多余注释。 */
export function updateTodoStatusInRaw(raw: string, text: string, status: MyselfTodoStatus): string {
	if (!isTodoStatus(status)) throw new Error(`invalid todo status: ${status}`);
	const lines = raw.split(/\r?\n/);
	const indexes = taskLineIndexes(lines, text);
	for (const index of indexes) {
		const line = lines[index]!;
		const check = CHECK_RE.exec(line)!;
		const { metadata } = taskBody(check[3]!);
		if (TASK_META_RE.test(line) || status === "doing" || status === "waiting") metadata.status = status;
		lines[index] = withTaskMetadata(line.replace(/\[[ xX]\]/, `[${status === "done" ? "x" : " "}]`), metadata);
	}
	return indexes.length ? lines.join(newlineOf(raw)) : raw;
}

export function updateTodoMetadataInRaw(
	raw: string,
	text: string,
	patch: Partial<Pick<MyselfTodoMetadata, "time" | "category" | "goal">>,
): string {
	if (!["time", "category", "goal"].some((key) => Object.hasOwn(patch, key))) return raw;
	const lines = raw.split(/\r?\n/);
	const indexes = taskLineIndexes(lines, text);
	for (const index of indexes) {
		const { metadata } = taskBody(CHECK_RE.exec(lines[index]!)![3]!);
		for (const key of ["time", "category", "goal"] as const) {
			if (!Object.hasOwn(patch, key)) continue;
			const value = patch[key];
			if (typeof value === "string" && value.trim()) metadata[key] = value.trim();
			else delete metadata[key];
		}
		lines[index] = withTaskMetadata(lines[index]!, metadata);
	}
	return indexes.length ? lines.join(newlineOf(raw)) : raw;
}

function insertInSection(raw: string, matches: (section: string) => boolean, heading: string, content: string): string {
	const newline = newlineOf(raw);
	const lines = raw.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith("## ") && matches(line.slice(3).trim()));
	if (start < 0)
		return `${raw}${raw.endsWith(newline) ? newline : raw ? newline + newline : ""}${heading}${newline}${newline}${content}${newline}`;
	let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	if (end < 0) end = lines.length;
	while (end > start + 1 && lines[end - 1] === "") end--;
	lines.splice(end, 0, ...content.split(/\r?\n/));
	return lines.join(newline);
}

/** 在待办段新增一行，不把新任务复制到完成段。 */
export function addTodoInRaw(raw: string, text: string, metadata: MyselfTodoMetadata = {}): string {
	const title = text.replace(/\s*\r?\n\s*/g, " ").trim();
	if (!title || taskLineIndexes(raw.split(/\r?\n/), title).length) return raw;
	const status = metadata.status ?? "todo";
	const fields: Record<string, unknown> = {};
	for (const key of ["time", "category", "goal"] as const) {
		if (metadata[key]?.trim()) fields[key] = metadata[key]!.trim();
	}
	if (status === "doing" || status === "waiting") fields.status = status;
	const line = withTaskMetadata(`- [${status === "done" ? "x" : " "}] ${title}`, fields);
	return insertInSection(raw, isTodoSection, "## 待办（手记）", line);
}

/** 迁移同名清单投影，原日期的对话、总结和其余正文保留。目标已有同名时不降级完成状态。 */
export function moveTodoToTomorrow(
	sourceRaw: string,
	targetRaw: string,
	text: string,
	sourceDate: string,
	lang: "zh" | "en" = "zh",
): { sourceRaw: string; targetRaw: string; targetDate: string } {
	const targetDate = nextDayKey(sourceDate);
	const lines = sourceRaw.split(/\r?\n/);
	const indexes = taskLineIndexes(lines, text);
	if (!indexes.length) return { sourceRaw, targetRaw, targetDate };
	const source = parseDay(sourceRaw, sourceDate).todos.find(
		(todo) => normalizeTodoText(todo.text) === normalizeTodoText(text),
	)!;
	let nextTarget = targetRaw || newDayTemplate(targetDate, lang);
	const existing = parseDay(nextTarget, targetDate).todos.find(
		(todo) => normalizeTodoText(todo.text) === normalizeTodoText(text),
	);
	if (existing) {
		if (source.done || existing.status === "todo")
			nextTarget = updateTodoStatusInRaw(nextTarget, text, source.status);
		const patch: Partial<Pick<MyselfTodoMetadata, "time" | "category" | "goal">> = {};
		for (const key of ["time", "category", "goal"] as const)
			if (!existing[key] && source[key]) patch[key] = source[key];
		nextTarget = updateTodoMetadataInRaw(nextTarget, text, patch);
	} else {
		let line = lines[indexes[0]!]!;
		const fields = taskBody(CHECK_RE.exec(line)![3]!).metadata;
		for (const key of ["time", "category", "goal"] as const) if (source[key]) fields[key] = source[key];
		if (TASK_META_RE.test(line) || source.status === "doing" || source.status === "waiting")
			fields.status = source.status;
		line = withTaskMetadata(line.replace(/\[[ xX]\]/, `[${source.done ? "x" : " "}]`), fields);
		nextTarget = insertInSection(nextTarget, isTodoSection, lang === "en" ? "## Todos" : "## 待办（手记）", line);
	}
	const removed = new Set(indexes);
	return {
		sourceRaw: lines.filter((_, index) => !removed.has(index)).join(newlineOf(sourceRaw)),
		targetRaw: nextTarget,
		targetDate,
	};
}

/** 总结是完成段内独立正文；更新只替换该子段，不修改完成 checklist。 */
export function updateSummaryInRaw(raw: string, summary: string): string {
	const newline = newlineOf(raw);
	const lines = raw.split(/\r?\n/);
	const start = lines.findIndex(
		(line) => /^#{2,3} /.test(line) && isSummarySection(line.replace(/^#{2,3} /, "").trim()),
	);
	if (start < 0) return insertInSection(raw, isDoneSection, "## 完成情况", `\n### 今日总结\n\n${summary.trim()}\n`);
	const level = /^#+/.exec(lines[start]!)![0].length;
	let end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}} `).test(line));
	if (end < 0) end = lines.length;
	lines.splice(start + 1, end - start - 1, "", ...summary.trim().split(/\r?\n/), "");
	return lines.join(newline);
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
	return insertInSection(raw, isChatSection, "## 对话", line);
}

/** 新建一天的初始文件内容（段落骨架与示例数据一致）。 */
export function newDayTemplate(dateKey: string, lang: "zh" | "en"): string {
	const weekday = new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", { weekday: "long" }).format(
		new Date(`${dateKey}T12:00:00`),
	);
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
export async function resolveMyselfDir(
	client: BridgeClient,
	workspaceDir?: string,
	agentDir?: string,
): Promise<string | null> {
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
	const response = await client.request<{ path: string; size: number }>({
		type: "fs.write",
		cwd: dir,
		path: `${date}.md`,
		content,
	});
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
			`When the user reports today's tasks, save them as todos. Recording a task does not authorize implementing that task; retain the full Agent capabilities for explicit requests to do the work.`,
			`A todo is a checkbox line. Optional status/time/category/goal use a trailing HTML comment, for example: <!-- owl-task:{"status":"waiting","time":"14:00","category":"work","goal":"Goal title"} -->. Status is todo/doing/waiting/done; omit unknown fields. Goals come from AI distilled; summary is a separate ### Summary subsection under Completed, based on actual completion and the user's report.`,
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
		`用户报今天的任务时，先原样记入待办；记录任务不等于授权执行任务。用户明确要求处理或开发时，再使用完整 Agent 能力推进。`,
		`待办使用 checkbox 行；可选状态/时间/分类/目标放在行尾注释，例如 <!-- owl-task:{"status":"waiting","time":"14:00","category":"工作","goal":"目标标题"} -->。status 可为 todo/doing/waiting/done；未提供的字段不要编造。目标来自 AI 提炼段；今日总结放在完成情况段内的 ### 今日总结，依据实际勾选与用户补充，不把待办目标当成已完成。`,
		`---`,
		"",
	].join("\n");
}
