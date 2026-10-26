/**
 * 变动 tab 的「历史」视图：单仓库提交列表（按天分组、单轨道）、原地展开详情、
 * 提交 diff、悬停详情卡、右键菜单，以及 GitHub 增强（CI 标记、在 GitHub 打开、
 * 未推送提示条 + 推送）。CI 状态经宿主的 gh 查询，gh 不可用时静默隐藏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import type { GitCiState, GitCommitDetail, GitCommitFile, GitHistoryEntry, GitHistoryResult, GitRef, GitWorkspaceRepo } from "../../bridge/protocol.ts";
import type { SidebarApi } from "../api.ts";
import { DiffView } from "../DiffView.tsx";
import { IconCopy, IconExternal, IconGitBranch, IconLoader, IconRefresh, IconSearch, IconX } from "../icons.tsx";

const PAGE = 50;
const MAX_PAGE = 200;
const HOVER_DELAY_MS = 450;
const CI_RETRY_MS = 30_000;
const FILES_PREVIEW = 8;
const REFRESH_DEBOUNCE_MS = 400;

type Against = "parent" | "worktree";
type Translate = ReturnType<typeof useT>;

/** 仓库下拉里的名字：workspace 根自身的仓库（"."）显示为目录名，与 VS Code 一致。 */
export function repoDisplayName(root: string, cwd: string): string {
	return root === "." ? (cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? root) : root;
}

export interface HistoryViewProps {
	api: SidebarApi;
	cwd: string;
	/** 多仓库模式下的各仓库（workspace 相对根，根自身为 "."）；单仓库为空。 */
	repos: GitWorkspaceRepo[];
	initialRepo?: string;
	/** 头部左侧的「变动 / 历史」切换。 */
	modeSwitch: React.ReactNode;
	/** gitStatus 每次刷新都是新对象：提交、拉取后据此同步历史。 */
	statusVersion: unknown;
	onGitRefresh: () => void;
	onToChat?: (text: string) => void;
}

function locale(): string {
	return getUiLanguage() === "zh" ? "zh-CN" : "en-US";
}

/** Conventional Commits 前缀单独弱化显示。 */
function splitType(subject: string): { type: string; text: string } {
	const match = /^([a-z]+(?:\([^)]*\))?!?):\s*(.+)$/i.exec(subject);
	return match ? { type: match[1]!, text: match[2]! } : { type: "", text: subject };
}

function relativeTime(seconds: number, t: Translate): string {
	const diff = Date.now() - seconds * 1000;
	const minute = 60_000;
	const hour = 3_600_000;
	const day = 86_400_000;
	if (diff < minute) return t("sidebar.relativeNow");
	if (diff < hour) return t("sidebar.relativeMinutes", { n: Math.floor(diff / minute) });
	if (diff < day) return t("sidebar.relativeHours", { n: Math.floor(diff / hour) });
	if (diff < 7 * day) return t("sidebar.relativeDays", { n: Math.floor(diff / day) });
	return new Date(seconds * 1000).toLocaleDateString(locale(), { month: "short", day: "numeric" });
}

function dayKey(seconds: number): string {
	const date = new Date(seconds * 1000);
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(seconds: number, t: Translate): string {
	const date = new Date(seconds * 1000);
	const now = new Date();
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (dayKey(seconds) === dayKey(now.getTime() / 1000)) return t("history.today");
	if (dayKey(seconds) === dayKey(yesterday.getTime() / 1000)) return t("history.yesterday");
	return date.toLocaleDateString(locale(), {
		...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
		month: "long",
		day: "numeric",
		weekday: "short",
	});
}

function fullTime(seconds: number): string {
	return new Date(seconds * 1000).toLocaleString(locale(), {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function refLabel(ref: GitRef): string {
	return ref.kind === "head" && ref.name !== "HEAD" ? `HEAD → ${ref.name}` : ref.name;
}

function refClass(ref: GitRef): string {
	if (ref.kind === "remote") return "border-sky-300/35 bg-sky-300/10 text-sky-300";
	if (ref.kind === "tag") return "border-amber-300/35 bg-amber-300/10 text-amber-300";
	return "border-owl-accent/40 bg-owl-accent/15 text-owl-accent";
}

function fileStatusClass(status: string): string {
	if (status === "A") return "text-emerald-300";
	if (status === "D") return "text-red-400";
	if (status === "R" || status === "C") return "text-sky-300";
	return "text-amber-300";
}

function CiMark({ state, t }: { state: GitCiState | undefined; t: Translate }): React.JSX.Element | null {
	if (state === undefined) return null;
	if (state === "success") return <span className="text-[11px] text-emerald-300" title={t("history.ciSuccess")}>✓</span>;
	if (state === "failure") return <span className="text-[11px] text-red-300" title={t("history.ciFailure")}>✕</span>;
	return <span className="animate-pulse text-[10px] text-amber-300" title={t("history.ciPending")}>●</span>;
}

function ciText(state: GitCiState | undefined, t: Translate): string | undefined {
	if (state === "success") return `✓ ${t("history.ciSuccess")}`;
	if (state === "failure") return `✕ ${t("history.ciFailure")}`;
	if (state === "pending") return `● ${t("history.ciPending")}`;
	return undefined;
}

function ciColor(state: GitCiState | undefined): string {
	return state === "success" ? "text-emerald-300" : state === "failure" ? "text-red-300" : "text-amber-300";
}

/** 增删比例条：5 格，绿格数按新增占比取整。 */
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }): React.JSX.Element {
	const total = additions + deletions;
	const green = total === 0 ? 0 : Math.round((additions / total) * 5);
	return (
		<span className="ml-1 inline-flex gap-px align-middle">
			{Array.from({ length: 5 }, (_, index) => (
				<i key={index} className={`h-[7px] w-[5px] rounded-[1px] ${total === 0 ? "bg-owl-border" : index < green ? "bg-emerald-400" : "bg-red-400"}`} />
			))}
		</span>
	);
}

/** 穿过日期标题、详情块的轨道线，与提交行内的轨道对齐（行外边距 5px + 轨道内 13px）。 */
function RailLine(): React.JSX.Element {
	return <span className="pointer-events-none absolute top-0 bottom-0 left-[18px] w-[2px] bg-owl-accent/45" />;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function HistoryView({ api, cwd, repos, initialRepo, modeSwitch, statusVersion, onGitRefresh, onToChat }: HistoryViewProps): React.JSX.Element {
	const t = useT();
	const roots = repos.map((item) => item.root);
	const reposKey = roots.join("\n");
	const [repo, setRepo] = useState(() => (initialRepo !== undefined && roots.includes(initialRepo) ? initialRepo : (roots[0] ?? "")));
	const repoArg = repo === "" ? undefined : repo;
	const [scope, setScope] = useState<"current" | "all">("current");
	const [query, setQuery] = useState("");

	const [history, setHistory] = useState<GitHistoryResult | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [actionError, setActionError] = useState<string | undefined>(undefined);
	const [pushing, setPushing] = useState(false);
	const [toast, setToast] = useState<string | undefined>(undefined);

	const [details, setDetails] = useState<Record<string, GitCommitDetail>>({});
	const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
	const [ci, setCi] = useState<Record<string, GitCiState>>({});
	const [ciTick, setCiTick] = useState(0);

	const [expanded, setExpanded] = useState<string | undefined>(undefined);
	const [against, setAgainst] = useState<Against>("parent");
	const [allFiles, setAllFiles] = useState(false);
	const [selected, setSelected] = useState<{ hash: string; short: string; file: GitCommitFile; against: Against } | undefined>(undefined);
	const [diff, setDiff] = useState<string | undefined>(undefined);
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | undefined>(undefined);
	const [expandedDiff, setExpandedDiff] = useState(false);

	const [hover, setHover] = useState<{ hash: string; rect: DOMRect } | undefined>(undefined);
	const [menu, setMenu] = useState<{ entry: GitHistoryEntry; x: number; y: number } | undefined>(undefined);

	const historyRef = useRef(history);
	historyRef.current = history;
	const detailsRef = useRef(details);
	detailsRef.current = details;
	const ciRef = useRef(ci);
	ciRef.current = ci;
	const loadSeq = useRef(0);
	const diffSeq = useRef(0);
	// 仓库 / 分支范围切换后递增：旧仓库的详情、CI 晚到时丢弃
	const cacheEpoch = useRef(0);
	const detailPending = useRef(new Set<string>());
	const ciAsked = useRef(new Map<string, number>());
	const ciOff = useRef(false);
	const hoverTimer = useRef<number | undefined>(undefined);
	const toastTimer = useRef<number | undefined>(undefined);

	useEffect(() => {
		if (roots.length === 0) {
			if (repo !== "") setRepo("");
		} else if (!roots.includes(repo)) {
			setRepo(roots[0]!);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [reposKey]);

	const load = useCallback(
		async (mode: "reset" | "refresh" | "more"): Promise<void> => {
			const seq = ++loadSeq.current;
			const current = historyRef.current;
			const loaded = current?.entries.length ?? 0;
			const skip = mode === "more" ? loaded : 0;
			const count = mode === "refresh" ? Math.min(Math.max(loaded, PAGE), MAX_PAGE) : PAGE;
			if (mode === "reset") setLoading(true);
			if (mode === "more") setLoadingMore(true);
			try {
				const result = await api.gitHistory(cwd, { ...(repoArg !== undefined ? { repo: repoArg } : {}), all: scope === "all", skip, count });
				if (seq !== loadSeq.current) return;
				if (mode === "more" && current !== undefined) {
					const seen = new Set(current.entries.map((entry) => entry.hash));
					setHistory({ ...result, entries: [...current.entries, ...result.entries.filter((entry) => !seen.has(entry.hash))] });
				} else {
					setHistory(result);
				}
				setLoadError(undefined);
			} catch (err) {
				if (seq === loadSeq.current) setLoadError(errorText(err));
			} finally {
				if (seq === loadSeq.current) {
					setLoading(false);
					setLoadingMore(false);
				}
			}
		},
		[api, cwd, repoArg, scope],
	);
	const loadRef = useRef(load);
	loadRef.current = load;

	useEffect(() => {
		cacheEpoch.current += 1;
		detailPending.current.clear();
		ciAsked.current.clear();
		ciOff.current = false;
		setHistory(undefined);
		setDetails({});
		setDetailErrors({});
		setCi({});
		setExpanded(undefined);
		setSelected(undefined);
		setDiff(undefined);
		setActionError(undefined);
		void load("reset");
	}, [load]);

	const firstStatus = useRef(true);
	useEffect(() => {
		if (firstStatus.current) {
			firstStatus.current = false;
			return;
		}
		const timer = window.setTimeout(() => void loadRef.current("refresh"), REFRESH_DEBOUNCE_MS);
		return () => window.clearTimeout(timer);
	}, [statusVersion]);

	useEffect(
		() => () => {
			window.clearTimeout(hoverTimer.current);
			window.clearTimeout(toastTimer.current);
		},
		[],
	);

	// CI：只查已推送的提交；终态不再查，运行中的每 30 秒最多查一次
	useEffect(() => {
		if (history?.githubUrl === undefined || ciOff.current) return;
		const now = Date.now();
		const hashes = history.entries
			.filter((entry) => entry.unpushed !== true)
			.map((entry) => entry.hash)
			.filter((hash) => {
				const state = ciRef.current[hash];
				return state !== "success" && state !== "failure" && now - (ciAsked.current.get(hash) ?? 0) >= CI_RETRY_MS;
			})
			.slice(0, 100);
		if (hashes.length === 0) return;
		for (const hash of hashes) ciAsked.current.set(hash, now);
		const epoch = cacheEpoch.current;
		void api
			.gitChecks(cwd, hashes, repoArg)
			.then((result) => {
				if (epoch === cacheEpoch.current) setCi((previous) => ({ ...previous, ...result }));
			})
			.catch(() => {
				// gh 缺失、未登录或无权限：本仓库内不再尝试
				ciOff.current = true;
			});
	}, [history, ciTick, api, cwd, repoArg]);

	useEffect(() => {
		if (!Object.values(ci).includes("pending")) return;
		const timer = window.setTimeout(() => setCiTick((tick) => tick + 1), CI_RETRY_MS + 500);
		return () => window.clearTimeout(timer);
	}, [ci]);

	const ensureDetail = useCallback(
		(hash: string): void => {
			if (detailsRef.current[hash] !== undefined || detailPending.current.has(hash)) return;
			detailPending.current.add(hash);
			const epoch = cacheEpoch.current;
			void api
				.gitShow(cwd, hash, repoArg)
				.then((detail) => {
					if (epoch !== cacheEpoch.current) return;
					setDetails((previous) => ({ ...previous, [hash]: detail }));
				})
				.catch((err: unknown) => {
					if (epoch !== cacheEpoch.current) return;
					setDetailErrors((previous) => ({ ...previous, [hash]: errorText(err) }));
				})
				.finally(() => detailPending.current.delete(hash));
		},
		[api, cwd, repoArg],
	);

	const flash = (text: string): void => {
		setToast(text);
		window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(undefined), 1400);
	};

	const copy = (text: string): void => {
		void navigator.clipboard
			.writeText(text)
			.then(() => flash(t("history.copied")))
			.catch((err: unknown) => setActionError(errorText(err)));
	};

	const openUrl = (url: string): void => {
		void api.openExternal("url", url).catch((err: unknown) => setActionError(errorText(err)));
	};

	const openFileDiff = (hash: string, short: string, file: GitCommitFile, mode: Against): void => {
		const seq = ++diffSeq.current;
		setSelected({ hash, short, file, against: mode });
		setDiffLoading(true);
		setDiffError(undefined);
		const paths = file.origPath !== undefined ? [file.origPath, file.path] : [file.path];
		void api
			.gitShowDiff(cwd, hash, paths, mode, repoArg)
			.then((text) => {
				if (diffSeq.current === seq) setDiff(text);
			})
			.catch((err: unknown) => {
				if (diffSeq.current === seq) setDiffError(errorText(err));
			})
			.finally(() => {
				if (diffSeq.current === seq) setDiffLoading(false);
			});
	};

	const closeDiff = (): void => {
		diffSeq.current += 1;
		setSelected(undefined);
		setDiff(undefined);
		setDiffLoading(false);
	};

	const toggleExpand = (hash: string): void => {
		hideHover();
		if (expanded === hash) {
			setExpanded(undefined);
			return;
		}
		setExpanded(hash);
		setAgainst("parent");
		setAllFiles(false);
		ensureDetail(hash);
	};

	const setCompare = (hash: string, mode: Against): void => {
		setExpanded(hash);
		setAgainst(mode);
		ensureDetail(hash);
		if (selected !== undefined && selected.hash === hash && selected.against !== mode) {
			openFileDiff(hash, selected.short, selected.file, mode);
		}
	};

	const push = async (): Promise<void> => {
		setPushing(true);
		setActionError(undefined);
		try {
			await api.gitPush(cwd, repoArg);
			await load("refresh");
			onGitRefresh();
		} catch (err) {
			setActionError(errorText(err));
		} finally {
			setPushing(false);
		}
	};

	const hideHover = (): void => {
		window.clearTimeout(hoverTimer.current);
		setHover(undefined);
	};

	const startHover = (event: React.MouseEvent<HTMLElement>, hash: string): void => {
		window.clearTimeout(hoverTimer.current);
		const target = event.currentTarget;
		hoverTimer.current = window.setTimeout(() => {
			if (!target.isConnected) return;
			setHover({ hash, rect: target.getBoundingClientRect() });
			ensureDetail(hash);
		}, HOVER_DELAY_MS);
	};

	const githubUrl = history?.githubUrl;
	const repoLabel = githubUrl !== undefined ? githubUrl.replace(/^https:\/\/github\.com\//, "") : repoDisplayName(repoArg ?? ".", cwd);
	const commitUrl = (hash: string): string | undefined => (githubUrl !== undefined ? `${githubUrl}/commit/${hash}` : undefined);

	const explain = (entry: { hash: string; short: string; subject: string }): void => {
		onToChat?.(t("history.explainPrompt", { short: entry.short, hash: entry.hash, subject: entry.subject, repo: repoLabel }));
	};

	const fixCi = (entry: GitHistoryEntry): void => {
		onToChat?.(
			t("history.fixCiPrompt", {
				short: entry.short,
				hash: entry.hash,
				subject: entry.subject,
				repo: repoLabel,
				url: `${commitUrl(entry.hash) ?? ""}/checks`,
			}),
		);
	};

	const entries = history?.entries ?? [];
	const needle = query.trim().toLowerCase();
	const visible = useMemo(
		() =>
			needle === ""
				? entries
				: entries.filter(
						(entry) =>
							entry.subject.toLowerCase().includes(needle) ||
							entry.author.toLowerCase().includes(needle) ||
							entry.email.toLowerCase().includes(needle) ||
							entry.hash.startsWith(needle),
					),
		[entries, needle],
	);
	const hasMore = history?.hasMore === true;

	const menuItems = (entry: GitHistoryEntry): Array<{ label: string; icon: React.ReactNode; hint?: string; danger?: boolean; action: () => void } | "sep"> => {
		const url = commitUrl(entry.hash);
		const items: Array<{ label: string; icon: React.ReactNode; hint?: string; danger?: boolean; action: () => void } | "sep"> = [
			{ label: t("history.copyHash"), icon: <IconCopy size={12} />, hint: entry.short, action: () => copy(entry.hash) },
			{
				label: t("history.copyMessage"),
				icon: <span className="w-3 text-center">≡</span>,
				action: () => {
					const detail = detailsRef.current[entry.hash];
					copy(detail !== undefined && detail.body !== "" ? `${detail.subject}\n\n${detail.body}` : entry.subject);
				},
			},
		];
		if (url !== undefined) {
			items.push("sep", { label: t("history.openGithub"), icon: <IconExternal size={12} />, hint: "GitHub", action: () => openUrl(url) });
			if (ci[entry.hash] === "failure") {
				items.push({ label: t("history.viewFailedCi"), icon: <span className="w-3 text-center">✕</span>, hint: "GitHub", danger: true, action: () => openUrl(`${url}/checks`) });
			}
		}
		if (onToChat !== undefined) {
			items.push("sep", { label: t("history.explainMenu"), icon: <span className="w-3 text-center text-owl-accent">✦</span>, action: () => explain(entry) });
			if (ci[entry.hash] === "failure") {
				items.push({ label: t("history.fixCi"), icon: <span className="w-3 text-center text-owl-accent">✦</span>, action: () => fixCi(entry) });
			}
		}
		items.push("sep", { label: t("history.compareWorktree"), icon: <span className="w-3 text-center">⇄</span>, action: () => setCompare(entry.hash, "worktree") });
		return items;
	};

	const buttonBase = "inline-flex h-[26px] items-center gap-1 rounded-md border px-2.5 text-xs";
	const button = `${buttonBase} border-owl-border bg-owl-bg text-owl-text hover:bg-owl-hover`;

	const detailBlock = (entry: GitHistoryEntry, continues: boolean): React.JSX.Element => {
		const detail = details[entry.hash];
		const failed = detailErrors[entry.hash];
		const url = commitUrl(entry.hash);
		const files = detail?.files ?? [];
		const shownFiles = allFiles ? files : files.slice(0, FILES_PREVIEW);
		const ciLine = ciText(ci[entry.hash], t);
		return (
			<div className="relative">
				{continues && <RailLine />}
				<div className="mt-0.5 mr-[5px] mb-1.5 ml-[33px] rounded-lg border border-owl-border bg-owl-panel px-3 py-2.5">
					{detail === undefined && failed === undefined && (
						<div className="flex items-center gap-2 text-xs text-owl-faint">
							<IconLoader size={13} className="animate-spin" /> {t("history.readingDetail")}
						</div>
					)}
					{failed !== undefined && <div className="text-xs text-red-300">{failed}</div>}
					{detail !== undefined && (
						<>
							{detail.body !== "" && <div className="max-h-40 overflow-auto text-[12.5px] leading-relaxed whitespace-pre-wrap text-owl-text/85">{detail.body}</div>}
							<div className="my-2 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[11.5px] text-owl-muted">
								<span>{t("history.author")}</span>
								<span className="truncate text-owl-text" title={detail.email}>
									{detail.author} · {fullTime(detail.time)}
								</span>
								<span>{t("history.commit")}</span>
								<span className="truncate font-mono text-[11px] text-sky-300">{detail.hash}</span>
								{detail.parents.length > 0 && (
									<>
										<span>{t("history.parents")}</span>
										<span className="font-mono text-[11px] text-sky-300">
											{detail.parents.map((parent) => parent.slice(0, 7)).join("  ")}
											{detail.parents.length > 1 && <span className="ml-2 font-sans text-owl-faint">{t("history.merge")}</span>}
										</span>
									</>
								)}
								{ciLine !== undefined && (
									<>
										<span>{t("history.ci")}</span>
										<span className={ciColor(ci[entry.hash])}>{ciLine}</span>
									</>
								)}
							</div>
							<div className="flex flex-wrap gap-1.5 border-b border-owl-border pb-2">
								<button type="button" className={button} onClick={() => copy(detail.hash)}>
									<IconCopy size={11} /> {t("history.copyHash")}
								</button>
								{url !== undefined && (
									<button type="button" className={button} onClick={() => openUrl(url)}>
										{t("history.openGithub")} <IconExternal size={11} />
									</button>
								)}
								<button
									type="button"
									className={against === "worktree" ? `${buttonBase} border-owl-accent/60 bg-owl-accent/10 text-owl-accent hover:bg-owl-accent/15` : button}
									aria-pressed={against === "worktree"}
									onClick={() => setCompare(entry.hash, against === "worktree" ? "parent" : "worktree")}
								>
									⇄ {t("history.compareWorktree")}
								</button>
								{onToChat !== undefined && (
									<button type="button" className={`${buttonBase} border-owl-accent bg-owl-accent text-white hover:bg-owl-accent-hover`} onClick={() => explain(detail)}>
										✦ {t("history.explain")}
									</button>
								)}
							</div>
							<div className="flex justify-between pt-2 pb-1 text-[11.5px] text-owl-muted">
								<span>{t("history.filesN", { n: files.length })}</span>
								<span>
									<span className="text-emerald-300">+{detail.additions}</span> <span className="text-red-300">−{detail.deletions}</span>
								</span>
							</div>
							{files.length === 0 && <div className="py-1 text-xs text-owl-faint">{t("history.noFiles")}</div>}
							{shownFiles.map((file) => {
								const isSelected = selected?.hash === entry.hash && selected.file.path === file.path;
								const slash = file.path.lastIndexOf("/");
								const name = file.path.slice(slash + 1);
								const dir = slash >= 0 ? file.path.slice(0, slash) : "";
								return (
									<div
										key={file.path}
										role="button"
										tabIndex={0}
										className={`-mx-1.5 flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-xs hover:bg-owl-hover ${isSelected ? "bg-owl-hover shadow-[inset_2px_0_0_var(--color-owl-accent)]" : ""}`}
										title={file.origPath !== undefined ? `${file.origPath} → ${file.path}` : file.path}
										onClick={() => openFileDiff(entry.hash, entry.short, file, against)}
										onKeyDown={(event) => {
											if (event.key === "Enter") openFileDiff(entry.hash, entry.short, file, against);
										}}
									>
										<span className={`w-3 shrink-0 text-[10.5px] font-bold ${fileStatusClass(file.status)}`}>{file.status}</span>
										<span className="min-w-0 flex-1 truncate">
											<span className="text-owl-text">{name}</span>
											{dir !== "" && <span className="ml-1.5 text-[11px] text-owl-faint">{dir}</span>}
										</span>
										{file.additions !== undefined && file.deletions !== undefined && (
											<span className="shrink-0 font-mono text-[10.5px] whitespace-nowrap">
												<span className="text-emerald-300">+{file.additions}</span> <span className="text-red-300">−{file.deletions}</span>
												<ChangeBar additions={file.additions} deletions={file.deletions} />
											</span>
										)}
									</div>
								);
							})}
							{files.length > FILES_PREVIEW && (
								<button type="button" className="mt-1 w-full text-center text-[11.5px] text-owl-muted hover:text-owl-text" onClick={() => setAllFiles(!allFiles)}>
									{allFiles ? `${t("history.lessFiles")} ▴` : `${t("history.moreFiles", { n: files.length - FILES_PREVIEW })} ▾`}
								</button>
							)}
						</>
					)}
				</div>
			</div>
		);
	};

	const row = (entry: GitHistoryEntry, index: number): React.JSX.Element => {
		const { type, text } = splitType(entry.subject);
		const isHead = entry.refs.some((ref) => ref.kind === "head");
		const isMerge = entry.parents.length > 1;
		const isFirst = index === 0;
		const isLast = index === visible.length - 1 && !hasMore;
		const isOpen = expanded === entry.hash;
		const dot = isMerge
			? "left-[9px] top-[10px] h-[10px] w-[10px] rotate-45 rounded-[2px] border-2 border-owl-accent bg-owl-bg"
			: isHead
				? "left-2 top-[9px] h-3 w-3 rounded-full border-2 border-owl-accent bg-owl-accent shadow-[0_0_0_3px_rgba(80,169,146,0.18)]"
				: entry.unpushed === true
					? "left-2 top-[9px] h-3 w-3 rounded-full border-2 border-dashed border-amber-300 bg-owl-bg"
					: "left-2 top-[9px] h-3 w-3 rounded-full border-2 border-owl-accent bg-owl-bg";
		const shownRefs = entry.refs.slice(0, 3);
		return (
			<div
				role="button"
				tabIndex={0}
				aria-expanded={isOpen}
				className={`relative mx-[5px] my-px flex cursor-pointer rounded-[7px] outline-none hover:bg-owl-hover focus-visible:bg-owl-hover ${isOpen ? "bg-owl-hover shadow-[inset_2px_0_0_var(--color-owl-accent)]" : ""}`}
				onClick={() => toggleExpand(entry.hash)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						toggleExpand(entry.hash);
					}
				}}
				onMouseEnter={(event) => {
					if (!isOpen) startHover(event, entry.hash);
				}}
				onMouseLeave={hideHover}
				onContextMenu={(event) => {
					event.preventDefault();
					hideHover();
					ensureDetail(entry.hash);
					setMenu({ entry, x: event.clientX, y: event.clientY });
				}}
			>
				<div className="relative w-7 shrink-0">
					<span className="pointer-events-none absolute left-[13px] w-[2px] bg-owl-accent/45" style={{ top: isFirst ? 14 : 0, bottom: isLast ? "calc(100% - 14px)" : 0 }} />
					<span className={`absolute ${dot}`} title={entry.unpushed === true ? t("history.unpushed", { n: 1, upstream: history?.upstream ?? "" }) : isMerge ? t("history.merge") : undefined} />
				</div>
				<div className="min-w-0 flex-1 py-1.5 pr-2 pl-0.5">
					<div className="flex items-center gap-1.5 text-[13px] leading-normal">
						<span className="min-w-0 flex-1 truncate text-owl-text">{text}</span>
						{shownRefs.map((ref) => (
							<span key={`${ref.kind}:${ref.name}`} className={`shrink-0 rounded-full border px-1.5 text-[10.5px] leading-[17px] whitespace-nowrap ${refClass(ref)}`}>
								{refLabel(ref)}
							</span>
						))}
						{entry.refs.length > shownRefs.length && <span className="shrink-0 text-[10.5px] text-owl-faint">+{entry.refs.length - shownRefs.length}</span>}
					</div>
					<div className="mt-px flex items-center gap-2 text-[11.5px] text-owl-muted">
						<span className="font-mono text-[11px] text-sky-300">{entry.short}</span>
						{type !== "" && <span className="truncate text-[11px] text-owl-faint">{type}</span>}
						<span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-owl-accent/25 text-[9px] text-owl-accent" title={`${entry.author} <${entry.email}>`}>
							{entry.author.slice(0, 1).toUpperCase()}
						</span>
						{/* 作者名直接露出来：那个圆点对所有作者都是同一个强调色，不带区分信息；
						    完整名字原先只有悬停卡和展开详情里才有，列表里认不出谁是谁。 */}
						<span className="min-w-0 truncate" title={entry.author}>
							{entry.author}
						</span>
						<span className="shrink-0" title={fullTime(entry.time)}>
							{relativeTime(entry.time, t)}
						</span>
						<CiMark state={ci[entry.hash]} t={t} />
					</div>
				</div>
			</div>
		);
	};

	const list: React.JSX.Element[] = [];
	let lastDay = "";
	visible.forEach((entry, index) => {
		const key = dayKey(entry.time);
		if (key !== lastDay) {
			list.push(
				<div key={`day-${key}-${index}`} className="relative pt-2.5 pr-3.5 pb-1 pl-[38px] text-[11px] tracking-[0.02em] text-owl-muted">
					{index > 0 && <RailLine />}
					{dayLabel(entry.time, t)}
				</div>,
			);
			lastDay = key;
		}
		list.push(<div key={entry.hash}>{row(entry, index)}</div>);
		if (expanded === entry.hash) list.push(<div key={`${entry.hash}-detail`}>{detailBlock(entry, index < visible.length - 1 || hasMore)}</div>);
	});

	const hoverEntry = hover !== undefined && menu === undefined && expanded !== hover.hash ? entries.find((entry) => entry.hash === hover.hash) : undefined;
	const hoverDetail = hoverEntry !== undefined ? details[hoverEntry.hash] : undefined;
	const hoverStyle = ((): React.CSSProperties => {
		if (hover === undefined) return {};
		const left = Math.max(8, Math.min(hover.rect.left + 24, window.innerWidth - 316));
		return hover.rect.bottom > window.innerHeight * 0.6 ? { left, bottom: window.innerHeight - hover.rect.top + 4 } : { left, top: hover.rect.bottom + 4 };
	})();

	return (
		<div className="relative flex h-full flex-col overflow-hidden">
			<div className="flex min-h-11 items-center gap-2 border-b border-owl-border/60 py-1.5 pr-2.5 pl-3">
				{modeSwitch}
				<span className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-owl-muted">
					{repos.length > 1 && (
						<select
							aria-label={t("history.repo")}
							value={repo}
							onChange={(event) => setRepo(event.target.value)}
							className="h-7 min-w-0 flex-1 rounded-md border border-owl-border/60 bg-owl-panel px-1.5 text-xs text-owl-text outline-none focus:border-owl-accent"
						>
							{repos.map((item) => (
								<option key={item.root} value={item.root}>
									{repoDisplayName(item.root, cwd)}
									{item.branch !== undefined ? ` ─ ${item.branch}` : ""}
								</option>
							))}
						</select>
					)}
					{history?.branch !== undefined && (
						<>
							{repos.length <= 1 && (
								<>
									<IconGitBranch size={12} className="shrink-0" />
									<span className="truncate">{history.branch}</span>
								</>
							)}
							{history.ahead > 0 && (
								<span className="shrink-0 text-[11px] text-amber-300" title={t("history.ahead", { n: history.ahead })}>
									↑{history.ahead}
								</span>
							)}
							{history.behind > 0 && (
								<span className="shrink-0 text-[11px] text-sky-300" title={t("history.behind", { n: history.behind })}>
									↓{history.behind}
								</span>
							)}
							{history.upstream !== undefined && repos.length <= 1 && <span className="truncate opacity-60">⟂ {history.upstream}</span>}
						</>
					)}
				</span>
				<button type="button" title={t("common.refresh")} className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text" onClick={() => void load("refresh")}>
					<IconRefresh size={14} className={loading ? "animate-spin" : ""} />
				</button>
			</div>

			<div className="flex gap-1.5 border-b border-owl-border/50 px-2.5 py-2">
				<label className="flex h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded-[7px] border border-owl-border bg-owl-panel px-2 text-owl-muted focus-within:border-owl-accent">
					<IconSearch size={13} className="shrink-0" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("history.searchPlaceholder")}
						className="min-w-0 flex-1 bg-transparent text-[12.5px] text-owl-text outline-none placeholder:text-owl-faint"
					/>
					{query !== "" && (
						<button type="button" className="shrink-0 hover:text-owl-text" onClick={() => setQuery("")}>
							<IconX size={11} />
						</button>
					)}
				</label>
				<select
					aria-label={t("history.scopeLabel")}
					value={scope}
					onChange={(event) => setScope(event.target.value === "all" ? "all" : "current")}
					className="h-[30px] shrink-0 rounded-[7px] border border-owl-border bg-owl-panel px-1.5 text-xs text-owl-text outline-none focus:border-owl-accent"
				>
					<option value="current">{t("history.scopeCurrent")}</option>
					<option value="all">{t("history.scopeAll")}</option>
				</select>
			</div>

			{actionError !== undefined && (
				<div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs break-words text-red-300">
					{actionError}
					<button type="button" className="ml-2 underline" onClick={() => setActionError(undefined)}>
						{t("window.close")}
					</button>
				</div>
			)}

			{history !== undefined && history.upstream !== undefined && history.ahead > 0 && (
				<div className="mx-2.5 mt-2 mb-0.5 flex items-center gap-2 rounded-lg border border-amber-300/30 bg-amber-300/10 px-2.5 py-1.5 text-xs text-amber-300">
					<span className="shrink-0">↑</span>
					<span className="min-w-0 flex-1 truncate">{t("history.unpushed", { n: history.ahead, upstream: history.upstream })}</span>
					<button type="button" disabled={pushing} className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-md border border-amber-300/35 px-2.5 hover:bg-amber-300/10 disabled:opacity-50" onClick={() => void push()}>
						{pushing && <IconLoader size={11} className="animate-spin" />}
						{pushing ? t("history.pushing") : t("history.push")}
					</button>
				</div>
			)}
			{history !== undefined && history.canPublish && history.branch !== undefined && (
				<div className="mx-2.5 mt-2 mb-0.5 flex items-center gap-2 rounded-lg border border-owl-accent/30 bg-owl-accent/10 px-2.5 py-1.5 text-xs text-owl-accent">
					<span className="min-w-0 flex-1 truncate">{t("history.unpublished", { branch: history.branch })}</span>
					<button type="button" disabled={pushing} className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-md bg-owl-accent px-2.5 text-white hover:bg-owl-accent-hover disabled:opacity-50" onClick={() => void push()}>
						{pushing && <IconLoader size={11} className="animate-spin" />}
						{pushing ? t("history.pushing") : t("history.publish")}
					</button>
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto pt-1 pb-2" onScroll={hideHover}>
				{loading && history === undefined && (
					<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
						<IconLoader size={13} className="animate-spin" /> {t("history.loading")}
					</div>
				)}
				{loadError !== undefined && <div className="px-3 py-2 text-xs break-words text-red-300">{loadError}</div>}
				{history !== undefined && entries.length === 0 && <div className="px-3 py-6 text-center text-xs text-owl-faint">{t("history.empty")}</div>}
				{history !== undefined && entries.length > 0 && visible.length === 0 && (
					<div className="px-3 py-6 text-center text-xs text-owl-faint">
						{t("history.noMatch")}
						{/* 搜索只作用于已加载的提交：还有更早的没加载时，得说清楚下一步怎么走。 */}
						{hasMore && <p className="mt-1.5 text-[11px]">{t("history.noMatchMore")}</p>}
					</div>
				)}
				{list}
				{hasMore && (
					<button type="button" disabled={loadingMore} className="mx-auto mt-2.5 block text-xs text-owl-muted hover:text-owl-text disabled:opacity-60" onClick={() => void load("more")}>
						{loadingMore ? t("history.loadingMore") : t("history.loadMore", { n: PAGE })}
					</button>
				)}
			</div>

			{selected !== undefined && (
				<div className={`${expandedDiff ? "h-[78%]" : "h-[36%]"} flex shrink-0 flex-col border-t border-owl-border/60`}>
					<div className="flex items-center gap-1.5 border-b border-owl-border/40 py-1 pr-2 pl-3 font-mono text-[11.5px] text-owl-muted">
						<span className="min-w-0 flex-1 truncate" title={selected.file.path}>
							{selected.file.path}
						</span>
						<span className="shrink-0 text-sky-300">{selected.short}</span>
						{selected.against === "worktree" && <span className="shrink-0 font-sans text-[11px] text-owl-accent">⇄ {t("history.worktree")}</span>}
						<button type="button" title={expandedDiff ? t("common.collapse") : t("common.expand")} className="rounded p-1 text-owl-muted hover:text-owl-text" onClick={() => setExpandedDiff(!expandedDiff)}>
							{expandedDiff ? "▾" : "▴"}
						</button>
						<button type="button" title={t("window.close")} className="rounded p-1 text-owl-muted hover:text-owl-text" onClick={closeDiff}>
							<IconX size={12} />
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-auto">
						{diffLoading && (
							<div className="flex items-center gap-2 px-3 py-2 font-sans text-xs text-owl-faint">
								<IconLoader size={13} className="animate-spin" /> {t("changes.readingDiff")}
							</div>
						)}
						{diffError !== undefined && <div className="px-3 py-2 text-xs text-red-300">{diffError}</div>}
						{!diffLoading && diffError === undefined && diff !== undefined && (diff.trim() === "" ? <div className="px-3 py-2 text-xs text-owl-faint">{t("changes.noDiff")}</div> : <DiffView text={diff} />)}
					</div>
				</div>
			)}

			{hoverEntry !== undefined && (
				<div className="pointer-events-none fixed z-50 w-[300px] rounded-lg border border-owl-border bg-owl-panel p-3 shadow-2xl" style={hoverStyle}>
					<div className="text-[12.5px] leading-snug font-medium break-words text-owl-text">{hoverEntry.subject}</div>
					{hoverDetail !== undefined && hoverDetail.body !== "" && (
						<div className="mt-1.5 line-clamp-6 text-[11.5px] leading-relaxed whitespace-pre-wrap text-owl-muted">{hoverDetail.body}</div>
					)}
					<div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-owl-muted">
						<span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-owl-accent/25 text-[9px] text-owl-accent">
							{hoverEntry.author.slice(0, 1).toUpperCase()}
						</span>
						<span className="truncate">
							{hoverEntry.author} · {fullTime(hoverEntry.time)}
						</span>
					</div>
					<div className="mt-1 flex items-center gap-2 text-[11px]">
						<span className="font-mono text-sky-300">{hoverEntry.short}</span>
						{hoverDetail !== undefined && (
							<span className="text-owl-muted">
								{t("history.filesN", { n: hoverDetail.files.length })} · <span className="text-emerald-300">+{hoverDetail.additions}</span>{" "}
								<span className="text-red-300">−{hoverDetail.deletions}</span>
							</span>
						)}
						{hoverDetail === undefined && detailErrors[hoverEntry.hash] === undefined && <IconLoader size={11} className="animate-spin text-owl-faint" />}
					</div>
					{ciText(ci[hoverEntry.hash], t) !== undefined && <div className={`mt-1 text-[11px] ${ciColor(ci[hoverEntry.hash])}`}>{ciText(ci[hoverEntry.hash], t)}</div>}
					{hoverEntry.refs.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{hoverEntry.refs.map((ref) => (
								<span key={`${ref.kind}:${ref.name}`} className={`rounded-full border px-1.5 text-[10.5px] leading-[17px] ${refClass(ref)}`}>
									{refLabel(ref)}
								</span>
							))}
						</div>
					)}
				</div>
			)}

			{menu !== undefined && (
				<>
					<div
						className="fixed inset-0 z-40"
						onClick={() => setMenu(undefined)}
						onContextMenu={(event) => {
							event.preventDefault();
							setMenu(undefined);
						}}
					/>
					<div
						role="menu"
						className="fixed z-50 w-60 overflow-hidden rounded-lg border border-owl-border bg-owl-panel p-1 shadow-xl"
						style={{ left: Math.min(menu.x, window.innerWidth - 250), top: Math.min(menu.y, window.innerHeight - 300) }}
					>
						{menuItems(menu.entry).map((item, index) =>
							item === "sep" ? (
								<div key={`sep-${index}`} className="mx-1.5 my-1 h-px bg-owl-border" />
							) : (
								<button
									key={item.label}
									type="button"
									role="menuitem"
									className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-owl-accent/15 ${item.danger === true ? "text-red-300" : "text-owl-text"}`}
									onClick={() => {
										setMenu(undefined);
										item.action();
									}}
								>
									<span className="flex w-3 shrink-0 justify-center text-owl-muted">{item.icon}</span>
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.hint !== undefined && <span className="shrink-0 font-mono text-[10.5px] text-owl-faint">{item.hint}</span>}
								</button>
							),
						)}
					</div>
				</>
			)}

			{toast !== undefined && (
				<div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-md border border-owl-border bg-owl-panel px-2.5 py-1 text-xs text-owl-text shadow-lg">{toast}</div>
			)}
		</div>
	);
}
