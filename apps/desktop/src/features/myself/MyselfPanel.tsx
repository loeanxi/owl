import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type {
	ApprovalMode,
	CommandsListResult,
	FsSearchHit,
	PermissionRequest,
	ProviderModelsMessage,
	QuestionAnswerPayload,
	QuestionRequest,
	SlashCommandEntry,
} from "../../bridge/protocol.ts";
import { AgentConversation } from "../../components/AgentConversation.tsx";
import { type ChatActivity, ChatStream } from "../../components/ChatStream.tsx";
import { Composer, type ComposerImage } from "../../components/Composer.tsx";
import { ContextView } from "../../components/ContextView.tsx";
import { ConversationHeader, type ConversationView } from "../../components/ConversationHeader.tsx";
import { GenuiSessionProvider } from "../../components/Genui.tsx";
import { useSessionOwlPose } from "../../components/OwlMascot.tsx";
import { RetryPin } from "../../components/RetryPin.tsx";
import type { SettingsInitialTab } from "../../components/SettingsPage.tsx";
import { TodoPin } from "../../components/TodoPin.tsx";
import { getUiLanguage, type TextKey, useT } from "../../i18n/index.ts";
import { TrajectoryView } from "../trajectory/TrajectoryView.tsx";
import { MyselfChatController, type MyselfChatIntent, type MyselfChatState } from "./myself-chat-controller.ts";
import {
	addTodoInRaw,
	appendChatLine,
	listMyselfDays,
	MYSELF_DIR_LS_KEY,
	type MyselfDay,
	type MyselfTodo,
	type MyselfTodoStatus,
	moveTodoToTomorrow,
	myselfDirCandidates,
	myselfPrimer,
	newDayTemplate,
	nextDayKey,
	parseDay,
	readMyselfDay,
	resolveMyselfDir,
	todayKey,
	updateSummaryInRaw,
	updateTodoMetadataInRaw,
	updateTodoStatusInRaw,
	weekDaysOf,
	writeMyselfDay,
} from "./myself-data.ts";
import "./myself.css";
import { MyselfChatHistory } from "./MyselfChatHistory.tsx";
import { useMyselfPaneResize } from "./myself-pane-resize.ts";

type DirState = { status: "probing" } | { status: "missing" } | { status: "ready"; dir: string };
type Notice = { tone: "ok" | "error"; text: string } | undefined;
type UndoChange = { date: string; text: string; status: MyselfTodoStatus };
type UnsentRecord = {
	date: string;
	text: string;
	intent: MyselfChatIntent;
	images?: ComposerImage[];
	attachedPaths?: string[];
};
const EMPTY_CHAT: MyselfChatState = {
	model: "",
	thinkingLevel: "",
	approvalMode: "confirm",
	entries: [],
	running: false,
	busy: false,
	ready: false,
	connected: false,
	retryStatus: null,
};
const DAY_READ_CAP = 120;
const noopSubscribe = (): (() => void) => () => {};
const noop = (): void => {};
const STATUS_LABELS: Record<MyselfTodoStatus, TextKey> = {
	todo: "myself.statusTodo",
	doing: "myself.statusDoing",
	waiting: "myself.statusWaiting",
	done: "myself.statusDone",
};

function MyselfIcon({
	name,
}: {
	name: "calendar" | "check" | "plus" | "close" | "arrow" | "clock" | "link" | "leaf" | "target" | "message" | "panel";
}): React.JSX.Element {
	const paths = {
		calendar: "M3 5h18v16H3ZM7 3v4M17 3v4M3 10h18",
		check: "m5 12 4 4L19 6",
		plus: "M12 4v16M4 12h16",
		close: "m6 6 12 12M6 18 18 6",
		arrow: "M4 12h16m-6-6 6 6-6 6",
		clock: "M12 7v5l3 2",
		link: "m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
		leaf: "M20 3c0 12-6 17-12 16-5-1-6-7-2-11 4-4 8-3 14-5ZM4 21 16 9",
		target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
		message: "M21 14a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3ZM7 8h10M7 12h7",
		panel: "M3 4h18v16H3ZM15 4v16",
	};
	return (
		<svg
			className="owl-myself-icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{name === "clock" && <circle cx="12" cy="12" r="9" />}
			<path d={paths[name]} />
		</svg>
	);
}

function hhmm(): string {
	return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The daily workspace uses Home's conversation components with its own persistent session. */
export function MyselfPanel({
	active,
	client,
	connected,
	workspaceDir,
	agentDir,
	providers,
	defaultModel,
	defaultThinkingLevel,
	defaultApprovalMode,
	onOpenSettings,
	questions = [],
	permissions = [],
	onQuestionAnswer,
}: {
	active: boolean;
	client: BridgeClient;
	connected: boolean;
	workspaceDir?: string;
	agentDir?: string;
	providers: ProviderModelsMessage[];
	defaultModel: string;
	defaultThinkingLevel: string;
	defaultApprovalMode: ApprovalMode;
	onOpenSettings?: (tab: SettingsInitialTab) => void;
	questions?: readonly QuestionRequest[];
	permissions?: readonly PermissionRequest[];
	onQuestionAnswer?: (requestId: string, answers: QuestionAnswerPayload[], cancelled: boolean) => void;
}): React.JSX.Element {
	const t = useT();
	const lang = getUiLanguage();
	const [tab, setTab] = useState<"day" | "chat">("day");
	const [dirState, setDirState] = useState<DirState>({ status: "probing" });
	const [days, setDays] = useState<string[]>([]);
	const [selected, setSelected] = useState(todayKey);
	const [loaded, setLoaded] = useState<Map<string, MyselfDay>>(() => new Map());
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState<Notice>();
	const [dirInput, setDirInput] = useState("");
	const [chatView, setChatView] = useState<ConversationView>("chat");
	const [intent, setIntent] = useState<MyselfChatIntent>("record");
	const [commands, setCommands] = useState<SlashCommandEntry[]>([]);
	const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; replace?: boolean }>();
	const [sharedDraft, setSharedDraft] = useState("");
	const sharedDraftRef = useRef(sharedDraft);
	const [composerKey, setComposerKey] = useState(0);
	const [todoPinVisible, setTodoPinVisible] = useState(false);
	const [assistantOpen, setAssistantOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 1100);
	const paneContainerRef = useRef<HTMLDivElement>(null);
	const paneResize = useMyselfPaneResize(
		paneContainerRef,
		active && tab === "day" && dirState.status === "ready",
		assistantOpen,
	);
	const [completedOpen, setCompletedOpen] = useState(false);
	const [adding, setAdding] = useState(false);
	const [newTodo, setNewTodo] = useState("");
	const [expanded, setExpanded] = useState<string>();
	const [editingSummary, setEditingSummary] = useState(false);
	const [summaryDraft, setSummaryDraft] = useState("");
	const [undo, setUndo] = useState<UndoChange>();
	const [unsentRecord, setUnsentRecord] = useState<UnsentRecord>();
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const startedRef = useRef(false);
	const loadedRef = useRef(loaded);
	loadedRef.current = loaded;
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const sendDateRef = useRef<string | undefined>(undefined);
	const langRef = useRef(lang);
	langRef.current = lang;
	const dir = dirState.status === "ready" ? dirState.dir : undefined;
	const dirRef = useRef(dir);
	dirRef.current = dir;
	const editQueue = useRef(Promise.resolve());
	const pendingEdits = useRef(0);
	const newTodoRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (adding && tab === "day") newTodoRef.current?.focus();
	}, [adding, tab]);

	const flash = useCallback((text: string, tone: "ok" | "error"): void => {
		clearTimeout(noticeTimer.current);
		setNotice({ tone, text });
		noticeTimer.current = setTimeout(() => setNotice(undefined), 5000);
	}, []);
	useEffect(() => () => clearTimeout(noticeTimer.current), []);
	const rememberDay = useCallback((date: string, raw: string): void => {
		const parsed = parseDay(raw, date);
		loadedRef.current = new Map(loadedRef.current).set(date, parsed);
		setLoaded(loadedRef.current);
		setDays((current) => (current.includes(date) ? current : [...current, date].sort().reverse()));
	}, []);

	const readLatest = useCallback(
		async (target: string, date: string): Promise<string> => {
			try {
				return await readMyselfDay(client, target, date);
			} catch (error) {
				if (!/not found|no such file|ENOENT|不存在/i.test(errorMessage(error))) throw error;
				return newDayTemplate(date, langRef.current);
			}
		},
		[client],
	);

	/** Read the current file within a serial edit, so an Agent write is never replaced by cached UI text. */
	const mutateDay = useCallback(
		async (date: string, transform: (raw: string) => string): Promise<boolean> => {
			const target = dirRef.current;
			if (!target) return false;
			setUndo(undefined);
			pendingEdits.current++;
			setSaving(true);
			let succeeded = false;
			const operation = editQueue.current.then(async () => {
				const base = await readLatest(target, date);
				const raw = transform(base);
				if (raw !== base || !loadedRef.current.has(date)) await writeMyselfDay(client, target, date, raw);
				rememberDay(date, raw);
				succeeded = true;
			});
			editQueue.current = operation.catch(() => {});
			try {
				await operation;
				flash(t("myself.saved"), "ok");
			} catch (error) {
				flash(t("myself.saveFailed", { message: errorMessage(error) }), "error");
			} finally {
				pendingEdits.current--;
				setSaving(pendingEdits.current > 0);
			}
			return succeeded;
		},
		[client, flash, readLatest, rememberDay, t],
	);

	const logChatLine = useCallback(
		async (date: string, who: string, text: string): Promise<void> => {
			if (!text.trim()) return;
			await mutateDay(date, (raw) => {
				const last = parseDay(raw, date).chat.at(-1);
				const normalized = text.replace(/\s+/g, " ").trim();
				if (last?.who === who && last.text.replace(/\s+/g, " ").trim() === normalized) return raw;
				return appendChatLine(raw, hhmm(), who, text.trim());
			});
		},
		[mutateDay],
	);
	const logChatLineRef = useRef(logChatLine);
	logChatLineRef.current = logChatLine;
	const refreshDayRef = useRef(async (_date: string): Promise<void> => {});
	refreshDayRef.current = async (date) => {
		const target = dirRef.current;
		if (target) rememberDay(date, await readLatest(target, date));
	};

	const chatController = useMemo(() => {
		if (!dir) return undefined;
		return new MyselfChatController(
			client,
			localStorage,
			dir,
			{ model: defaultModel, thinkingLevel: defaultThinkingLevel, approvalMode: defaultApprovalMode },
			() =>
				myselfPrimer(
					selectedRef.current,
					loadedRef.current.get(selectedRef.current)?.raw ?? newDayTemplate(selectedRef.current, langRef.current),
					langRef.current,
				),
			{
				getScheduleContext: async (requestedDate?: string) => {
					const date = requestedDate ?? sendDateRef.current ?? selectedRef.current;
					const raw = await readLatest(dir, date);
					rememberDay(date, raw);
					return { date, raw };
				},
				onSettled: async (entries, turn) => {
					const date = turn?.date ?? selectedRef.current;
					for (let i = entries.length - 1; i >= 0; i--) {
						const entry = entries[i]!;
						if (entry.kind === "user") break;
						if (entry.kind === "assistant") {
							if (!entry.aborted && entry.text.trim()) await logChatLineRef.current(date, "Owl Si", entry.text);
							break;
						}
					}
					await refreshDayRef.current(date);
				},
			},
		);
	}, [client, dir, defaultModel, defaultThinkingLevel, defaultApprovalMode, readLatest, rememberDay]);
	const chat = useSyncExternalStore(
		chatController?.subscribe ?? noopSubscribe,
		chatController?.getSnapshot ?? (() => EMPTY_CHAT),
	);
	useEffect(() => {
		chatController?.start();
		return () => chatController?.dispose();
	}, [chatController]);
	useEffect(() => {
		chatController?.setConnected(connected);
		if (active && connected) {
			void chatController?.attach();
			void chatController?.refreshPresets();
			void chatController?.refreshHistory();
		}
	}, [chatController, connected, active]);
	useEffect(() => {
		if (!connected || !active || !dir) return;
		let cancelled = false;
		void client
			.request<CommandsListResult>({ type: "commands.list", cwd: dir })
			.then((response) => {
				if (!cancelled && response.ok) setCommands(response.result?.commands ?? []);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [client, dir, chat.sessionId, connected, active]);

	const loadDays = useCallback(
		async (target: string): Promise<void> => {
			const dates = (await listMyselfDays(client, target)).slice(0, DAY_READ_CAP);
			const next = new Map<string, MyselfDay>();
			await Promise.all(
				dates.map(async (date) => {
					try {
						next.set(date, parseDay(await readMyselfDay(client, target, date), date));
					} catch {
						/* A bad day file does not hide the other days. */
					}
				}),
			);
			loadedRef.current = next;
			setLoaded(next);
			setDays(dates);
		},
		[client],
	);
	const probe = useCallback(
		async (preferred?: string): Promise<void> => {
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
			} catch (error) {
				flash(t("myself.saveFailed", { message: errorMessage(error) }), "error");
			}
		},
		[client, workspaceDir, agentDir, loadDays, flash, t],
	);
	useEffect(() => {
		if (active && !startedRef.current) {
			startedRef.current = true;
			void probe();
		}
	}, [active, probe]);
	useEffect(() => {
		setCompletedOpen(false);
		setExpanded(undefined);
		setEditingSummary(false);
		setAdding(false);
		setUndo(undefined);
	}, [selected]);

	const sendChat = async (
		value: string,
		images?: ComposerImage[],
		attachedPaths?: string[],
		requestedIntent = intent,
		requestedDate = selected,
	): Promise<void> => {
		if (!chatController || chat.running || chat.busy) return;
		const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
		const command = match && commands.find((entry) => entry.name === match[1]);
		if (
			match &&
			(command?.kind === "builtin" ||
				(!command && ["new", "settings", "model", "thinking", "compact"].includes(match[1])))
		) {
			if (match[1] === "settings") {
				onOpenSettings?.("general");
				return;
			}
			if (match[1] === "new") {
				newThread();
				return;
			}
			await chatController.executeBuiltin(match[1], match[2] ?? "");
			return;
		}
		const date = requestedDate;
		const pending = { date, text: value, intent: requestedIntent, images, attachedPaths };
		const note = images?.length ? `${value}${value.trim() ? " " : ""}[图片×${images.length}]` : value;
		if (
			!(await mutateDay(date, (raw) => {
				const last = parseDay(raw, date).chat.at(-1);
				if ((last?.who === "我" || last?.who === "Me") && last.text === note.replace(/\s*\r?\n\s*/g, " ").trim())
					return raw;
				return appendChatLine(raw, hhmm(), lang === "en" ? "Me" : "我", note);
			}))
		) {
			setUnsentRecord(pending);
			setDraftRequest({ id: Date.now(), text: value, replace: true });
			return;
		}
		sendDateRef.current = date;
		try {
			const sent = await chatController.send(value, images, attachedPaths, requestedIntent, { date });
			setUnsentRecord(sent ? undefined : pending);
			if (sent && sharedDraftRef.current === value) {
				setSharedDraft("");
				sharedDraftRef.current = "";
				setDraftRequest({ id: Date.now(), text: "", replace: true });
			}
		} finally {
			sendDateRef.current = undefined;
		}
	};
	const replayChat = async (operation: () => Promise<boolean>): Promise<void> => {
		const sent = await operation();
		const failed = chatController?.getSnapshot().failedPrompt;
		if (sent) setUnsentRecord(undefined);
		else if (failed?.date) {
			setUnsentRecord({
				date: failed.date,
				text: failed.text,
				intent: failed.intent ?? "record",
				images: failed.images,
				attachedPaths: failed.attachedPaths,
			});
			setDraftRequest({ id: Date.now(), text: failed.text, replace: true });
		}
	};
	const newThread = (): void => {
		if (chatController?.newThread()) {
			setComposerKey((key) => key + 1);
			setDraftRequest(undefined);
			setSharedDraft("");
			sharedDraftRef.current = "";
			setUnsentRecord(undefined);
		}
	};
	const restoreConversation = async (id: string): Promise<boolean> => {
		if (!chatController || saving) return false;
		const restored = await chatController.switchSession(id);
		if (restored) {
			setChatView("chat");
			setIntent("record");
			setUnsentRecord(undefined);
		}
		return restored;
	};
	const handleDraftChange = useCallback((value: string): void => {
		setSharedDraft(value);
		sharedDraftRef.current = value;
		setDraftRequest(undefined);
	}, []);
	const fillDraft = (value: string, mode: MyselfChatIntent = intent): void => {
		setIntent(mode);
		setDraftRequest({ id: Date.now(), text: value });
	};
	const askAssistant = (value: string, mode: MyselfChatIntent): void => {
		setAssistantOpen(true);
		fillDraft(value, mode);
	};
	const day = loaded.get(selected) ?? parseDay(newDayTemplate(selected, lang), selected);
	const today = todayKey();
	const todos = day.todos.filter((todo) => todo.text !== "");
	const doneTodos = todos.filter((todo) => todo.done);
	const week = weekDaysOf(selected);
	const canEdit = connected && dirState.status === "ready" && !saving && !chat.running && !chat.busy;
	const sessionQuestions = questions.filter((question) => question.sessionId === chat.sessionId);
	const sessionPermissions = permissions.filter((permission) => permission.sessionId === chat.sessionId);
	const waiting = sessionQuestions.length > 0 || sessionPermissions.length > 0;
	const chatActivity: ChatActivity = !connected
		? "disconnected"
		: waiting
			? "waiting"
			: chat.running
				? "working"
				: "idle";
	const owlPose = useSessionOwlPose(chatActivity, chat.entries);
	const fmtDay = (date: string): string =>
		new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", { month: "long", day: "numeric" }).format(
			new Date(`${date}T12:00:00`),
		);
	const fmtWeekday = (date: string): string =>
		new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", { weekday: "short" }).format(
			new Date(`${date}T12:00:00`),
		);
	const schedule = todos
		.filter((todo) => !todo.done && todo.time)
		.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
	const setStatus = async (todo: MyselfTodo, status: MyselfTodoStatus): Promise<void> => {
		const previous = { date: selected, text: todo.text, status: todo.status };
		if (await mutateDay(selected, (raw) => updateTodoStatusInRaw(raw, todo.text, status))) setUndo(previous);
	};
	const moveTomorrow = async (todo: MyselfTodo): Promise<void> => {
		const target = dirRef.current;
		if (!target) return;
		const date = selected;
		setUndo(undefined);
		pendingEdits.current++;
		setSaving(true);
		const operation = editQueue.current.then(async () => {
			const nextDate = nextDayKey(date);
			const source = await readLatest(target, date);
			const destination = await readLatest(target, nextDate);
			const moved = moveTodoToTomorrow(source, destination, todo.text, date, lang);
			// Write the destination first: a failed source write cannot lose the task.
			await writeMyselfDay(client, target, moved.targetDate, moved.targetRaw);
			rememberDay(moved.targetDate, moved.targetRaw);
			await writeMyselfDay(client, target, date, moved.sourceRaw);
			rememberDay(date, moved.sourceRaw);
			setExpanded(undefined);
		});
		editQueue.current = operation.catch(() => {});
		try {
			await operation;
			flash(t("myself.movedTomorrow"), "ok");
		} catch (error) {
			flash(t("myself.saveFailed", { message: errorMessage(error) }), "error");
		} finally {
			pendingEdits.current--;
			setSaving(pendingEdits.current > 0);
		}
	};
	const taskRow = (todo: MyselfTodo): React.JSX.Element => (
		<li key={todo.text} className={`owl-myself-task${todo.done ? " is-done" : ""}`}>
			<input
				type="checkbox"
				className="owl-myself-check"
				checked={todo.done}
				aria-label={`${t(todo.done ? "myself.reopenTodo" : "myself.completeTodo")}: ${todo.text}`}
				disabled={!canEdit}
				onChange={() => void setStatus(todo, todo.done ? "todo" : "done")}
			/>
			<button
				type="button"
				className="owl-myself-task-label"
				aria-expanded={expanded === todo.text}
				onClick={() => setExpanded(expanded === todo.text ? undefined : todo.text)}
			>
				<strong>{todo.text}</strong>
				{(todo.category || todo.goal) && (
					<span>
						{todo.category && <i>{todo.category}</i>}
						{todo.goal}
					</span>
				)}
			</button>
			{todo.time && (
				<span className="owl-myself-task-time">
					<MyselfIcon name="clock" />
					{todo.time}
				</span>
			)}
			{expanded === todo.text && (
				<div className="owl-myself-task-detail">
					<label>
						{t("myself.taskStatus")}
						<select
							value={todo.status}
							disabled={!canEdit}
							onChange={(event) => void setStatus(todo, event.target.value as MyselfTodoStatus)}
						>
							{Object.entries(STATUS_LABELS).map(([status, label]) => (
								<option key={status} value={status}>
									{t(label)}
								</option>
							))}
						</select>
					</label>
					<label>
						{t("myself.taskGoal")}
						<select
							value={todo.goal ?? ""}
							disabled={!canEdit}
							onChange={(event) => {
								const goal = event.target.value;
								void mutateDay(selected, (raw) => updateTodoMetadataInRaw(raw, todo.text, { goal }));
							}}
						>
							<option value="">{t("myself.noGoal")}</option>
							{todo.goal && !day.goals.some((goal) => goal.title === todo.goal) && (
								<option value={todo.goal}>{todo.goal}</option>
							)}
							{day.goals.map((goal) => (
								<option key={goal.title} value={goal.title}>
									{goal.title}
								</option>
							))}
						</select>
					</label>
					<label>
						{t("myself.taskTime")}
						<input
							key={`${selected}:${todo.text}:time:${todo.time ?? ""}`}
							defaultValue={todo.time ?? ""}
							placeholder={t("myself.taskTimeHint")}
							disabled={!canEdit}
							onBlur={(event) => {
								const time = event.target.value;
								if (time !== (todo.time ?? ""))
									void mutateDay(selected, (raw) => updateTodoMetadataInRaw(raw, todo.text, { time }));
							}}
						/>
					</label>
					<label>
						{t("myself.taskCategory")}
						<input
							key={`${selected}:${todo.text}:category:${todo.category ?? ""}`}
							defaultValue={todo.category ?? ""}
							placeholder={t("myself.taskCategoryHint")}
							disabled={!canEdit}
							onBlur={(event) => {
								const category = event.target.value;
								if (category !== (todo.category ?? ""))
									void mutateDay(selected, (raw) => updateTodoMetadataInRaw(raw, todo.text, { category }));
							}}
						/>
					</label>
					<div className="owl-myself-task-actions">
						<button type="button" disabled={!canEdit || todo.done} onClick={() => void moveTomorrow(todo)}>
							{t("myself.moveTomorrow")}
							<MyselfIcon name="arrow" />
						</button>
						<button
							type="button"
							disabled={!connected || chat.running || chat.busy}
							onClick={() => {
								setTab("chat");
								fillDraft(t("myself.processTaskPrompt", { task: todo.text }), "process");
							}}
						>
							{t("myself.askNextStep")}
						</button>
					</div>
				</div>
			)}
		</li>
	);
	const intentControls = (
		<fieldset className="owl-myself-intents" aria-label={t("myself.intentLabel")}>
			{(["record", "plan", "process"] as const).map((mode) => (
				<button
					key={mode}
					type="button"
					aria-pressed={intent === mode}
					disabled={chat.running || chat.busy}
					onClick={() => setIntent(mode)}
				>
					{t(`myself.intent${mode === "record" ? "Record" : mode === "plan" ? "Plan" : "Process"}`)}
				</button>
			))}
			<span>
				{t(
					intent === "record" ? "myself.recordHint" : intent === "plan" ? "myself.planHint" : "myself.processHint",
				)}
			</span>
		</fieldset>
	);
	const historyControl = (
		<MyselfChatHistory
			entries={chat.history}
			loading={chat.historyLoading}
			error={chat.historyError}
			sessionId={chat.sessionId}
			disabled={!connected || chat.running || chat.busy || saving}
			onRefresh={() => void chatController?.refreshHistory()}
			onSelect={restoreConversation}
		/>
	);
	const conversation = (compact: boolean): React.JSX.Element => (
		<AgentConversation
			className={compact ? "owl-myself-compact-conversation" : "owl-myself-full-conversation"}
			view={compact ? "chat" : chatView}
			header={
				compact ? undefined : (
					<ConversationHeader
						title="Owl Si"
						workspaceDir={dir ?? ""}
						view={chatView}
						onViewChange={setChatView}
						terminalOpen={false}
						sidebarOpen={false}
						onToggleTerminal={noop}
						onToggleSidebar={noop}
						onExport={noop}
						onExportTurns={noop}
						actions={
							<>
								{historyControl}
								<button
									type="button"
									className="owl-myself-new-session"
									disabled={chat.running || chat.busy}
									onClick={newThread}
								>
									{t("myself.chatNew")}
								</button>
							</>
						}
					/>
				)
			}
			chat={
				<GenuiSessionProvider client={client} sessionId={chat.sessionId}>
					{chat.entries.length ? (
						<ChatStream
							entries={chat.entries}
							activity={chatActivity}
							client={client}
							cwd={dir ?? ""}
							onRegenerate={
								chatController && !chat.busy && !saving
									? () => void replayChat(() => chatController.regenerate())
									: undefined
							}
							onEditMessage={
								chatController && !chat.busy && !saving
									? (entryId, text, images) =>
											void replayChat(() => chatController.editMessage(entryId, text, images))
									: undefined
							}
							onBranch={
								chatController && !chat.running && !chat.busy && !saving
									? (entryId) => void chatController.branch(entryId)
									: undefined
							}
						/>
					) : (
						<div className="owl-myself-chathint">
							<span className="mark">
								<MyselfIcon name="calendar" />
							</span>
							<p className="big">{t("myself.chatEmptyTitle")}</p>
							<p>{t("myself.chatWelcome")}</p>
							{chat.previousSessionId && (
								<div className="owl-myself-return-conversation">
									<button
										type="button"
										disabled={!connected || chat.running || chat.busy || saving}
										onClick={() => void restoreConversation(chat.previousSessionId!)}
									>
										{t("myself.returnPrevious")}
									</button>
									<span>{t("myself.newChatHint")}</span>
								</div>
							)}
							<div className="owl-myself-examples">
								<button type="button" onClick={() => fillDraft(t("myself.exampleRecord"), "record")}>
									{t("myself.recordToday")}
								</button>
								<button type="button" onClick={() => fillDraft(t("myself.examplePlan"), "plan")}>
									{t("myself.planTogether")}
								</button>
								<button type="button" onClick={() => fillDraft(t("myself.exampleReview"), "plan")}>
									{t("myself.reviewTogether")}
								</button>
							</div>
						</div>
					)}
				</GenuiSessionProvider>
			}
			context={
				<ContextView
					key={`myself-context:${chat.sessionId ?? dir}`}
					client={client}
					cwd={dir ?? ""}
					sessionId={chat.sessionId}
					requireSession
					active={active && connected && !compact && chatView === "context"}
				/>
			}
			trajectory={<TrajectoryView entries={chat.entries} active={active && !compact && chatView === "trajectory"} />}
			beforeComposer={
				<>
					{unsentRecord && (
						<div className="owl-myself-chatnotice">
							<span>{t("myself.unsentRecord")}</span>
							<button
								type="button"
								disabled={chat.running || chat.busy || saving || !connected}
								onClick={() => {
									setSelected(unsentRecord.date);
									void sendChat(
										unsentRecord.text,
										unsentRecord.images,
										unsentRecord.attachedPaths,
										unsentRecord.intent,
										unsentRecord.date,
									);
								}}
							>
								{t("myself.retryRecord")}
							</button>
						</div>
					)}
					<RetryPin status={chat.retryStatus} onDismiss={() => chatController?.dismissRetry()} />
					<TodoPin
						key={`myself-todos:${chat.sessionId ?? dir}`}
						entries={chat.entries}
						onVisibleChange={setTodoPinVisible}
					/>
					{(!connected || !chat.ready || chat.error) && (
						<div className="owl-myself-chatnotice" role={chat.error ? "alert" : "status"}>
							{chat.error ?? (!connected ? t("myself.chatOffline") : t("myself.chatRestore"))}
						</div>
					)}
					{sessionPermissions.length > 0 && (
						<output className="owl-myself-chatnotice">{t("myself.waitingPermission")}</output>
					)}
				</>
			}
			questionDock={{
				requests: sessionQuestions,
				activeRequest: sessionQuestions[0],
				onAnswer: (requestId, answers, cancelled) => {
					if (onQuestionAnswer) onQuestionAnswer(requestId, answers, cancelled);
					else void client.respondQuestion(requestId, answers, cancelled);
				},
			}}
			composer={
				<Composer
					environmentAccessory={intentControls}
					key={`${dir}:${composerKey}:${compact ? "quick" : "full"}`}
					client={client}
					connected={connected}
					disabled={!connected || !chat.ready || chat.running || chat.busy || saving}
					running={chat.running}
					hideMascot={compact || todoPinVisible}
					onSend={(value, images, attachedPaths) => {
						void sendChat(value, images, attachedPaths);
					}}
					onAbort={() => void chatController?.abort()}
					providers={providers}
					model={chat.model}
					onModel={(value) => {
						void chatController?.setModel(value);
					}}
					thinkingLevel={chat.thinkingLevel}
					onThinkingLevel={(value) => {
						void chatController?.setThinkingLevel(value);
					}}
					approvalMode={chat.approvalMode}
					onApprovalMode={(mode) => {
						void chatController?.setApprovalMode(mode);
					}}
					agentPresets={chat.agentPresets}
					defaultPresetId={chat.defaultPreset}
					agentPreset={
						chat.sessionId
							? (chat.agentPreset ?? chat.nextAgentPreset ?? chat.defaultPreset)
							: (chat.nextAgentPreset ?? chat.defaultPreset)
					}
					agentPresetLocked={chat.agentPresetLocked}
					onAgentPresetSelect={(id) => void chatController?.setAgentPreset(id)}
					sessionInfo={chat.stats}
					workspaceDir={dir ?? ""}
					projects={dir ? [dir] : []}
					onSwitchProject={noop}
					commands={commands}
					searchFiles={(searchCwd, query) =>
						client
							.request<FsSearchHit[]>({ type: "fs.search", cwd: searchCwd, query })
							.then((response) => (response.ok ? (response.result ?? []) : []))
					}
					draftRequest={draftRequest}
					initialDraft={sharedDraft}
					onDraftChange={handleDraftChange}
					owlPose={owlPose}
				/>
			}
		/>
	);

	return (
		<div className={`owl-myself${active ? " is-active" : ""}`}>
			<header className="owl-myself-head">
				<span className="owl-myself-avatar">
					<MyselfIcon name="calendar" />
				</span>
				<h1>{t("rail.myself")}</h1>
				<span className="owl-myself-location">{t("myself.mySchedule")}</span>
				<div className="owl-myself-tabs" role="tablist" aria-label={t("rail.myself")}>
					<button type="button" role="tab" aria-selected={tab === "day"} onClick={() => setTab("day")}>
						{t("myself.tabDay")}
					</button>
					<button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
						{t("myself.tabChat")}
					</button>
				</div>
				<div className="owl-myself-sync">
					<span>{saving ? t("myself.saving") : t("myself.statusDays", { n: days.length })}</span>
					{tab === "day" && (
						<button
							type="button"
							aria-label={t(assistantOpen ? "myself.closeAssistant" : "myself.openAssistant")}
							aria-expanded={assistantOpen}
							onClick={() => setAssistantOpen(!assistantOpen)}
						>
							<MyselfIcon name="panel" />
						</button>
					)}
					<button
						type="button"
						disabled={saving || !connected}
						onClick={() => {
							if (dir) void loadDays(dir);
						}}
					>
						{t("myself.resync")}
					</button>
				</div>
			</header>
			{notice && (
				<div
					className="owl-myself-notice"
					data-tone={notice.tone}
					role={notice.tone === "error" ? "alert" : "status"}
				>
					<span>{notice.text}</span>
					{undo && (
						<button
							type="button"
							disabled={!canEdit}
							onClick={() => {
								const previous = undo;
								setUndo(undefined);
								void mutateDay(previous.date, (raw) =>
									updateTodoStatusInRaw(raw, previous.text, previous.status),
								);
							}}
						>
							{t("myself.undo")}
						</button>
					)}
				</div>
			)}
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
						<button type="submit" disabled={!dirInput.trim()}>
							{t("myself.dirSave")}
						</button>
					</form>
					<p className="candidates">{myselfDirCandidates(workspaceDir, agentDir).join(" · ")}</p>
				</div>
			) : dirState.status === "probing" ? (
				<output className="owl-myself-empty">{t("myself.loading")}</output>
			) : tab === "chat" ? (
				<div className="owl-myself-chatpage">{conversation(false)}</div>
			) : (
				<div
					ref={paneContainerRef}
					style={paneResize.style}
					className={`owl-myself-main${assistantOpen ? " has-assistant" : ""}`}
				>
					<input
						{...paneResize.handleProps("days")}
						aria-label={lang === "en" ? "Date sidebar width" : "日期栏宽度"}
						title={lang === "en" ? "Drag to resize, double-click to reset" : "拖拽调整宽度，双击复位"}
						data-tauri-drag-region="false"
					/>
					<nav className="owl-myself-days" aria-label={t("myself.dateNavigation")}>
						<div className="owl-myself-month">
							{new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", {
								year: "numeric",
								month: "long",
							}).format(new Date(`${selected}T12:00:00`))}
						</div>
						<div className="owl-myself-week">
							{week.map((date) => (
								<button
									key={date}
									type="button"
									aria-label={`${fmtDay(date)} ${fmtWeekday(date)}`}
									aria-pressed={selected === date}
									className={selected === date ? "is-selected" : ""}
									onClick={() => setSelected(date)}
								>
									<span>{fmtWeekday(date).replace(/^周|星期/, "")}</span>
									<b>{new Date(`${date}T12:00:00`).getDate()}</b>
								</button>
							))}
						</div>
						<div className="owl-myself-group-head">{t("myself.thisWeek")}</div>
						<button
							type="button"
							className={`owl-myself-day${selected === today ? " is-on" : ""}`}
							onClick={() => setSelected(today)}
						>
							<MyselfIcon name="calendar" />
							<span>
								{t("myself.groupToday")}
								<small>{fmtDay(today)}</small>
							</span>
						</button>
						{days
							.filter((date) => date !== today)
							.map((date) => (
								<button
									key={date}
									type="button"
									className={`owl-myself-day${selected === date ? " is-on" : ""}`}
									onClick={() => setSelected(date)}
								>
									<MyselfIcon name="clock" />
									<span>
										{fmtDay(date)}
										<small>{fmtWeekday(date)}</small>
									</span>
									<i>{loaded.get(date)?.todos.filter((todo) => todo.text && !todo.done).length || ""}</i>
								</button>
							))}
						<div className="owl-myself-week-note">
							<MyselfIcon name="leaf" />
							<p>{t("myself.weekNote")}</p>
						</div>
					</nav>
					<main className={`owl-myself-stream${selected < today ? " is-history" : ""}`}>
						<div className="owl-myself-day-content">
							<header className="owl-myself-day-head">
								<div>
									<h2>
										{fmtDay(selected)}{" "}
										<i>
											{fmtWeekday(selected)}
											{selected === today ? ` · ${t("myself.groupToday")}` : ""}
										</i>
									</h2>
									<p>{t("myself.remaining", { n: todos.length - doneTodos.length })}</p>
								</div>
								{selected !== today && (
									<button type="button" onClick={() => setSelected(today)}>
										{t("myself.backToday")}
										<MyselfIcon name="arrow" />
									</button>
								)}
							</header>
							<div className="owl-myself-day-sections">
								<section className="owl-myself-goals">
									<div className="owl-myself-section-head">
										<h3>{t("myself.goals")}</h3>
										<span>{t("myself.goalsHint")}</span>
									</div>
									{day.goals.length ? (
										day.goals.map((goal, index) => {
											const linked = todos.filter((todo) => todo.goal === goal.title);
											return (
												<article
													key={`${goal.title}:${index}`}
													className={index === 0 ? "is-priority" : ""}
												>
													<MyselfIcon name={index === 0 ? "target" : "check"} />
													<div>
														<strong>{goal.title}</strong>
														{goal.detail && <p>{goal.detail}</p>}
													</div>
													{linked.length > 0 && (
														<button type="button" onClick={() => setExpanded(linked[0]!.text)}>
															<MyselfIcon name="link" />
															{t("myself.linkedProgress", {
																done: linked.filter((todo) => todo.done).length,
																total: linked.length,
															})}
														</button>
													)}
												</article>
											);
										})
									) : (
										<p className="owl-myself-section-empty">
											{t("myself.noGoals")}
											<button
												type="button"
												disabled={!connected || chat.running}
												onClick={() => askAssistant(t("myself.planGoalsPrompt"), "plan")}
											>
												{t("myself.planTogether")}
											</button>
										</p>
									)}
								</section>
								<section className="owl-myself-todos">
									<div className="owl-myself-section-head">
										<h3>{t("myself.todos")}</h3>
										<button type="button" disabled={!canEdit} onClick={() => setAdding(!adding)}>
											<MyselfIcon name="plus" />
											{t("myself.addTodo")}
										</button>
									</div>
									{adding && (
										<form
											className="owl-myself-quick-add"
											onSubmit={(event) => {
												event.preventDefault();
												const text = newTodo.trim();
												if (!text) return;
												void mutateDay(selected, (raw) => addTodoInRaw(raw, text)).then((saved) => {
													if (saved) {
														setNewTodo("");
														setAdding(false);
													}
												});
											}}
										>
											<input
												ref={newTodoRef}
												value={newTodo}
												onChange={(event) => setNewTodo(event.target.value)}
												placeholder={t("myself.newTodoHint")}
												aria-label={t("myself.addTodo")}
											/>
											<button type="submit" disabled={!canEdit || !newTodo.trim()}>
												{t("myself.add")}
											</button>
											<button type="button" onClick={() => setAdding(false)} aria-label={t("myself.cancel")}>
												<MyselfIcon name="close" />
											</button>
										</form>
									)}
									{(["doing", "todo", "waiting"] as const).map((status) => {
										const items = todos.filter((todo) => todo.status === status);
										return items.length ? (
											<div key={status} className={`owl-myself-task-group is-${status}`}>
												<div className="owl-myself-task-group-label">
													<span />
													{t(STATUS_LABELS[status])}
													<i>{items.length}</i>
												</div>
												<ul>{items.map(taskRow)}</ul>
											</div>
										) : null;
									})}
									{!todos.some((todo) => !todo.done) && (
										<p className="owl-myself-section-empty">
											{todos.length ? t("myself.allDone") : t("myself.noTodos")}
										</p>
									)}
									<div className="owl-myself-completed">
										<button
											type="button"
											aria-expanded={completedOpen}
											onClick={() => setCompletedOpen(!completedOpen)}
										>
											<span>{completedOpen ? "−" : "+"}</span>
											{t("myself.completedCount", { n: doneTodos.length })}
										</button>
										{completedOpen && <ul>{doneTodos.map(taskRow)}</ul>}
									</div>
								</section>
								<section className="owl-myself-summary">
									<div className="owl-myself-section-head">
										<h3>{t(selected < today ? "myself.dayReview" : "myself.summary")}</h3>
										<button
											type="button"
											disabled={!connected || chat.running || chat.busy}
											onClick={() => {
												setAssistantOpen(true);
												setIntent("plan");
												void sendChat(
													t("myself.summaryPrompt", { date: selected }),
													undefined,
													undefined,
													"plan",
												);
											}}
										>
											{t(day.summary ? "myself.updateSummary" : "myself.generateSummary")}
										</button>
									</div>
									{editingSummary ? (
										<form
											className="owl-myself-summary-edit"
											onSubmit={(event) => {
												event.preventDefault();
												void mutateDay(selected, (raw) => updateSummaryInRaw(raw, summaryDraft)).then(
													(saved) => {
														if (saved) setEditingSummary(false);
													},
												);
											}}
										>
											<textarea
												value={summaryDraft}
												onChange={(event) => setSummaryDraft(event.target.value)}
												aria-label={t("myself.editSummary")}
												rows={5}
											/>
											<div>
												<button type="button" onClick={() => setEditingSummary(false)}>
													{t("myself.cancel")}
												</button>
												<button type="submit" disabled={!canEdit}>
													{t("myself.saveSummary")}
												</button>
											</div>
										</form>
									) : (
										<>
											<p className={day.summary ? "owl-myself-summary-text" : "owl-myself-section-empty"}>
												{day.summary || t("myself.summaryEmpty")}
											</p>
											<button
												type="button"
												className="owl-myself-summary-edit-button"
												disabled={!canEdit}
												onClick={() => {
													setSummaryDraft(day.summary);
													setEditingSummary(true);
												}}
											>
												{t("myself.editSummary")}
											</button>
										</>
									)}
								</section>
							</div>
							{day.notes.length > 0 && (
								<details className="owl-myself-notes">
									<summary>{t("myself.otherNotes")}</summary>
									{day.notes.map((line, index) => (
										<p key={`${index}:${line}`}>{line}</p>
									))}
								</details>
							)}
						</div>
					</main>
					{assistantOpen && (
						<aside className="owl-myself-assistant" aria-label="Owl Si">
							<input
								{...paneResize.handleProps("assistant")}
								aria-label={lang === "en" ? "Assistant pane width" : "助理栏宽度"}
								title={lang === "en" ? "Drag to resize, double-click to reset" : "拖拽调整宽度，双击复位"}
								data-tauri-drag-region="false"
							/>
							<div className="owl-myself-assistant-head">
								<strong>Owl Si</strong>
								<div className="owl-myself-assistant-actions">
									{historyControl}
									<button
										type="button"
										onClick={() => setAssistantOpen(false)}
										aria-label={t("myself.closeAssistant")}
									>
										<MyselfIcon name="close" />
									</button>
								</div>
							</div>
							<button type="button" className="owl-myself-open-full" onClick={() => setTab("chat")}>
								{t("myself.openFull")}
								<MyselfIcon name="arrow" />
							</button>
							<section className="owl-myself-schedule">
								<div className="owl-myself-section-head">
									<h3>{t("myself.timeSchedule")}</h3>
									<button
										type="button"
										disabled={!connected || chat.running}
										onClick={() => askAssistant(t("myself.planTimePrompt"), "plan")}
									>
										{t("myself.planTogether")}
									</button>
								</div>
								{schedule.length ? (
									schedule.map((todo) => (
										<div key={todo.text}>
											<time>{todo.time}</time>
											<span>{todo.text}</span>
										</div>
									))
								) : (
									<p>{t("myself.noTimeSchedule")}</p>
								)}
							</section>
							{conversation(true)}
						</aside>
					)}
				</div>
			)}
		</div>
	);
}
