import { useMemo, useState, useSyncExternalStore } from "react";
import changelogMarkdown from "../../../../../CHANGELOG.md?raw";
import { getUiLanguage, subscribeUiLanguage } from "../../i18n/index.ts";
import { CHANGELOG_KINDS, filterChangelog, parseChangelog, type ChangelogKind } from "./changelog.ts";
import { SectionHeader } from "./settings-widgets.tsx";

const DAY_PAGE = 14;

const KIND_SLUG: Record<ChangelogKind, string> = {
	新增: "added",
	改进: "improved",
	修复: "fixed",
	移除: "removed",
	维护: "maintenance",
};

const COPY = {
	zh: {
		nav: "更新日志",
		title: "更新日志",
		description: "记录 Owl 每次提交带来的变化，内容来自仓库根目录 CHANGELOG.md，随桌面端构建打包。",
		searchLabel: "搜索更新日志",
		searchPlaceholder: "按说明或模块搜索，例如 desktop",
		all: "全部",
		kinds: { 新增: "新增", 改进: "改进", 修复: "修复", 移除: "移除", 维护: "维护" } as Record<ChangelogKind, string>,
		filterLabel: "按类别筛选",
		count: (n: number) => `${n} 条`,
		empty: "没有匹配的记录。",
		more: (n: number) => `显示更早的记录（还有 ${n} 天）`,
		locale: "zh-CN",
	},
	en: {
		nav: "Changelog",
		title: "Changelog",
		description: "Changes introduced by each Owl commit, read from CHANGELOG.md at the repository root and bundled with the desktop build.",
		searchLabel: "Search changelog",
		searchPlaceholder: "Search by description or module, e.g. desktop",
		all: "All",
		kinds: { 新增: "Added", 改进: "Improved", 修复: "Fixed", 移除: "Removed", 维护: "Maintenance" } as Record<ChangelogKind, string>,
		filterLabel: "Filter by category",
		count: (n: number) => (n === 1 ? "1 entry" : `${n} entries`),
		empty: "No matching entries.",
		more: (n: number) => `Show earlier entries (${n} more days)`,
		locale: "en-US",
	},
};

export function useChangelogCopy(): (typeof COPY)["zh"] {
	return COPY[useSyncExternalStore(subscribeUiLanguage, getUiLanguage)];
}

/** 说明里的 `code` 片段渲染成等宽小块，其余按原文输出。 */
function EntryText({ text }: { text: string }): React.JSX.Element {
	return (
		<>
			{text.split("`").map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))}
		</>
	);
}

export function ChangelogSection(): React.JSX.Element {
	const copy = useChangelogCopy();
	const days = useMemo(() => parseChangelog(changelogMarkdown), []);
	const [kind, setKind] = useState<ChangelogKind | undefined>();
	const [query, setQuery] = useState("");
	const [dayLimit, setDayLimit] = useState(DAY_PAGE);

	const searched = useMemo(() => filterChangelog(days, { query }), [days, query]);
	const visible = useMemo(() => filterChangelog(searched, { kind }), [searched, kind]);
	const kindCounts = useMemo(() => {
		const counts = new Map<ChangelogKind, number>();
		for (const day of searched) for (const entry of day.entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
		return counts;
	}, [searched]);
	const totalCount = [...kindCounts.values()].reduce((sum, n) => sum + n, 0);
	const weekday = new Intl.DateTimeFormat(copy.locale, { weekday: "short" });

	return (
		<>
			<SectionHeader title={copy.title} desc={copy.description} />
			<div className="owl-changelog-toolbar">
				<input
					type="search"
					className="owl-settings-input"
					aria-label={copy.searchLabel}
					placeholder={copy.searchPlaceholder}
					value={query}
					onChange={(event) => {
						setQuery(event.currentTarget.value);
						setDayLimit(DAY_PAGE);
					}}
				/>
				<div className="owl-settings-filter-chips" role="group" aria-label={copy.filterLabel}>
					<button
						type="button"
						className={`owl-settings-filter-chip ${kind ? "" : "is-active"}`}
						aria-pressed={!kind}
						onClick={() => setKind(undefined)}
					>
						{copy.all}
						<span className="owl-settings-filter-chip-count">{totalCount}</span>
					</button>
					{CHANGELOG_KINDS.filter((item) => kindCounts.has(item)).map((item) => (
						<button
							key={item}
							type="button"
							className={`owl-settings-filter-chip ${kind === item ? "is-active" : ""}`}
							aria-pressed={kind === item}
							onClick={() => setKind(item)}
						>
							{copy.kinds[item]}
							<span className="owl-settings-filter-chip-count">{kindCounts.get(item)}</span>
						</button>
					))}
				</div>
			</div>

			{visible.length === 0 && <div className="owl-settings-notice">{copy.empty}</div>}

			<div className="owl-changelog-days">
				{visible.slice(0, dayLimit).map((day) => (
					<section key={day.date} className="owl-changelog-day" aria-label={day.date}>
						<header className="owl-changelog-day-head">
							<time dateTime={day.date}>{day.date}</time>
							<span>{weekday.format(new Date(`${day.date}T00:00:00`))}</span>
							<span className="owl-changelog-day-count">{copy.count(day.entries.length)}</span>
						</header>
						{CHANGELOG_KINDS.map((item) => {
							const entries = day.entries.filter((entry) => entry.kind === item);
							if (entries.length === 0) return null;
							return (
								<div key={item} className="owl-changelog-group">
									<span className="owl-changelog-kind" data-kind={KIND_SLUG[item]}>{copy.kinds[item]}</span>
									<ul>
										{entries.map((entry, index) => (
											<li key={index}>
												{entry.scope && <span className="owl-changelog-scope">{entry.scope}</span>}
												<span><EntryText text={entry.text} /></span>
											</li>
										))}
									</ul>
								</div>
							);
						})}
					</section>
				))}
			</div>

			{visible.length > dayLimit && (
				<div className="flex justify-center">
					<button type="button" className="owl-settings-button" onClick={() => setDayLimit((n) => n + DAY_PAGE)}>
						{copy.more(visible.length - dayLimit)}
					</button>
				</div>
			)}
		</>
	);
}
