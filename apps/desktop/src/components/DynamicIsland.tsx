import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePendingResponses } from "../bridge/pending-responses.ts";
import { useT } from "../i18n/index.ts";
import {
	emptyIslandMemory,
	type IslandMemorySnapshot,
	loadIslandMemory,
	mergeIslandMemory,
	reconcileIslandMemory,
	rememberIslandCompletion,
	saveIslandMemory,
} from "./dynamic-island-memory.ts";
import {
	dismissFinished,
	dismissFinishedAll,
	formatRunClock,
	type IslandOutcome,
	type IslandSession,
	islandBatchAckVisible,
	islandCanReply,
	islandCompactAction,
	islandFace,
	islandJumpTarget,
	islandPips,
	orderedRunning,
	visibleFinished,
} from "./dynamic-island-model.ts";
import { PendingResponseNotice } from "./PendingResponseNotice.tsx";
import { usePendingRequestCopy } from "./pending-request-copy.ts";

export interface DynamicIslandProps {
	running: readonly IslandSession[];
	/** 本地 agent 数据目录。尚未确认身份时不读取或写入缓存。 */
	memoryScope?: string;
	/** 后端已完成恢复并校准运行清单；断连期间为 false。 */
	runningReady?: boolean;
	/** 已知的会话显示名，用于同步重命名，不能包含临时的未命名回退值。 */
	knownTitles?: ReadonlyMap<string, string>;
	/** 一段会话结束时递增 seq。同一 seq 只记一次。 */
	notice: { seq: number; id: string; outcome: IslandOutcome } | null;
	titleOf: (sessionId: string) => string;
	onOpen: (sessionId: string) => void;
	permissionFor?: (
		sessionId: string,
	) =>
		| { requestId: string; toolName?: string; description?: string; contextLabel?: string; workspace?: string }
		| undefined;
	onOpenPermission?: (requestId: string) => void;
	choicesFor?: (sessionId: string) => { requestId: string; labels: readonly string[] } | undefined;
	onPermission?: (requestId: string, approved: boolean) => void;
	onChoose?: (requestId: string, label: string) => void;
	onReply?: (sessionId: string, text: string) => void;
	/** 每次渲染写入。Ctrl+. 打开胶囊上正在写的那一段。 */
	jumpToFace?: { current: (() => void) | null };
}

interface IslandLayout {
	center: number;
	max: number;
	ready: boolean;
}

/** 顶栏里的胶囊。水平中心对齐会话栏顶边的中点，底边贴着这条线。 */
export function DynamicIsland(props: DynamicIslandProps): React.JSX.Element {
	const seenNotice = useRef<number | null>(null);
	const pendingMemory = useRef<IslandMemorySnapshot | null>(null);
	return (
		<DynamicIslandContent
			key={props.memoryScope ?? ""}
			{...props}
			seenNotice={seenNotice}
			pendingMemory={pendingMemory}
		/>
	);
}

function DynamicIslandContent({
	running,
	notice,
	titleOf,
	onOpen,
	jumpToFace,
	permissionFor,
	onOpenPermission,
	choicesFor,
	onPermission,
	onChoose,
	onReply,
	memoryScope,
	runningReady = true,
	knownTitles,
	seenNotice,
	pendingMemory,
}: DynamicIslandProps & {
	seenNotice: { current: number | null };
	pendingMemory: { current: IslandMemorySnapshot | null };
}): React.JSX.Element {
	const t = useT();
	const copy = usePendingRequestCopy();
	const { feedback } = usePendingResponses();
	const root = useRef<HTMLDivElement>(null);
	const [memory, setMemory] = useState(() => {
		const saved = memoryScope
			? (loadIslandMemory(window.localStorage, memoryScope) ?? emptyIslandMemory())
			: emptyIslandMemory();
		return memoryScope && pendingMemory.current ? mergeIslandMemory(saved, pendingMemory.current) : saved;
	});
	const titleFor = useRef(titleOf);
	titleFor.current = titleOf;
	const [landing, setLanding] = useState(false);
	const { expanded, replyFor, replyDraft } = memory;
	const setExpanded = (value: boolean | ((current: boolean) => boolean)): void =>
		setMemory((current) => ({ ...current, expanded: typeof value === "function" ? value(current.expanded) : value }));
	const setReplyFor = (value: string | null): void => setMemory((current) => ({ ...current, replyFor: value }));
	const setReplyDraft = (value: string): void => setMemory((current) => ({ ...current, replyDraft: value }));
	const replyInput = useRef<HTMLInputElement>(null);
	const [layout, setLayout] = useState<IslandLayout>({ center: 0, max: 360, ready: false });

	useEffect(() => {
		if (!notice || seenNotice.current === notice.seq) return;
		seenNotice.current = notice.seq;
		setMemory((current) =>
			rememberIslandCompletion(current, notice.id, titleFor.current(notice.id), Date.now(), notice.outcome),
		);
		setLanding(true);
		const timer = window.setTimeout(() => setLanding(false), 720);
		return () => window.clearTimeout(timer);
	}, [notice, seenNotice]);

	useEffect(() => {
		setMemory((current) => reconcileIslandMemory(current, running, runningReady, Date.now(), knownTitles));
	}, [running, runningReady, knownTitles]);

	useLayoutEffect(() => {
		if (!memoryScope) {
			pendingMemory.current = memory;
			return;
		}
		pendingMemory.current = null;
		saveIslandMemory(window.localStorage, memoryScope, memory);
	}, [memoryScope, memory, pendingMemory]);

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (running.length === 0 && memory.running.length === 0) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [running.length, memory.running.length]);

	const presentation = reconcileIslandMemory(memory, running, runningReady, now, knownTitles);
	const done = visibleFinished(presentation.running, presentation.finished);
	const face = islandFace(presentation.running, done);
	const action = islandCompactAction(face);
	const rows = orderedRunning(presentation.running);
	const pips = islandPips(rows);
	const open = expanded && (rows.length > 0 || done.length > 0);

	useEffect(() => {
		if (rows.length === 0 && done.length === 0) setExpanded(false);
	}, [rows.length, done.length]);

	useEffect(() => {
		if (!expanded) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setExpanded(false);
				setReplyFor(null);
			}
		};
		const onPointer = (event: PointerEvent): void => {
			if (!root.current?.contains(event.target as Node)) {
				setExpanded(false);
				setReplyFor(null);
			}
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointer);
		};
	}, [expanded]);

	useEffect(() => {
		if (replyFor) replyInput.current?.focus();
	}, [replyFor]);

	useLayoutEffect(() => {
		let frame = 0;
		const measure = (): void => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const bar = root.current?.closest(".owl-desktop-titlebar");
				if (!(bar instanceof HTMLElement)) return;
				const barBox = bar.getBoundingClientRect();
				const columns = [...document.querySelectorAll("[data-owl-island-anchor]")].filter(
					(node): node is HTMLElement => node instanceof HTMLElement && node.getBoundingClientRect().width > 1,
				);
				const column = columns.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
				if (!column) return;
				const col = column.getBoundingClientRect();
				const center = Math.round(col.left + col.width / 2 - barBox.left);
				const menus = bar.querySelector(".owl-desktop-menu-row")?.getBoundingClientRect();
				const controls = bar.querySelector(".owl-desktop-window-controls")?.getBoundingClientRect();
				const leftLimit = Math.round(Math.max(col.left, menus ? menus.right + 8 : barBox.left) - barBox.left);
				const rightLimit = Math.round(
					Math.min(col.right, controls ? controls.left - 8 : barBox.right) - barBox.left,
				);
				const half = Math.max(75, Math.min(center - leftLimit, rightLimit - center));
				const max = Math.max(150, Math.floor(half * 2));
				setLayout((current) => {
					if (current.ready && Math.abs(current.center - center) < 1 && Math.abs(current.max - max) < 1)
						return current;
					return { center, max, ready: true };
				});
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		const sidebar = document.getElementById("owl-session-sidebar");
		const body = document.querySelector(".owl-desktop-body");
		if (sidebar) observer.observe(sidebar);
		if (body) observer.observe(body);
		const anchors = [...document.querySelectorAll("[data-owl-island-anchor]")];
		for (const node of anchors) observer.observe(node);
		const mutations = new MutationObserver(measure);
		for (const node of anchors) mutations.observe(node, { attributes: true, attributeFilter: ["style", "hidden"] });
		if (sidebar) mutations.observe(sidebar, { attributes: true, attributeFilter: ["style", "hidden"] });
		window.addEventListener("resize", measure);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, []);

	const stepText = (step: string): string =>
		step === "thinking" ? t("island.stepThinking") : step === "writing" ? t("island.stepWriting") : step;
	const waitText = (kind: IslandSession["waitKind"], waiting: boolean): string =>
		kind === "permission"
			? t("island.waitingPermission")
			: kind === "question"
				? t("island.waitingQuestion")
				: waiting
					? t("island.waiting")
					: "";
	const clockText = (startedAt: number): string => (startedAt > 0 ? formatRunClock(startedAt, now) : "");
	const shown = face.kind === "live" ? rows.find((session) => session.id === face.id) : undefined;
	const shownStep = shown ? (shown.disconnected ? t("island.disconnected") : stepText(shown.step)) : "";
	const shownClock = shown ? clockText(shown.startedAt) : "";
	const shownWhisper = shown?.waitKind === "question" ? shown.whisper : "";

	if (jumpToFace) {
		jumpToFace.current = () => {
			const target = islandJumpTarget(face);
			if (!target) return;
			setExpanded(false);
			onOpen(target);
		};
	}

	const label =
		face.kind === "live"
			? face.disconnected
				? t("island.disconnectedLive", { title: face.title })
				: face.waitKind === "permission"
					? t("island.waitingPermissionLive", { title: face.title })
					: face.waitKind === "question"
						? t("island.waitingQuestionLive", { title: face.title })
						: face.waiting
							? t("island.waitingLive", { title: face.title })
							: face.count > 1
								? t("island.liveCount", { title: face.title, count: face.count })
								: t("island.live", { title: face.title })
			: face.kind === "done"
				? face.outcome === "aborted"
					? t("island.abortedLive", { title: face.title })
					: face.outcome === "error"
						? t("island.failedLive", { title: face.title })
						: face.count > 1
							? t("island.doneCountLive", { title: face.title, count: face.count })
							: t("island.doneLive", { title: face.title })
				: "";
	const spoken =
		face.kind === "live" && (shownWhisper !== "" || shownStep !== "" || shownClock !== "")
			? `${label}，${[shownWhisper, shownWhisper === "" ? shownStep : "", shownClock].filter((part) => part !== "").join("，")}`
			: label;

	const openSession = (id: string): void => {
		setExpanded(false);
		onOpen(id);
	};

	const acknowledge = (id: string): void => {
		setMemory((current) => ({ ...current, finished: dismissFinished(current.finished, id) }));
		if (replyFor === id) setReplyFor(null);
	};

	const acknowledgeAll = (): void => {
		setMemory((current) => ({ ...current, finished: dismissFinishedAll(current.finished, done) }));
		setReplyFor(null);
	};

	const outcomeText = (outcome: IslandOutcome): string =>
		outcome === "aborted" ? t("island.aborted") : outcome === "error" ? t("island.failed") : t("island.done");

	const beginReply = (id: string): void => {
		setReplyFor(id);
		setReplyDraft("");
		setExpanded(true);
	};

	const sendReply = (id: string, text: string): void => {
		const trimmed = text.trim();
		if (!trimmed) return;
		onReply?.(id, trimmed);
		setReplyFor(null);
		setReplyDraft("");
		setExpanded(false);
	};

	const onFaceClick = (): void => {
		if (action.type === "none") return;
		if (action.type === "open") {
			openSession(action.id);
			return;
		}
		setExpanded((current) => !current);
	};

	const mode = face.kind === "idle" ? "is-idle" : open ? "is-open" : face.kind === "done" ? "is-done" : "is-live";

	return (
		<div
			ref={root}
			className={`owl-island ${mode}${landing ? " is-landing" : ""}`}
			data-waiting={face.kind === "live" && face.waiting ? true : undefined}
			data-disconnected={face.kind === "live" && face.disconnected ? true : undefined}
			data-outcome={face.kind === "done" ? face.outcome : undefined}
			style={{
				left: layout.center,
				["--owl-island-max" as string]: `${layout.max}px`,
				visibility: layout.ready ? "visible" : "hidden",
			}}
			data-tauri-drag-region="false"
		>
			{face.kind === "idle" ? (
				<div className="owl-island-face" aria-hidden="true" />
			) : face.kind === "done" ? (
				<div className="owl-island-face">
					<button
						type="button"
						className="owl-island-face-main"
						aria-expanded={open}
						aria-controls="owl-island-list"
						aria-label={spoken}
						onClick={onFaceClick}
					>
						<span className="owl-island-title" title={face.title}>
							{face.title}
						</span>
						<span className="owl-island-status">{outcomeText(face.outcome)}</span>
						{face.count > 1 && <span className="owl-island-count">{face.count}</span>}
					</button>
					{islandCanReply(face.outcome) && (
						<button type="button" className="owl-island-chip" onClick={() => beginReply(face.id)}>
							{t("island.reply")}
						</button>
					)}
					{islandBatchAckVisible(face.count) && (
						<button
							type="button"
							className="owl-island-check is-batch"
							aria-label={t("island.ackAll", { count: face.count })}
							onClick={acknowledgeAll}
						>
							✓{face.count}
						</button>
					)}
					<button
						type="button"
						className="owl-island-check"
						aria-label={t("island.ack", { title: face.title })}
						onClick={() => acknowledge(face.id)}
					>
						✓
					</button>
				</div>
			) : (
				<button
					type="button"
					className="owl-island-face"
					aria-expanded={open}
					aria-controls="owl-island-list"
					aria-label={spoken}
					onClick={onFaceClick}
				>
					{pips.length > 0 ? (
						<span className="owl-island-pips" aria-hidden="true">
							{pips.map((pip) => (
								<span key={pip.id} className={pip.lead ? "is-lead" : pip.waiting ? "is-wait" : undefined} />
							))}
						</span>
					) : (
						<span className="owl-island-dot" aria-hidden="true" />
					)}
					<span className="owl-island-title" title={face.title}>
						{face.title}
					</span>
					{shownWhisper !== "" ? (
						<span className="owl-island-whisper">{shownWhisper}</span>
					) : (
						shownStep !== "" && <span className="owl-island-step">{shownStep}</span>
					)}
					{shownClock !== "" && <span className="owl-island-clock">{shownClock}</span>}
					{waitText(face.waitKind, face.waiting) !== "" && (
						<span className="owl-island-wait">{waitText(face.waitKind, face.waiting)}</span>
					)}
					{face.count > pips.length && face.count > 1 && <span className="owl-island-count">{face.count}</span>}
				</button>
			)}
			<div className="owl-island-drawer" id="owl-island-list" aria-hidden={!open} inert={!open}>
				<div className="owl-island-drawer-inner" role="menu" aria-label={t("island.list")}>
					{rows.map((session) => {
						const permission = session.waitKind === "permission" ? permissionFor?.(session.id) : undefined;
						const choices = session.waitKind === "question" ? choicesFor?.(session.id) : undefined;
						const responseId = permission?.requestId ?? choices?.requestId;
						const responding = responseId ? feedback.get(responseId)?.phase === "pending" : false;
						return (
							<div
								key={session.id}
								className="owl-island-block"
								data-waiting={session.waiting || session.waitKind !== "" ? true : undefined}
							>
								<button
									type="button"
									role="menuitem"
									className="owl-island-row"
									onClick={() => openSession(session.id)}
								>
									<span className="owl-island-dot" aria-hidden="true" />
									<span className="owl-island-title" title={session.title}>
										{session.title}
									</span>
									{session.waitKind === "question" && session.whisper !== "" ? (
										<span className="owl-island-whisper">{session.whisper}</span>
									) : (
										stepText(session.step) !== "" && (
											<span className="owl-island-step">{stepText(session.step)}</span>
										)
									)}
									{clockText(session.startedAt) !== "" && (
										<span className="owl-island-clock">{clockText(session.startedAt)}</span>
									)}
									{waitText(session.waitKind, session.waiting) !== "" && (
										<span className="owl-island-wait">{waitText(session.waitKind, session.waiting)}</span>
									)}
								</button>
								{permission && (
									<div className="owl-island-permission">
										<strong>{permission.toolName}</strong> · {permission.contextLabel ?? session.title}
										<p>
											{copy.workspace}: {permission.workspace ?? copy.unknownWorkspace}
										</p>
										{permission.description && <pre>{permission.description}</pre>}
										<PendingResponseNotice requestId={permission.requestId} />
									</div>
								)}
								{choices && <PendingResponseNotice requestId={choices.requestId} />}
								{(permission || choices) && (
									<div className="owl-island-actions">
										{permission && onOpenPermission && (
											<button
												type="button"
												className="owl-island-chip"
												onClick={() => {
													setExpanded(false);
													onOpenPermission(permission.requestId);
												}}
											>
												{copy.details}
											</button>
										)}
										{permission && (
											<button
												type="button"
												disabled={responding}
												className="owl-island-chip"
												onClick={() => onPermission?.(permission.requestId, false)}
											>
												{t("island.deny")}
											</button>
										)}
										{permission && (
											<button
												type="button"
												disabled={responding || !permission.description}
												title={permission.description}
												className="owl-island-chip is-allow"
												onClick={() => onPermission?.(permission.requestId, true)}
											>
												{responding ? copy.sending : copy.approve}
											</button>
										)}
										{choices?.labels.map((label) => (
											<button
												key={label}
												type="button"
												disabled={responding}
												className="owl-island-chip"
												onClick={() => onChoose?.(choices.requestId, label)}
											>
												{label}
											</button>
										))}
									</div>
								)}
							</div>
						);
					})}
					{done.map((session) => (
						<div key={session.id} className="owl-island-block" data-outcome={session.outcome}>
							<div className="owl-island-row" role="none">
								<button
									type="button"
									role="menuitem"
									className="owl-island-row-main"
									onClick={() => openSession(session.id)}
								>
									<span className="owl-island-title" title={session.title}>
										{session.title}
									</span>
									<span className="owl-island-status">{outcomeText(session.outcome)}</span>
								</button>
								{islandCanReply(session.outcome) && (
									<button type="button" className="owl-island-chip" onClick={() => beginReply(session.id)}>
										{t("island.reply")}
									</button>
								)}
								<button
									type="button"
									className="owl-island-check"
									aria-label={t("island.ack", { title: session.title })}
									onClick={() => acknowledge(session.id)}
								>
									✓
								</button>
							</div>
							{replyFor === session.id && islandCanReply(session.outcome) && (
								<form
									className="owl-island-reply"
									onSubmit={(event) => {
										event.preventDefault();
										sendReply(session.id, replyDraft);
									}}
								>
									<button
										type="button"
										className="owl-island-chip"
										onClick={() => sendReply(session.id, t("island.replyContinue"))}
									>
										{t("island.replyContinue")}
									</button>
									<input
										ref={replyInput}
										value={replyDraft}
										placeholder={t("island.replyPlaceholder")}
										aria-label={t("island.reply")}
										onChange={(event) => setReplyDraft(event.target.value)}
									/>
									<button type="submit" className="owl-island-chip is-allow">
										{t("island.replySend")}
									</button>
								</form>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
