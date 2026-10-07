import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { SettingsInitialTab } from "../../components/SettingsPage.tsx";
import type { ApprovalMode, CommandsListResult, FsSearchHit, ProviderModelsMessage, SlashCommandEntry } from "../../bridge/protocol.ts";
import { ChatStream, type ChatActivity } from "../../components/ChatStream.tsx";
import { Composer, type ComposerImage } from "../../components/Composer.tsx";
import { ContextView } from "../../components/ContextView.tsx";
import type { ConversationView } from "../../components/ConversationHeader.tsx";
import { GenuiSessionProvider } from "../../components/Genui.tsx";
import { useSessionOwlPose } from "../../components/OwlMascot.tsx";
import { RetryPin } from "../../components/RetryPin.tsx";
import { TodoPin } from "../../components/TodoPin.tsx";
import { TrajectoryView } from "../trajectory/TrajectoryView.tsx";
import { IconFolder } from "../../sidebar/icons.tsx";
import { getProjectDisplayName } from "../../project-sidebar-model.ts";
import { getUiLanguage, useT, type TextKey } from "../../i18n/index.ts";
import {
	appendChatLine,
	listMyselfDays,
	MYSELF_DIR_LS_KEY,
	myselfDirCandidates,
	myselfPrimer,
	newDayTemplate,
	parseDay,
	readMyselfDay,
	resolveMyselfDir,
	todayKey,
	toggleTodoInRaw,
	writeMyselfDay,
	type MyselfDay,
} from "./myself-data.ts";
import { MyselfChatController, type MyselfChatState } from "./myself-chat-controller.ts";
import "./myself.css";

type DirState =
	| { status: "probing" }
	| { status: "missing" }
	| { status: "ready"; dir: string };

type Notice = { tone: "ok" | "error"; text: string } | undefined;

const DAY_READ_CAP = 120;

/** 侧栏分组：今天 / 未来（升序）/ 更早（倒序），标签走 i18n。 */
const GROUPS = ["today", "future", "earlier"] as const;
type DayGroup = (typeof GROUPS)[number];
const GROUP_LABEL: Record<DayGroup, TextKey> = {
	today: "myself.groupToday",
	future: "myself.groupFuture",
	earlier: "myself.groupEarlier",
};

const AVATAR_SVG = (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
		<rect x="3.5" y="5" width="17" height="15" rx="2" />
		<path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
		<path d="m8.5 14.5 2.2 2.2 4.6-4.6" />
	</svg>
);

function hhmm(): string {
	const at = new Date();
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

const EMPTY_CHAT: MyselfChatState = { model: "", thinkingLevel: "", approvalMode: "confirm", entries: [], running: false, busy: false, ready: false, connected: false, retryStatus: null };
const noopSubscribe = (): (() => void) => () => {};

/**
 * 「我的助理」面板：头部居中两个 tab——「日程」（左侧按日历排序的天列表 +
 * 当天提炼/待办/对话记录）与「对话」（整套对齐 owl 对话区：会话头 + 对话/上下文/
 * 轨迹视图 + 完整 Composer，独立 Owl Si 会话，轮次落回当天 md 的「对话」段）。
 */
export function MyselfPanel({ active, client, connected, workspaceDir, agentDir, providers, defaultModel, defaultThinkingLevel, defaultApprovalMode, onOpenSettings }: {
	active: boolean;
	client: BridgeClient;
	/** 桥连接状态：对话与目录探测的可用地。 */
	connected: boolean;
	/** 当前项目目录（owl-myself 约定放在项目根下）。 */
	workspaceDir?: string;
	/** owl agent 数据目录（settings.get 带出），兜底数据根。 */
	agentDir?: string;
	/** 模型清单（与主对话同一份，App 从 providers.list 拉取）。 */
	providers: ProviderModelsMessage[];
	/** 主对话当前默认值：对话线程新开时从这里起步（偏好之后按线程自记）。 */
	defaultModel: string;
	defaultThinkingLevel: string;
	defaultApprovalMode: ApprovalMode;
	/** 主对话的设置入口（/settings 命令用）。 */
	onOpenSettings?: (tab: SettingsInitialTab) => void;
}): React.JSX.Element {
	const t = useT();
	const lang = getUiLanguage();
	const [tab, setTab] = useState<"day" | "chat">("day");
	const [dirState, setDirState] = useState<DirState>({ status: "probing" });
	const [days, setDays] = useState<string[]>([]);
	const [selected, setSelected] = useState<string>(todayKey());
	const [loaded, setLoaded] = useState<Map<string, MyselfDay>>(() => new Map());
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState<Notice>();
	const [dirInput, setDirInput] = useState("");
	const [chatView, setChatView] = useState<ConversationView>("chat");
	const [commands, setCommands] = useState<SlashCommandEntry[]>([]);
	const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; replace?: boolean }>();
	const [composerKey, setComposerKey] = useState(0);
	const [todoPinVisible, setTodoPinVisible] = useState(false);
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const startedRef = useRef(false);
	const loadedRef = useRef(loaded);
	loadedRef.current = loaded;

	const dir = dirState.status === "ready" ? dirState.dir : undefined;
	const dirRef = useRef(dir);
	dirRef.current = dir;

	const flash = useCallback((text: string, tone: "ok" | "error"): void => {
		clearTimeout(noticeTimer.current);
		setNotice({ tone, text });
		noticeTimer.current = setTimeout(() => setNotice(undefined), 3200);
	}, []);
	useEffect(() => () => clearTimeout(noticeTimer.current), []);

	// -- Owl Si 对话线程：控制器按数据目录重建，能力全部对齐主对话 ----------
	const langRef = useRef(lang);
	langRef.current = lang;
	const chatController = useMemo(() => {
		if (!dir) return undefined;
		return new MyselfChatController(
			client,
			localStorage,
			dir,
			{ model: defaultModel, thinkingLevel: defaultThinkingLevel, approvalMode: defaultApprovalMode },
			() => myselfPrimer(todayKey(), loadedRef.current.get(todayKey())?.raw ?? "", langRef.current),
			{
				// 一轮结束（agent_settled）：把最后一条回答落进当天 md 的「对话」段。
				onSettled: (entries) => {
					for (let i = entries.length - 1; i >= 0; i--) {
						const entry = entries[i]!;
						if (entry.kind === "user") break;
						if (entry.kind === "assistant") {
							if (!entry.aborted && entry.text.trim()) void logChatLineRef.current("Owl Si", entry.text);
							break;
						}
					}
				},
			},
		);
	}, [client, dir, defaultModel, defaultThinkingLevel, defaultApprovalMode]);
	const chat = useSyncExternalStore(chatController?.subscribe ?? noopSubscribe, chatController?.getSnapshot ?? (() => EMPTY_CHAT));

	useEffect(() => {
		if (!chatController) return;
		chatController.start();
		return () => chatController.dispose();
	}, [chatController]);
	useEffect(() => {
		chatController?.setConnected(connected);
		if (active && connected) void chatController?.attach();
	}, [chatController, connected, active]);

	// 斜杠命令清单：连接后、建/恢复会话时刷新（扩展命令随会话出现）。
	useEffect(() => {
		if (!connected || !active || !dir) return;
		let cancelled = false;
		void client.request<CommandsListResult>({ type: "commands.list", cwd: dir })
			.then((response) => { if (!cancelled && response.ok) setCommands(response.result?.commands ?? []); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [client, dir, chat.sessionId, connected, active]);

	/** 把一轮对话（用户或 Owl Si）落进今天的 md；今天没文件就先建骨架。 */
	const logChatLine = useCallback(async (who: string, text: string): Promise<void> => {
		const target = dirRef.current;
		if (!target || !text.trim()) return;
		const date = todayKey();
		const baseRaw = loadedRef.current.get(date)?.raw ?? newDayTemplate(date, langRef.current);
		const raw = appendChatLine(baseRaw, hhmm(), who, text.trim());
		setLoaded((current) => new Map(current).set(date, parseDay(raw, date)));
		setDays((current) => (current.includes(date) ? current : [date, ...current].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))));
		setSaving(true);
		try {
			await writeMyselfDay(client, target, date, raw);
			flash(t("myself.saved"), "ok");
		} catch (error) {
			flash(t("myself.saveFailed", { message: errorMessage(error) }), "error");
		} finally {
			setSaving(false);
		}
	}, [client, flash, t]);
	const logChatLineRef = useRef(logChatLine);
	logChatLineRef.current = logChatLine;

	/** 目录定下来后：列天 + 全量读入（天文件都是小笔记，一次拿全给侧栏徽标用）。 */
	const loadDays = useCallback(async (target: string): Promise<void> => {
		const dates = await listMyselfDays(client, target);
		const capped = dates.slice(0, DAY_READ_CAP);
		const next = new Map<string, MyselfDay>();
		await Promise.all(capped.map(async (date) => {
			try {
				next.set(date, parseDay(await readMyselfDay(client, target, date), date));
			} catch {
				// 单个文件读不了不影响整体；侧栏仍可点，内容区报错。
			}
		}));
		setDays(capped);
		setLoaded(next);
		setSelected((current) => (capped.includes(current) ? current : capped[0] ?? todayKey()));
	}, [client]);

	const probe = useCallback(async (preferred?: string): Promise<void> => {
		setDirState({ status: "probing" });
		if (preferred?.trim()) localStorage.setItem(MYSELF_DIR_LS_KEY, preferred.trim());
		else localStorage.removeItem(MYSELF_DIR_LS_KEY);
		const resolved = await resolveMyselfDir(client, workspaceDir, agentDir);
		if (!resolved) {
			setDirState({ status: "missing" });
			return;
		}
		setDirState({ status: "ready", dir: resolved });
		try {
			await loadDays(resolved);
		} catch {
			setDirState({ status: "missing" });
		}
	}, [client, workspaceDir, agentDir, loadDays]);

	useEffect(() => {
		if (!active) return;
		if (startedRef.current) return;
		startedRef.current = true;
		void probe();
		// 只在首次激活时探测一次；目录切换走表单。
	}, [active]);

	/** 发送：斜杠内置命令本地消化；普通消息先落用户行，再交控制器（首轮带铺垫）。 */
	const sendChat = async (value: string, images?: ComposerImage[], attachedPaths?: string[]): Promise<void> => {
		if (!chatController) return;
		const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
		const matched = match && commands.find((command) => command.name === match[1]);
		if (match && (matched?.kind === "builtin" || (!matched && ["new", "settings", "model", "thinking", "compact"].includes(match[1])))) {
			if (match[1] === "settings") { onOpenSettings?.("general"); return; }
			if (match[1] === "new") { newThread(); return; }
			await chatController.executeBuiltin(match[1], match[2] ?? "");
			return;
		}
		const sent = await chatController.send(value, images, attachedPaths);
		if (sent) {
			const note = images?.length ? `${value}${value.trim() ? " " : ""}[图片×${images.length}]` : value;
			void logChatLine(lang === "en" ? "Me" : "我", note);
		}
	};

	const newThread = (): void => {
		if (chatController?.newThread()) {
			setComposerKey((key) => key + 1);
			setDraftRequest(undefined);
		}
	};

	const toggleTodo = async (text: string, done: boolean): Promise<void> => {
		if (dirState.status !== "ready" || !day) return;
		const raw = toggleTodoInRaw(day.raw, text, done);
		if (raw === day.raw) return;
		const next = parseDay(raw, day.date);
		setLoaded((current) => new Map(current).set(day.date, next));
		setSaving(true);
		try {
			await writeMyselfDay(client, dirState.dir, day.date, raw);
			flash(t("myself.saved"), "ok");
		} catch (error) {
			setLoaded((current) => new Map(current).set(day.date, day));
			flash(t("myself.saveFailed", { message: errorMessage(error) }), "error");
		} finally {
			setSaving(false);
		}
	};

	const createToday = async (): Promise<void> => {
		if (dirState.status !== "ready") return;
		const date = todayKey();
		setSaving(true);
		try {
			await writeMyselfDay(client, dirState.dir, date, newDayTemplate(date, lang));
			await loadDays(dirState.dir);
			setSelected(date);
		} catch (error) {
			flash(t("myself.saveFailed", { message: errorMessage(error) }), "error");
		} finally {
			setSaving(false);
		}
	};

	const day = loaded.get(selected);
	const today = todayKey();

	const todos = useMemo(() => (day?.todos ?? []).filter((todo) => todo.text !== ""), [day]);
	const doneCount = todos.filter((todo) => todo.done).length;

	const groups = useMemo(() => ({
		today: days.filter((date) => date === today),
		future: days.filter((date) => date > today).reverse(),
		earlier: days.filter((date) => date < today),
	}), [days, today]);

	const fmtDay = (date: string): string => {
		const at = new Date(`${date}T12:00:00`);
		if (lang === "en") return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(at);
		return `${at.getMonth() + 1}月${at.getDate()}日`;
	};
	const fmtWeekday = (date: string): string =>
		new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", { weekday: "short" }).format(new Date(`${date}T12:00:00`));

	const hasToday = days.includes(today);

	const fillDraft = (value: string): void => setDraftRequest({ id: Date.now(), text: value });
	const chatActivity: ChatActivity = !connected ? "disconnected" : chat.running ? "working" : "idle";
	const owlPose = useSessionOwlPose(chatActivity, chat.entries);

	return (
		<div className={`owl-myself${active ? " is-active" : ""}`}>
			<div className="owl-myself-head">
				<span className="owl-myself-avatar" aria-hidden="true">{AVATAR_SVG}</span>
				<h1>{t("rail.myself")}</h1>
				<span className="owl-myself-dir" title={dir ?? undefined}>{dir ?? ""}</span>
				{dirState.status === "ready" && (
					<div className="owl-myself-tabs" role="tablist" aria-label={t("rail.myself")}>
						<button type="button" role="tab" aria-selected={tab === "day"} className={tab === "day" ? "on" : ""} onClick={() => setTab("day")}>{t("myself.tabDay")}</button>
						<button type="button" role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>{t("myself.tabChat")}</button>
					</div>
				)}
				<span className={`owl-myself-sync${saving ? " is-busy" : ""}`} data-status={dirState.status}>
					{notice ? notice.text : dirState.status === "probing" ? t("myself.loading")
						: dirState.status === "missing" ? t("myself.noDir")
						: t("myself.statusDays", { n: days.length })}
					{dirState.status === "ready" && (
						<button type="button" onClick={() => { setDays([]); setLoaded(new Map()); void probe(); }}>{t("myself.resync")}</button>
					)}
				</span>
			</div>

			{dirState.status === "missing" ? (
				<div className="owl-myself-missing">
					<p className="big">{t("myself.noDirTitle")}</p>
					<p>{t("myself.noDirHint")}</p>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void probe(dirInput);
						}}
					>
						<input
							value={dirInput}
							onChange={(event) => setDirInput(event.target.value)}
							placeholder={t("myself.dirPlaceholder")}
							aria-label={t("myself.dirPlaceholder")}
						/>
						<button type="submit" disabled={dirInput.trim() === ""}>{t("myself.dirSave")}</button>
					</form>
					<p className="candidates">{myselfDirCandidates(workspaceDir, agentDir).join("  ·  ")}</p>
				</div>
			) : tab === "chat" && dir ? (
				// ---- 对话 tab：整套对齐 owl 对话区（会话头 + 三视图 + 完整 Composer）----
				<div className="owl-myself-chatpage">
					<header className="owl-chat-header flex shrink-0 select-none items-center">
						<span className="owl-myself-chatmark" aria-hidden="true">{AVATAR_SVG}</span>
						<h1 className="owl-shell-session-title text-sm font-semibold text-owl-text">Owl Si</h1>
						<span className="owl-shell-project" title={dir}><IconFolder size={12} /><span className="owl-shell-project-label">{getProjectDisplayName(dir)}</span></span>
						<div className="owl-view-tabs" role="tablist" aria-label={t("app.viewTabsAria")}>
							<button type="button" role="tab" aria-selected={chatView === "chat"} onClick={() => setChatView("chat")}>{t("app.viewChat")}</button>
							<button type="button" role="tab" aria-selected={chatView === "context"} onClick={() => setChatView("context")}>{t("composer.context")}</button>
							<button type="button" role="tab" aria-selected={chatView === "trajectory"} onClick={() => setChatView("trajectory")}>{t("app.viewTrajectory")}</button>
						</div>
						<div className="owl-shell-header-actions">
							<button type="button" className="owl-chrome-button" disabled={chat.running || chat.busy} onClick={newThread}>{t("myself.chatNew")}</button>
						</div>
					</header>
					<div className="owl-myself-chatstream">
						{chatView === "trajectory" ? (
							<TrajectoryView entries={chat.entries} active={active} />
						) : chatView === "context" ? (
							<ContextView key={`myself-context:${chat.sessionId ?? dir}`} client={client} cwd={dir} sessionId={chat.sessionId} requireSession active={active && connected} />
						) : chat.entries.length ? (
							<GenuiSessionProvider client={client} sessionId={chat.sessionId}>
								<ChatStream entries={chat.entries} activity={chatActivity} client={client} cwd={dir} />
							</GenuiSessionProvider>
						) : (
							<div className="owl-myself-chathint">
								<span className="mark" aria-hidden="true">{AVATAR_SVG}</span>
								<p className="big">{t("myself.chatEmptyTitle")}</p>
								<p>{t("myself.chatEmptyHint")}</p>
								<div className="owl-myself-examples">
									<button type="button" onClick={() => fillDraft(t("myself.exampleLeft"))}>{t("myself.exampleLeft")}</button>
									<button type="button" onClick={() => fillDraft(t("myself.examplePlan"))}>{t("myself.examplePlan")}</button>
									<button type="button" onClick={() => fillDraft(t("myself.exampleReview"))}>{t("myself.exampleReview")}</button>
								</div>
							</div>
						)}
						{(!connected || !chat.ready || chat.error) && (
							<div className="owl-myself-chatnotice" role={chat.error ? "alert" : "status"}>
								{chat.error ? chat.error : !connected ? t("myself.chatOffline") : t("myself.chatRestore")}
							</div>
						)}
						<RetryPin status={chat.retryStatus} onDismiss={() => chatController?.dismissRetry()} />
						<TodoPin key={`myself-todos:${chat.sessionId ?? dir}`} entries={chat.entries} onVisibleChange={setTodoPinVisible} />
					</div>
					<Composer
						key={`${dir}:${composerKey}`}
						client={client}
						connected={connected}
						disabled={!connected || !chat.ready || chat.running || chat.busy}
						running={chat.running}
						hideMascot={todoPinVisible}
						onSend={(value, images, attachedPaths) => { void sendChat(value, images, attachedPaths); }}
						onAbort={() => void chatController?.abort()}
						providers={providers}
						model={chat.model}
						onModel={(value) => { void chatController?.setModel(value); }}
						thinkingLevel={chat.thinkingLevel}
						onThinkingLevel={(value) => { void chatController?.setThinkingLevel(value); }}
						approvalMode={chat.approvalMode}
						onApprovalMode={(mode) => { void chatController?.setApprovalMode(mode); }}
						sessionInfo={chat.stats}
						workspaceDir={dir}
						projects={[dir]}
						onSwitchProject={() => undefined}
						commands={commands}
						searchFiles={(searchCwd, query) => client.request<FsSearchHit[]>({ type: "fs.search", cwd: searchCwd, query }).then((r) => (r.ok ? r.result ?? [] : []))}
						draftRequest={draftRequest}
						owlPose={owlPose}
					/>
				</div>
			) : (
				// ---- 日程 tab：左目录 + 当天内容 ----
				<div className="owl-myself-main">
					<nav className="owl-myself-days" aria-label={t("rail.myself")}>
						<button
							type="button"
							className={`owl-myself-newday${hasToday ? " is-done" : ""}`}
							disabled={hasToday || dirState.status !== "ready" || saving}
							onClick={() => void createToday()}
						>
							{hasToday ? t("myself.todayReady") : t("myself.newDay")}
						</button>
						{GROUPS.map((key) => {
							const list = groups[key];
							if (list.length === 0) return null;
							return (
								<div key={key} className="owl-myself-group">
									<div className="owl-myself-group-head">
										<span>{t(GROUP_LABEL[key])}</span>
										<span>{list.length}</span>
									</div>
									{list.map((date) => {
										const remaining = (loaded.get(date)?.todos ?? []).filter((todo) => todo.text !== "" && !todo.done).length;
										return (
											<button
												key={date}
												type="button"
												className={`owl-myself-day${selected === date ? " is-on" : ""}`}
												onClick={() => setSelected(date)}
											>
												<span className="d">{fmtDay(date)}<i className="w">{fmtWeekday(date)}</i></span>
												{date === today && <span className="today-dot" aria-hidden="true" />}
												{remaining > 0 && <span className="badge">{remaining}</span>}
											</button>
										);
									})}
								</div>
							);
						})}
					</nav>

					<div className="owl-myself-stream">
						{!day ? (
							<div className="owl-myself-empty">
								<p className="big">{t("myself.emptyTitle")}</p>
								<p>{t("myself.emptyHint")}</p>
								{!hasToday && dirState.status === "ready" && (
									<button type="button" className="owl-myself-create" disabled={saving} onClick={() => void createToday()}>{t("myself.newDay")}</button>
								)}
							</div>
						) : (
							<>
								<header className="owl-myself-day-head">
									<h2>{fmtDay(day.date)} <i>· {fmtWeekday(day.date)}</i></h2>
									{day.distilled.length > 0 && <span className="pill">{t("myself.distilledCount", { n: day.distilled.length })}</span>}
									{todos.length > 0 && <span className="progress">{t("myself.progress", { done: doneCount, total: todos.length })}</span>}
								</header>

								{day.distilled.length > 0 && (
									<div className="owl-myself-distilled">
										{day.distilled.map((item, index) => (
											<article key={index} className="card">
												<div className="n">{t("myself.distilledNo", { n: index + 1 })}</div>
												<div className="title">{item.title}</div>
												{item.detail && <div className="detail">{item.detail}</div>}
											</article>
										))}
									</div>
								)}

								{todos.length > 0 && (
									<section className="owl-myself-todos">
										<h3>{t("myself.todos")}</h3>
										<ul>
											{todos.map((todo, index) => (
												<li key={index} className={todo.done ? "is-done" : ""}>
													<button
														type="button"
														role="checkbox"
														aria-checked={todo.done}
														disabled={saving || dirState.status !== "ready"}
														onClick={() => void toggleTodo(todo.text, !todo.done)}
													>
														<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
													</button>
													<span>{todo.text}</span>
												</li>
											))}
										</ul>
									</section>
								)}

								{day.chat.length > 0 && (
									<section className="owl-myself-chat">
										<h3>{t("myself.chat")}</h3>
										{day.chat.map((line, index) => (
											<p key={index}>
												<span className="time">{line.time}</span>
												<span className="who">{line.who}</span>
												<span className="text">{line.text}</span>
											</p>
										))}
									</section>
								)}

								{day.todos.length === 0 && day.distilled.length === 0 && day.chat.length === 0 && day.notes.length > 0 && (
									<section className="owl-myself-notes">
										{day.notes.map((line, index) => <p key={index}>{line}</p>)}
									</section>
								)}
							</>
						)}
					</div>
				</div>
			)}

			<div className="owl-myself-foot">
				<span>{t("myself.footSource")}</span>
				<span className="right" data-tone={notice?.tone}>{notice?.text ?? ""}</span>
			</div>
		</div>
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	if (typeof error === "string" && error.trim()) return error.trim();
	return String(error ?? "unknown");
}
