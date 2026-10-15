import { useEffect, useRef, useState } from "react";
import type { NewsLeaderboardResponse } from "../../../../../packages/coding-agent/src/core/news/types.ts";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import { errorText, type NewsClient } from "./news-client.ts";
import "./leaderboard.css";

const copy = {
	zh: {
		title: "模型测评排行榜",
		intro: "跟踪公开测评的最新结果。每个榜单单独排名，分数不能跨榜比较。",
		general: "综合能力",
		coding: "代码修复",
		loading: "正在同步官方榜单…",
		refresh: "同步榜单",
		retry: "重试同步",
		search: "搜索模型或机构",
		rank: "排名",
		model: "模型",
		score: "得分",
		detail: "测评说明",
		checked: "最近同步",
		version: "测评版本",
		submitted: "最近评测提交",
		unknown: "来源未提供",
		never: "尚未同步成功",
		source: "查看官方榜单",
		stale: "本次同步未成功，保留上次结果",
		fresh: "已同步",
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
			"Follow the latest public evaluations. Each benchmark ranks independently; scores are not comparable across boards.",
		general: "General capability",
		coding: "Code repair",
		loading: "Syncing official results…",
		refresh: "Sync results",
		retry: "Retry sync",
		search: "Search models or organizations",
		rank: "Rank",
		model: "Model",
		score: "Score",
		detail: "Evaluation notes",
		checked: "Last synced",
		version: "Benchmark version",
		submitted: "Latest submission",
		unknown: "Not provided",
		never: "Not yet synced",
		source: "Official leaderboard",
		stale: "Sync failed; showing the previous results",
		fresh: "Synced",
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
	const [selected, setSelected] = useState("livebench-overall");
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
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
				if (current) setData(next);
			} catch (failure) {
				if (current) setError(errorText(failure));
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
	const board = data?.boards.find((entry) => entry.id === selected) ?? data?.boards[0];
	const normalized = query.trim().toLowerCase();
	const entries =
		board?.entries.filter((entry) => `${entry.model} ${entry.organization ?? ""}`.toLowerCase().includes(normalized)) ??
		[];
	const visible = expanded || normalized ? entries : entries.slice(0, 20);
	function formatDate(value: string | null, fallback: string): string {
		if (!value || !Number.isFinite(Date.parse(value))) return fallback;
		return new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
			dateStyle: "medium",
			timeStyle: "short",
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
				{(
					data?.boards ?? [
						{ id: "livebench-overall", category: "general", title: "LiveBench" },
						{ id: "swe-bench-verified", category: "coding", title: "SWE-bench Verified" },
					]
				).map((entry) => (
					<button
						type="button"
						key={entry.id}
						aria-pressed={(board?.id ?? selected) === entry.id}
						onClick={() => {
							setSelected(entry.id);
							setExpanded(false);
						}}
					>
						<strong>{entry.category === "general" ? text.general : text.coding}</strong>
						<span>{entry.title}</span>
					</button>
				))}
			</div>
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
							<dt>{board.category === "coding" ? text.submitted : text.version}</dt>
							<dd>{board.updatedAt ?? text.unknown}</dd>
						</div>
						<div>
							<dt>{text.score}</dt>
							<dd>
								{board.metric}
								{board.scoreUnit ? ` · ${board.scoreUnit}` : ""}
							</dd>
						</div>
					</dl>
					{board.stale || board.error ? (
						<div className="owl-news-notice" role="status">
							<strong>{board.entries.length ? text.stale : text.unavailable}</strong>
							{board.error && <p>{board.error}</p>}
						</div>
					) : (
						board.checkedAt && (
							<p className="owl-leaderboard-status">
								{text.fresh} · {board.sourceName}
							</p>
						)
					)}
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
