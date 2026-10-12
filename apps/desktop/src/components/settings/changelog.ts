/** 仓库根 CHANGELOG.md 的类别标题；顺序即页面展示顺序。 */
export const CHANGELOG_KINDS = ["新增", "改进", "修复", "移除", "维护"] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

export interface ChangelogEntry {
	kind: ChangelogKind;
	scope?: string;
	text: string;
}

export interface ChangelogDay {
	date: string;
	entries: ChangelogEntry[];
}

const DAY_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const KIND_HEADING = /^###\s+(\S+)\s*$/;
const ENTRY = /^[-*]\s+(?:`([^`]+)`\s+)?(.+?)\s*$/;

function isKind(value: string): value is ChangelogKind {
	return (CHANGELOG_KINDS as readonly string[]).includes(value);
}

/**
 * 解析 `## 日期` → `### 类别` → `- \`scope\` 说明` 三层结构。
 * 不认识的类别标题下的条目丢弃，避免格式写错的内容混进别的类别。
 */
export function parseChangelog(markdown: string): ChangelogDay[] {
	const days: ChangelogDay[] = [];
	let day: ChangelogDay | undefined;
	let kind: ChangelogKind | undefined;
	for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
		const line = raw.trim();
		const dayMatch = DAY_HEADING.exec(line);
		if (dayMatch) {
			day = { date: dayMatch[1], entries: [] };
			days.push(day);
			kind = undefined;
			continue;
		}
		const kindMatch = KIND_HEADING.exec(line);
		if (kindMatch) {
			kind = isKind(kindMatch[1]) ? kindMatch[1] : undefined;
			continue;
		}
		if (/^#{1,2}\s/.test(line)) {
			day = undefined;
			kind = undefined;
			continue;
		}
		const entryMatch = ENTRY.exec(line);
		if (entryMatch && day && kind) {
			day.entries.push(entryMatch[1] ? { kind, scope: entryMatch[1], text: entryMatch[2] } : { kind, text: entryMatch[2] });
		}
	}
	return days.filter((item) => item.entries.length > 0).sort((a, b) => b.date.localeCompare(a.date));
}

/** 按类别与关键词（匹配说明或 scope，不区分大小写）过滤，去掉过滤后为空的日期。 */
export function filterChangelog(days: ChangelogDay[], filter: { kind?: ChangelogKind; query?: string }): ChangelogDay[] {
	const query = filter.query?.trim().toLowerCase() ?? "";
	return days
		.map((day) => ({
			date: day.date,
			entries: day.entries.filter(
				(entry) =>
					(!filter.kind || entry.kind === filter.kind)
					&& (!query || entry.text.toLowerCase().includes(query) || (entry.scope?.toLowerCase().includes(query) ?? false)),
			),
		}))
		.filter((day) => day.entries.length > 0);
}
