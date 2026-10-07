/**
 * 自动化任务页 —— 会话内定时任务的一等 Rail 视图（schedule.* 桥命令供数）。
 *
 * 版式为原型 variant C（prototype-automation-tasks.html）：单列任务流 +
 * 右侧详情抽屉（任务定义 / 提示词 / 运行历史时间线 / 操作），新建走弹窗
 * （投递到 / 提示词 / 重复 / 错过策略）。到点投递由桥进程的 ScheduleService
 * 执行，本页只做呈现与编辑；schedule.changed 推送 + 5s 轮询保活。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ScheduleListResult, ScheduleRepeat, ScheduleRun, ScheduleTask } from "../../bridge/protocol.ts";
import { useT, type TextKey } from "../../i18n/index.ts";
import { formatClock, untilLabel } from "./schedule-delivery.ts";
import "./automation.css";

type RepeatDraft =
	| { kind: "daily"; time: string }
	| { kind: "weekly"; weekday: number; time: string }
	| { kind: "once"; at: number }
	| { kind: "interval"; minutes: number }
	| { kind: "cron"; expr: string };

interface CreateDraft {
	name: string;
	emoji: string;
	prompt: string;
	sessionId: string;
	targetLabel: string;
	repeatKind: "daily" | "weekly" | "once" | "interval" | "cron";
	time: string;
	weekday: number;
	intervalMinutes: number;
	cronExpr: string;
	missed: "catch-up" | "skip" | "wake";
}

const REPEAT_KINDS = ["daily", "weekly", "once", "interval", "cron"] as const;

/** 示例引导：点卡片只是预填新建弹窗，确认创建前什么都不会跑。 */
const TEMPLATE_GUIDES: ReadonlyArray<{ emoji: string; nameKey: TextKey; descKey: TextKey; draft: Partial<CreateDraft> }> = [
	{ emoji: "🌱", nameKey: "automation.tplGuideName", descKey: "automation.tplGuideDesc", draft: { repeatKind: "daily", time: "08:30" } },
	{ emoji: "📮", nameKey: "automation.tplInboxName", descKey: "automation.tplInboxDesc", draft: { repeatKind: "daily", time: "09:00" } },
	{ emoji: "📊", nameKey: "automation.tplTokenName", descKey: "automation.tplTokenDesc", draft: { repeatKind: "weekly", weekday: 1, time: "09:00" } },
	{ emoji: "🔧", nameKey: "automation.tplGitName", descKey: "automation.tplGitDesc", draft: { repeatKind: "weekly", weekday: 5, time: "17:00" } },
	{ emoji: "📅", nameKey: "automation.tplWeekName", descKey: "automation.tplWeekDesc", draft: { repeatKind: "weekly", weekday: 1, time: "08:00" } },
	{ emoji: "⏰", nameKey: "automation.tplOnceName", descKey: "automation.tplOnceDesc", draft: { repeatKind: "once", time: "09:00" } },
];

const EMPTY: ScheduleListResult = { tasks: [], runs: {} };

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatLocal(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(ms)}`;
}

function describeRepeat(repeat: ScheduleRepeat): string {
	switch (repeat.kind) {
		case "daily":
			return `每天 ${repeat.time}`;
		case "weekly":
			return `周${"日一二三四五六"[repeat.weekday] ?? "?"} ${repeat.time}`;
		case "once":
			return `一次性 · ${formatLocal(repeat.at)}`;
		case "interval":
			return repeat.minutes % 60 === 0 ? `每 ${repeat.minutes / 60} 小时` : `每 ${repeat.minutes} 分钟`;
		case "cron":
			return `cron ${repeat.expr}`;
	}
}

/** 「即将执行」侧栏：未来 7 天的运行计划。 */
function upcomingRuns(tasks: readonly ScheduleTask[], now: number): { task: ScheduleTask; at: number }[] {
	const horizon = now + 7 * 86_400_000;
	const out: { task: ScheduleTask; at: number }[] = [];
	for (const task of tasks) {
		if (!task.enabled) continue;
		let cursor = task.nextRunAt;
		let guard = 0;
		while (cursor !== null && cursor <= horizon && guard < 8) {
			out.push({ task, at: cursor });
			cursor = nextAfter(task.repeat, cursor);
			guard += 1;
		}
	}
	return out.sort((left, right) => left.at - right.at).slice(0, 12);
}

/** 前端只做展示推算（精确计算在桥端 nextRunAt，这里保守近似：每日/每周够用）。 */
function nextAfter(repeat: ScheduleRepeat, after: number): number | null {
	switch (repeat.kind) {
		case "daily": {
			const [h, m] = repeat.time.split(":").map(Number);
			const next = new Date(after);
			next.setHours(h ?? 0, m ?? 0, 0, 0);
			return next.getTime() > after ? next.getTime() : next.getTime() + 86_400_000;
		}
		case "weekly": {
			const [h, m] = repeat.time.split(":").map(Number);
			const next = new Date(after);
			next.setHours(h ?? 0, m ?? 0, 0, 0);
			let offset = (repeat.weekday - next.getDay() + 7) % 7;
			if (offset === 0 && next.getTime() <= after) offset = 7;
			return next.getTime() + offset * 86_400_000;
		}
		case "interval":
			return after + repeat.minutes * 60_000;
		case "once":
			return null;
		case "cron":
			return null;
	}
}

export function AutomationPage({ client, active, sessions, onOpenSession }: {
	client: BridgeClient;
	/** 视图是否可见（隐藏时暂停轮询）。 */
	active: boolean;
	/** 侧栏已知会话（id → 标题），创建弹窗的投递目标候选。 */
	sessions: readonly { id: string; title: string }[];
	/** 运行历史里「打开会话」：跳到该次投递实际发生的会话。 */
	onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
	const t = useT();
	const [data, setData] = useState<ScheduleListResult>(EMPTY);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [modalOpen, setModalOpen] = useState(false);
	const [editing, setEditing] = useState<ScheduleTask | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const liveRef = useRef(active);
	liveRef.current = active;

	const refresh = async (): Promise<void> => {
		try {
			const result = await client.request<ScheduleListResult>({ type: "schedule.list" });
			if (result.ok) setData(result.result ?? EMPTY);
		} catch {
			// 轮询失败静默（连接断开时页面置灰由 connected 控制）
		}
	};

	useEffect(() => {
		if (!active) return;
		void refresh();
		const offChanged = client.onScheduleChanged(() => void refresh());
		const poll = setInterval(() => void refresh(), 5_000);
		const clock = setInterval(() => setNow(Date.now()), 30_000);
		return () => {
			offChanged();
			clearInterval(poll);
			clearInterval(clock);
		};
	}, [active, client]);

	// 投递目标候选：「新会话（每次新建）」置顶，其余来自侧栏会话清单。
	const targets = useMemo(
		() => [{ id: "__new__", title: t("automation.newSessionTarget") }, ...sessions],
		[sessions, t],
	);
	const tasks = data.tasks;
	const selected = useMemo(
		() => tasks.find((task) => task.id === selectedId) ?? tasks[0] ?? null,
		[tasks, selectedId],
	);
	const runs = selected ? data.runs[selected.id] ?? [] : [];
	const upcoming = useMemo(() => upcomingRuns(tasks, now), [tasks, now]);

	const createDefault = (): CreateDraft => ({
		name: "",
		emoji: "",
		prompt: "",
		sessionId: "__new__",
		targetLabel: t("automation.newSessionTarget"),
		repeatKind: "daily",
		time: "09:00",
		weekday: 1,
		intervalMinutes: 30,
		cronExpr: "0 9 * * 1-5",
		missed: "catch-up",
	});
	const [draft, setDraft] = useState<CreateDraft>(createDefault);

	const openCreate = (): void => {
		setEditing(null);
		setDraft(createDefault());
		setError(null);
		setModalOpen(true);
	};
	const applyTemplate = (tpl: (typeof TEMPLATE_GUIDES)[number]): void => {
		setEditing(null);
		setDraft({ ...createDefault(), name: t(tpl.nameKey), emoji: tpl.emoji, prompt: t(tpl.descKey), ...tpl.draft });
		setError(null);
		setModalOpen(true);
	};
	const openEdit = (task: ScheduleTask): void => {
		setEditing(task);
		setDraft({
			name: task.name,
			emoji: task.emoji,
			prompt: task.prompt,
			sessionId: task.sessionId,
			targetLabel: task.targetLabel,
			repeatKind: task.repeat.kind,
			time: task.repeat.kind === "daily" || task.repeat.kind === "weekly" ? task.repeat.time : "09:00",
			weekday: task.repeat.kind === "weekly" ? task.repeat.weekday : 1,
			intervalMinutes: task.repeat.kind === "interval" ? task.repeat.minutes : 30,
			cronExpr: task.repeat.kind === "cron" ? task.repeat.expr : "0 9 * * 1-5",
			missed: task.missed,
		});
		setError(null);
		setModalOpen(true);
	};

	const submitDraft = async (): Promise<void> => {
		let repeat: RepeatDraft;
		switch (draft.repeatKind) {
			case "daily":
				repeat = { kind: "daily", time: draft.time };
				break;
			case "weekly":
				repeat = { kind: "weekly", weekday: draft.weekday, time: draft.time };
				break;
			case "once": {
				// 编辑一次性任务且不动类型时保留原时刻：弹窗只有时间选择没有日期，
				// 按今天重算会把明天的提醒悄悄改成今天（甚至已过期）。
				if (editing?.repeat.kind === "once") {
					repeat = editing.repeat;
					break;
				}
				const [h, m] = draft.time.split(":").map(Number);
				const date = new Date();
				date.setHours(h ?? 0, m ?? 0, 0, 0);
				if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
				repeat = { kind: "once", at: date.getTime() };
				break;
			}
			case "interval":
				repeat = { kind: "interval", minutes: draft.intervalMinutes };
				break;
			case "cron":
				repeat = { kind: "cron", expr: draft.cronExpr };
				break;
		}
		setBusy(true);
		setError(null);
		try {
			if (editing) {
				await client.request({ type: "schedule.update", taskId: editing.id, name: draft.name, emoji: draft.emoji, prompt: draft.prompt, targetLabel: draft.targetLabel, repeat, missed: draft.missed });
			} else {
				await client.request({ type: "schedule.create", name: draft.name, emoji: draft.emoji, prompt: draft.prompt, sessionId: draft.sessionId, targetLabel: draft.targetLabel, repeat, missed: draft.missed });
			}
			setModalOpen(false);
			await refresh();
		} catch (requestError) {
			setError(requestError instanceof Error ? requestError.message : String(requestError));
		} finally {
			setBusy(false);
		}
	};

	const toggleTask = async (task: ScheduleTask): Promise<void> => {
		setBusy(true);
		try {
			await client.request({ type: "schedule.update", taskId: task.id, enabled: !task.enabled });
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const runTask = async (task: ScheduleTask): Promise<void> => {
		setBusy(true);
		try {
			await client.request({ type: "schedule.run", taskId: task.id });
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const removeTask = async (task: ScheduleTask): Promise<void> => {
		setBusy(true);
		try {
			await client.request({ type: "schedule.delete", taskId: task.id });
			if (selectedId === task.id) setSelectedId(null);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const activeCount = tasks.filter((task) => task.enabled).length;
	const nextUp = tasks.filter((task) => task.enabled && task.nextRunAt !== null).sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))[0];

	return (
		<div className="owl-automation" data-active={active ? "true" : "false"}>
			<div className="owl-automation-head">
				<div className="owl-automation-title">
					<h2>{t("automation.title")}</h2>
					<span>{t("automation.subtitle")}</span>
				</div>
				<div className="owl-automation-actions">
					{nextUp && (
						<span className="owl-automation-next">
							{t("automation.nextRun", {
								name: nextUp.name,
								time: formatClock(nextUp.nextRunAt ?? Date.now()),
								until: untilLabel(nextUp.nextRunAt, now),
							})}
						</span>
					)}
					<button type="button" className="owl-automation-create" onClick={openCreate}>
						＋ {t("automation.create")}
					</button>
				</div>
			</div>
			<div className="owl-automation-body">
				<section className="owl-automation-list">
					{tasks.length === 0 && (
						<div className="owl-automation-empty">
							<div className="owl-automation-empty-icon">⏱</div>
							<h3>{t("automation.emptyTitle")}</h3>
							<p>{t("automation.emptyHint")}</p>
							<button type="button" className="owl-automation-create" onClick={openCreate}>
								＋ {t("automation.create")}
							</button>
							{sessions.length === 0 && <p className="owl-automation-empty-note">{t("automation.needSessionHint")}</p>}
							<p className="owl-automation-tpl-title">{t("automation.templatesTitle" as TextKey)}</p>
							<div className="owl-automation-tpl-grid">
								{TEMPLATE_GUIDES.map((tpl) => (
									<button key={tpl.nameKey} type="button" className="owl-automation-tpl" onClick={() => applyTemplate(tpl)}>
										<h4>{tpl.emoji} {t(tpl.nameKey)}</h4>
										<p>{t(tpl.descKey)}</p>
									</button>
								))}
							</div>
						</div>
					)}
					{tasks.map((task) => (
						<article
							key={task.id}
							className={"owl-automation-card" + (task.enabled ? "" : " is-off") + (selected?.id === task.id ? " is-selected" : "")}
							onClick={() => setSelectedId(task.id)}
							role="button"
							tabIndex={0}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									setSelectedId(task.id);
								}
							}}
						>
							<div className="owl-automation-card-top">
								<span className="owl-automation-emoji">{task.emoji || "⏱"}</span>
								<span className="owl-automation-name">{task.name}</span>
								<span className={"owl-automation-chip" + (task.enabled ? "" : " is-pause")}>{describeRepeat(task.repeat)}{task.enabled ? "" : ` · ${t("automation.paused")}`}</span>
								<div
									className={"owl-automation-switch" + (task.enabled ? " is-on" : "")}
									role="switch"
									aria-checked={task.enabled}
									aria-label={t("automation.toggleAria", { name: task.name })}
									onClick={(event) => {
										event.stopPropagation();
										void toggleTask(task);
									}}
								/>
							</div>
							<div className="owl-automation-card-target">→ {task.targetLabel}</div>
							<div className="owl-automation-card-foot">
								<RunBadge run={(data.runs[task.id] ?? [])[0]} t={t} />
								<span className="owl-automation-until">{task.enabled ? untilLabel(task.nextRunAt, now) : task.repeat.kind === "once" ? t("automation.done") : t("automation.paused")}</span>
							</div>
						</article>
					))}
				</section>
				{selected && (
					<aside className="owl-automation-drawer">
						<header className="owl-automation-drawer-head">
							<span className="owl-automation-emoji">{selected.emoji || "⏱"}</span>
							<div>
								<h3>{selected.name}</h3>
								<span>→ {selected.targetLabel}</span>
							</div>
							<span className={"owl-automation-chip" + (selected.enabled ? "" : " is-pause")}>{describeRepeat(selected.repeat)}</span>
						</header>
						<div className="owl-automation-drawer-scroll">
							<section className="owl-automation-dw-sec">
								<h4>{t("automation.definition")}</h4>
								<dl className="owl-automation-kv">
									<dt>{t("automation.kvRepeat")}</dt>
									<dd>{describeRepeat(selected.repeat)}</dd>
									<dt>{t("automation.kvDeliver")}</dt>
									<dd>{selected.sessionId === "__new__" ? t("automation.deliverToNew") : t("automation.deliverTo", { target: selected.targetLabel })}</dd>
									<dt>{t("automation.kvMissed")}</dt>
									<dd>{t(`automation.missed_${selected.missed}` as never)}</dd>
									<dt>{t("automation.kvCreated")}</dt>
									<dd>{formatLocal(selected.createdAt)} · {t("automation.ranCount", { count: (data.runs[selected.id] ?? []).length })}</dd>
								</dl>
							</section>
							<section className="owl-automation-dw-sec">
								<h4>{t("automation.kvPrompt")}</h4>
								<pre className="owl-automation-prompt">{selected.prompt}</pre>
							</section>
							<section className="owl-automation-dw-sec">
								<h4>{t("automation.history")}</h4>
								{runs.length === 0 && <p className="owl-automation-hist-empty">{t("automation.noRuns")}</p>}
								<div className="owl-automation-hist">
									{runs.map((run) => (
										<div key={run.id} className={"owl-automation-hist-item" + (run.status === "error" ? " is-bad" : run.status === "pending" ? " is-wait" : "")}>
											<span className="owl-automation-hist-dot" />
											<div>
												<div className="owl-automation-hist-when">
													{run.status === "pending" || run.deliveredAt === null
														? formatLocal(run.scheduledAt)
														: `${formatLocal(run.deliveredAt)}${run.scheduledAt !== run.deliveredAt ? ` (${t("automation.scheduledAt", { time: formatLocal(run.scheduledAt) })})` : ""}`}
													{run.durationMs !== undefined && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
												</div>
												<div className="owl-automation-hist-what">
													<b>{t(`automation.run_${run.status}` as never)}</b>
													{run.note && <span> · {run.note}</span>}
													{run.sessionId && onOpenSession && run.status === "ok" && (
														<button type="button" className="owl-automation-hist-open" onClick={(event) => { event.stopPropagation(); onOpenSession(run.sessionId!); }}>
															{t("automation.openSession" as TextKey)} ↗
														</button>
													)}
												</div>
											</div>
										</div>
									))}
								</div>
							</section>
							<div className="owl-automation-dw-actions">
								<button type="button" disabled={busy} onClick={() => void runTask(selected)}>{t("automation.runNow")}</button>
								<button type="button" disabled={busy} onClick={() => void toggleTask(selected)}>{selected.enabled ? t("automation.pause") : t("automation.resume")}</button>
								<button type="button" disabled={busy} onClick={() => openEdit(selected)}>{t("automation.edit")}</button>
								<button type="button" className="is-danger" disabled={busy} onClick={() => void removeTask(selected)}>{t("automation.delete")}</button>
							</div>
						</div>
					</aside>
				)}
			</div>
			{activeCount > 0 && upcoming.length > 0 && (
				<footer className="owl-automation-upcoming">
					<span className="owl-automation-upcoming-label">{t("automation.upcoming")}</span>
					{upcoming.slice(0, 6).map(({ task, at }) => (
						<span key={`${task.id}-${at}`} className="owl-automation-upcoming-item">
							<b>{formatClock(at)}</b> {task.name}
						</span>
					))}
				</footer>
			)}
			{modalOpen && (
				<div className="owl-automation-overlay" onClick={(event) => {
					if (event.target === event.currentTarget) setModalOpen(false);
				}}
				>
					<div className="owl-automation-modal" role="dialog" aria-modal="true" aria-label={editing ? t("automation.editTitle") : t("automation.createTitle")}>
						<header>
							<h3>{editing ? t("automation.editTitle") : t("automation.createTitle")}</h3>
							<button type="button" onClick={() => setModalOpen(false)}>✕</button>
						</header>
						<div className="owl-automation-modal-body">
							<label className="owl-automation-field">
								<span>{t("automation.fieldName")}</span>
								<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("automation.fieldNamePh")} />
							</label>
							<div className="owl-automation-field-row">
								<label className="owl-automation-field" style={{ width: 72 }}>
									<span>{t("automation.fieldEmoji")}</span>
									<input value={draft.emoji} onChange={(event) => setDraft({ ...draft, emoji: event.target.value })} placeholder="🌱" />
								</label>
								<label className="owl-automation-field" style={{ flex: 1 }}>
									<span>{t("automation.fieldTarget")}</span>
									<select
										value={draft.sessionId}
										onChange={(event) => {
											const hit = targets.find((session) => session.id === event.target.value);
											setDraft({ ...draft, sessionId: event.target.value, targetLabel: hit?.title ?? event.target.value });
										}}
									>
										{targets.map((session) => (
											<option key={session.id} value={session.id}>{session.title}</option>
										))}
									</select>
								</label>
							</div>
							<label className="owl-automation-field">
								<span>{t("automation.fieldPrompt")}</span>
								<textarea value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder={t("automation.fieldPromptPh")} />
							</label>
							<div className="owl-automation-field">
								<span>{t("automation.fieldRepeat")}</span>
								<div className="owl-automation-field-row">
									<div className="owl-automation-seg">
										{REPEAT_KINDS.map((kind) => (
											<button key={kind} type="button" className={draft.repeatKind === kind ? "is-on" : ""} onClick={() => setDraft({ ...draft, repeatKind: kind })}>
												{t(`automation.kind_${kind}` as never)}
											</button>
										))}
									</div>
									{(draft.repeatKind === "daily" || draft.repeatKind === "weekly" || draft.repeatKind === "once") && (
										<input className="owl-automation-time" type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} />
									)}
									{draft.repeatKind === "weekly" && (
										<select value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}>
											{"日一二三四五六".split("").map((label, index) => (
												<option key={label} value={index}>周{label}</option>
											))}
										</select>
									)}
									{draft.repeatKind === "interval" && (
										<label className="owl-automation-inline">
											<input type="number" min={5} max={1440} value={draft.intervalMinutes} onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} />
											<span>{t("automation.minutesUnit")}</span>
										</label>
									)}
									{draft.repeatKind === "cron" && (
										<input className="owl-automation-time" style={{ width: 150 }} value={draft.cronExpr} onChange={(event) => setDraft({ ...draft, cronExpr: event.target.value })} placeholder="*/15 * * * *" />
									)}
								</div>
							</div>
							<div className="owl-automation-field">
								<span>{t("automation.fieldMissed")}</span>
								<div className="owl-automation-radios">
									{(["catch-up", "skip", "wake"] as const).map((policy) => (
										<button
											key={policy}
											type="button"
											className={"owl-automation-radio" + (draft.missed === policy ? " is-on" : "")}
											onClick={() => setDraft({ ...draft, missed: policy })}
										>
											<span className="owl-automation-radio-dot" />
											<span>
												<b>{t(`automation.missed_${policy}` as never)}</b>
												<small>{t(`automation.missed_${policy}_hint` as never)}</small>
											</span>
										</button>
									))}
								</div>
							</div>
							{error && <p className="owl-automation-error" role="alert">{error}</p>}
						</div>
						<footer className="owl-automation-modal-foot">
							<span>{t("automation.submitHint")}</span>
							<button type="button" className="owl-automation-ghost" onClick={() => setModalOpen(false)}>{t("automation.cancel")}</button>
							<button type="button" className="owl-automation-create" disabled={busy || draft.name.trim() === "" || draft.prompt.trim() === ""} onClick={() => void submitDraft()}>
								{editing ? t("automation.save") : t("automation.createAndTest")}
							</button>
						</footer>
					</div>
				</div>
			)}
		</div>
	);
}

function RunBadge({ run, t }: {
	run: ScheduleRun | undefined;
	t: ReturnType<typeof useT>;
}): React.JSX.Element {
	if (run === undefined) return <span className="owl-automation-run"><i className="is-idle" />{t("automation.neverRan")}</span>;
	return (
		<span className="owl-automation-run">
			<i className={run.status === "ok" ? "is-ok" : run.status === "error" ? "is-bad" : run.status === "pending" ? "is-wait" : "is-idle"} />
			{run.deliveredAt !== null
				? `${formatClock(run.deliveredAt)} · ${t(`automation.run_${run.status}` as never)}${run.durationMs !== undefined ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ""}`
				: t(`automation.run_${run.status}` as never)}
		</span>
	);
}
