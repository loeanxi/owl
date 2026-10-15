import { useEffect, useRef, useState } from "react";
import type { NewsLeaderboardResponse } from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import { errorText, type NewsClient } from "./news-client.ts";
import "./leaderboard.css";

const copy = {
	zh: {
		title: "模型测评排行榜",
		intro: "直接查看公开测评结果，并标明来源更新时间。每个榜单单独排名，分数不能跨榜比较。",
		references: "历史与参考榜单",
		referenceHint: "这些榜单保留作测评参考，可能未覆盖近期发布的模型。",
		reference: "参考榜单",
		loading: "正在同步官方榜单…",
		refresh: "同步榜单",
		retry: "重试同步",
		search: "搜索模型或机构",
		rank: "排名",
		model: "模型",
		score: "得分",
		detail: "测评说明",
		checked: "最近同步",
		published: "来源数据更新",
		unknown: "来源未提供更新时间",
		never: "尚未同步成功",
		source: "查看官方榜单",
		stale: "本次同步未成功，保留上次结果",
		fresh: "同步成功",
		outdated: "同步成功，测评数据较旧",
		unknownAge: "同步成功，来源未提供更新时间",
		outdatedData: "测评数据较旧",
		agePrefix: "距离来源最近一次更新已过",
		ageSuffix: "天",
		unknownHint: "已获取来源结果，但无法核验评测数据的新旧。",
		unavailable: "暂时无法获取这个榜单",
		empty: "没有匹配的模型",
		clear: "清空搜索",
		more: "显示全部",
		less: "只看前 20 名",
		models: "个模型",
		cadence: "分钟自动检查一次；以来源实际发布时间为准。",
		cadencePrefix: "浏览期间每",
		data: "原始数据",
		disclaimer: "测评只覆盖特定任务和运行条件。选择模型时，也请考虑中文表现、价格和你的实际任务。",
	},
	en: {
		title: "Model leaderboards",
		intro:
			"View public evaluations with their source update dates. Each benchmark ranks independently; scores are not comparable across boards.",
		references: "Historical and reference leaderboards",
		referenceHint: "Retained for reference; these evaluations may not cover recently released models.",
		reference: "Reference leaderboard",
		loading: "Syncing official results…",
		refresh: "Sync results",
		retry: "Retry sync",
		search: "Search models or organizations",
		rank: "Rank",
		model: "Model",
		score: "Score",
		detail: "Evaluation notes",
		checked: "Last synced",
		published: "Source data updated",
		unknown: "Source update date not provided",
		never: "Not yet synced",
		source: "Official leaderboard",
		stale: "Sync failed; showing the previous results",
		fresh: "Sync successful",
		outdated: "Sync successful; evaluation data is older",
		unknownAge: "Sync successful; source update date not provided",
		outdatedData: "Older evaluation data",
		agePrefix: "Source last updated",
		ageSuffix: "days ago",
		unknownHint: "Results were retrieved, but the age of the evaluation data could not be verified.",
		unavailable: "This leaderboard is currently unavailable",
		empty: "No matching models",
		clear: "Clear search",
		more: "Show all",
		less: "Show top 20",
		models: "models",
		cadence: "minutes while open; results follow the source's publishing schedule.",
		cadencePrefix: "Checks every",
		data: "Source data",
		disclaimer:
			"Benchmarks cover specific tasks and execution conditions. Consider language support, price and your own tasks when choosing a model.",
	},
};

export function NewsLeaderboard({
	api,
	active,
	revision,
}: {
	api: NewsClient;
	active: boolean;
	revision: number;
}): React.JSX.Element {
	useT();
	const language = getUiLanguage();
	const text = copy[language];
	const [data, setData] = useState<NewsLeaderboardResponse>();
	const [selected, setSelected] = useState("");
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [syncError, setSyncError] = useState(false);
	const [reload, setReload] = useState(0);
	const previousRevision = useRef(revision);
	const previousReload = useRef(reload);
	useEffect(() => {
		if (!active) return;
		let current = true;
		let pending = false;
		const force = revision !== previousRevision.current || reload !== previousReload.current;
		previousRevision.current = revision;
		previousReload.current = reload;
		async function sync(forceRefresh: boolean): Promise<void> {
			if (pending) return;
			pending = true;
			setBusy(true);
			setError("");
			try {
				const next = await api.query({ action: "leaderboard", force: forceRefresh });
				if (current) {
					setData(next);
					setSyncError(false);
				}
			} catch (failure) {
				if (current) {
					setError(errorText(failure));
					setSyncError(true);
				}
			} finally {
				pending = false;
				if (current) setBusy(false);
			}
		}
		void sync(force);
		const timer = setInterval(() => {
			if (!document.hidden) void sync(false);
		}, 60_000);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [api, active, revision, reload]);
	const primaryBoards = data?.boards.filter((entry) => !entry.reference) ?? [];
	const referenceBoards = data?.boards.filter((entry) => entry.reference) ?? [];
	const board =
		data?.boards.find((entry) => entry.id === selected) ??
		primaryBoards.find((entry) => entry.freshness?.state === "current") ??
		primaryBoards[0] ??
		referenceBoards[0];
	const freshness = board?.freshness?.state ?? "unknown";
	const syncFailed = Boolean(syncError || board?.stale || board?.error);
	const normalized = query.trim().toLowerCase();
	const entries =
		board?.entries.filter((entry) => `${entry.model} ${entry.organization ?? ""}`.toLowerCase().includes(normalized)) ??
		[];
	const visible = expanded || normalized ? entries : entries.slice(0, 20);
	function formatDate(value: string | null, fallback: string, includeTime = true): string {
		if (!value || !Number.isFinite(Date.parse(value))) return fallback;
		return new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
			dateStyle: "medium",
			...(includeTime ? { timeStyle: "short" } : /^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: "UTC" } : {}),
		});
	}
	function open(url: string): void {
		void api.openUrl(url).catch((failure: unknown) => setError(errorText(failure)));
	}
	return (
		<section className="owl-leaderboard" aria-label={text.title} aria-busy={busy}>
			<div className="owl-leaderboard-heading">
				<div>
					<h1>{text.title}</h1>
					<p>{text.intro}</p>
				</div>
				<button
					type="button"
					className="owl-news-primary"
					disabled={busy}
					onClick={() => setReload((value) => value + 1)}
				>
					{busy ? text.loading : text.refresh}
				</button>
			</div>
			<div className="owl-leaderboard-tabs" aria-label={text.title}>
				{primaryBoards.map((entry) => (
					<button
						type="button"
						key={entry.id}
						aria-pressed={board?.id === entry.id}
						onClick={() => {
							setSelected(entry.id);
							setExpanded(false);
						}}
					>
						<strong>{entry.tabLabel ?? entry.sourceName}</strong>
						<span>{entry.title}</span>
					</button>
				))}
			</div>
			{referenceBoards.length > 0 && (
				<details className="owl-leaderboard-references">
					<summary>{text.references}</summary>
					<p>{text.referenceHint}</p>
					<div className="owl-leaderboard-tabs" aria-label={text.references}>
						{referenceBoards.map((entry) => (
							<button
								type="button"
								key={entry.id}
								aria-pressed={board?.id === entry.id}
								onClick={() => {
									setSelected(entry.id);
									setExpanded(false);
								}}
							>
								<strong>{entry.tabLabel ?? entry.sourceName}</strong>
								<span>{entry.title}</span>
							</button>
						))}
					</div>
				</details>
			)}
			{error && (
				<p className="owl-news-error" role="alert">
					{error}
					<button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>
						{text.retry}
					</button>
				</p>
			)}
			{!data && busy && (
				<p className="owl-news-empty" role="status">
					{text.loading}
				</p>
			)}
			{board && (
				<>
					<div className="owl-leaderboard-source">
						<div>
							<h2>{board.title}</h2>
							{board.reference && <span className="owl-leaderboard-reference-label">{text.reference}</span>}
							<p>{board.description}</p>
						</div>
						<button type="button" onClick={() => open(board.sourceUrl)}>
							{text.source}
						</button>
					</div>
					<dl className="owl-leaderboard-meta">
						<div>
							<dt>{text.checked}</dt>
							<dd>{formatDate(board.checkedAt, text.never)}</dd>
						</div>
						<div>
							<dt>{text.published}</dt>
							<dd>{formatDate(board.updatedAt, text.unknown, false)}</dd>
						</div>
						<div>
							<dt>{text.score}</dt>
							<dd>
								{board.metric}
								{board.scoreUnit ? ` · ${board.scoreUnit}` : ""}
							</dd>
						</div>
					</dl>
					<div
						className="owl-leaderboard-status"
						data-freshness={freshness}
						data-sync={syncFailed || !board.entries.length ? "failed" : board.checkedAt ? "success" : "pending"}
						role="status"
					>
						<strong>
							{!board.entries.length
								? text.unavailable
								: syncFailed
									? text.stale
									: !board.checkedAt
										? text.never
										: freshness === "outdated"
											? text.outdated
											: freshness === "unknown"
												? text.unknownAge
												: `${text.fresh} · ${board.sourceName}`}
						</strong>
						{freshness === "outdated" && (
							<p>
								{syncFailed ? `${text.outdatedData} · ` : ""}
								{board.freshness?.ageDays != null
									? `${text.agePrefix} ${board.freshness.ageDays} ${text.ageSuffix}`
									: board.freshness?.reason}
							</p>
						)}
						{freshness === "unknown" && board.entries.length > 0 && <p>{text.unknownHint}</p>}
						{board.freshness?.reason && board.freshness.ageDays != null && <p>{board.freshness.reason}</p>}
						{board.error && <p>{board.error}</p>}
					</div>
					{board.entries.length > 0 ? (
						<>
							<div className="owl-leaderboard-tools">
								<input
									type="search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder={text.search}
									aria-label={text.search}
								/>
								<span>
									{entries.length} {text.models}
								</span>
							</div>
							{visible.length ? (
								<div className="owl-leaderboard-scroll">
									<table>
										<caption>
											{board.title} · {board.metric}
										</caption>
										<thead>
											<tr>
												<th scope="col">{text.rank}</th>
												<th scope="col">{text.model}</th>
												<th scope="col" className="owl-leaderboard-score">
													{text.score}
												</th>
												<th scope="col">{text.detail}</th>
											</tr>
										</thead>
										<tbody>
											{visible.map((entry) => (
												<tr key={entry.id}>
													<td className="owl-leaderboard-rank">{entry.rank}</td>
													<th scope="row">
														<strong>{entry.model}</strong>
														{entry.organization && <small>{entry.organization}</small>}
													</th>
													<td className="owl-leaderboard-score">
														{entry.score.toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
															maximumFractionDigits: 2,
															minimumFractionDigits: 1,
														})}
														{board.scoreUnit === "%" ? "%" : ""}
													</td>
													<td className="owl-leaderboard-detail">{entry.detail || "—"}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							) : (
								<div className="owl-news-empty">
									<p>{text.empty}</p>
									<button type="button" onClick={() => setQuery("")}>
										{text.clear}
									</button>
								</div>
							)}
							{!normalized && entries.length > 20 && (
								<button type="button" className="owl-leaderboard-more" onClick={() => setExpanded((value) => !value)}>
									{expanded ? text.less : `${text.more} (${entries.length})`}
								</button>
							)}
						</>
					) : (
						<div className="owl-news-empty">
							<h2>{text.unavailable}</h2>
							<button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>
								{text.retry}
							</button>
						</div>
					)}
					<footer className="owl-leaderboard-footer">
						<p>
							{text.cadencePrefix} {data?.refreshIntervalMinutes ?? 30} {text.cadence}
						</p>
						<p>{text.disclaimer}</p>
						<button type="button" onClick={() => open(board.dataUrl)}>
							{text.data}
						</button>
					</footer>
				</>
			)}
		</section>
	);
}
