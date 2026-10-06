import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import {
	dismissFinished,
	formatRunClock,
	islandCanReply,
	islandCompactAction,
	islandFace,
	islandJumpTarget,
	islandPips,
	orderedRunning,
	rememberFinished,
	visibleFinished,
	type IslandOutcome,
	type IslandSession,
} from "./dynamic-island-model.ts";

export interface DynamicIslandProps {
	running: readonly IslandSession[];
	/** 一段会话结束时递增 seq。同一 seq 只记一次。 */
	notice: { seq: number; id: string; outcome: IslandOutcome } | null;
	titleOf: (sessionId: string) => string;
	onOpen: (sessionId: string) => void;
	permissionFor?: (sessionId: string) => { requestId: string } | undefined;
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
export function DynamicIsland({ running, notice, titleOf, onOpen, jumpToFace, permissionFor, choicesFor, onPermission, onChoose, onReply }: DynamicIslandProps): React.JSX.Element {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	const seenNotice = useRef<number | null>(null);
	const [finished, setFinished] = useState<readonly { id: string; at: number; outcome: IslandOutcome }[]>([]);
	const [landing, setLanding] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [replyFor, setReplyFor] = useState<string | null>(null);
	const [replyDraft, setReplyDraft] = useState("");
	const replyInput = useRef<HTMLInputElement>(null);
	const [layout, setLayout] = useState<IslandLayout>({ center: 0, max: 360, ready: false });

	useEffect(() => {
		if (!notice || seenNotice.current === notice.seq) return;
		seenNotice.current = notice.seq;
		setFinished((current) => rememberFinished(current, notice.id, Date.now(), notice.outcome));
		setLanding(true);
		const timer = window.setTimeout(() => setLanding(false), 720);
		return () => window.clearTimeout(timer);
	}, [notice]);

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (running.length === 0) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [running.length]);

	const done = visibleFinished(running, finished.map((item) => ({ id: item.id, title: titleOf(item.id), finishedAt: item.at, outcome: item.outcome })));
	const face = islandFace(running, done);
	const action = islandCompactAction(face);
	const rows = orderedRunning(running);
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
				const rightLimit = Math.round(Math.min(col.right, controls ? controls.left - 8 : barBox.right) - barBox.left);
				const half = Math.max(75, Math.min(center - leftLimit, rightLimit - center));
				const max = Math.max(150, Math.floor(half * 2));
				setLayout((current) => {
					if (current.ready && Math.abs(current.center - center) < 1 && Math.abs(current.max - max) < 1) return current;
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

	const stepText = (step: string): string => step === "thinking" ? t("island.stepThinking") : step === "writing" ? t("island.stepWriting") : step;
	const waitText = (kind: IslandSession["waitKind"], waiting: boolean): string => kind === "permission" ? t("island.waitingPermission") : kind === "question" ? t("island.waitingQuestion") : waiting ? t("island.waiting") : "";
	const clockText = (startedAt: number): string => startedAt > 0 ? formatRunClock(startedAt, now) : "";
	const shown = face.kind === "live" ? rows.find((session) => session.id === face.id) : undefined;
	const shownStep = shown ? stepText(shown.step) : "";
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

	const label = face.kind === "live"
		? face.waitKind === "permission"
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
	const spoken = face.kind === "live" && (shownWhisper !== "" || shownStep !== "" || shownClock !== "")
		? `${label}，${[shownWhisper, shownWhisper === "" ? shownStep : "", shownClock].filter((part) => part !== "").join("，")}`
		: label;

	const openSession = (id: string): void => {
		setExpanded(false);
		onOpen(id);
	};

	const acknowledge = (id: string): void => {
		setFinished((current) => dismissFinished(current, id));
		if (replyFor === id) setReplyFor(null);
	};

	const outcomeText = (outcome: IslandOutcome): string => outcome === "aborted" ? t("island.aborted") : outcome === "error" ? t("island.failed") : t("island.done");

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
			style={{ left: layout.center, ["--owl-island-max" as string]: `${layout.max}px`, visibility: layout.ready ? "visible" : "hidden" }}
			data-tauri-drag-region="false"
		>
			{face.kind === "idle" ? (
				<div className="owl-island-face" aria-hidden="true" />
			) : face.kind === "done" ? (
				<div className="owl-island-face">
					<button type="button" className="owl-island-face-main" aria-expanded={open} aria-controls="owl-island-list" aria-label={spoken} onClick={onFaceClick}>
						<span className="owl-island-title" title={face.title}>{face.title}</span>
						<span className="owl-island-status">{outcomeText(face.outcome)}</span>
						{face.count > 1 && <span className="owl-island-count">{face.count}</span>}
					</button>
					{islandCanReply(face.outcome) && <button type="button" className="owl-island-chip" onClick={() => beginReply(face.id)}>{t("island.reply")}</button>}
					<button type="button" className="owl-island-check" aria-label={t("island.ack", { title: face.title })} onClick={() => acknowledge(face.id)}>✓</button>
				</div>
			) : (
				<button type="button" className="owl-island-face" aria-expanded={open} aria-controls="owl-island-list" aria-label={spoken} onClick={onFaceClick}>
					{pips.length > 0 ? (
						<span className="owl-island-pips" aria-hidden="true">
							{pips.map((pip) => <span key={pip.id} className={pip.lead ? "is-lead" : pip.waiting ? "is-wait" : undefined} />)}
						</span>
					) : <span className="owl-island-dot" aria-hidden="true" />}
					<span className="owl-island-title" title={face.title}>{face.title}</span>
					{shownWhisper !== "" ? <span className="owl-island-whisper">{shownWhisper}</span> : shownStep !== "" && <span className="owl-island-step">{shownStep}</span>}
					{shownClock !== "" && <span className="owl-island-clock">{shownClock}</span>}
					{waitText(face.waitKind, face.waiting) !== "" && <span className="owl-island-wait">{waitText(face.waitKind, face.waiting)}</span>}
					{face.count > pips.length && face.count > 1 && <span className="owl-island-count">{face.count}</span>}
				</button>
			)}
			<div className="owl-island-drawer" id="owl-island-list" aria-hidden={!open} inert={!open}>
				<div className="owl-island-drawer-inner" role="menu" aria-label={t("island.list")}>
					{rows.map((session) => {
						const permission = session.waitKind === "permission" ? permissionFor?.(session.id) : undefined;
						const choices = session.waitKind === "question" ? choicesFor?.(session.id) : undefined;
						return (
							<div key={session.id} className="owl-island-block">
								<button
									type="button"
									role="menuitem"
									className="owl-island-row"
									onClick={() => openSession(session.id)}
								>
									<span className="owl-island-dot" aria-hidden="true" />
									<span className="owl-island-title" title={session.title}>{session.title}</span>
									{session.waitKind === "question" && session.whisper !== "" ? <span className="owl-island-whisper">{session.whisper}</span> : stepText(session.step) !== "" && <span className="owl-island-step">{stepText(session.step)}</span>}
									{clockText(session.startedAt) !== "" && <span className="owl-island-clock">{clockText(session.startedAt)}</span>}
									{waitText(session.waitKind, session.waiting) !== "" && <span className="owl-island-wait">{waitText(session.waitKind, session.waiting)}</span>}
								</button>
								{(permission || choices) && (
									<div className="owl-island-actions">
										{permission && <button type="button" className="owl-island-chip" onClick={() => onPermission?.(permission.requestId, false)}>{t("island.deny")}</button>}
										{permission && <button type="button" className="owl-island-chip is-allow" onClick={() => onPermission?.(permission.requestId, true)}>{t("island.allow")}</button>}
										{choices?.labels.map((label) => <button key={label} type="button" className="owl-island-chip" onClick={() => onChoose?.(choices.requestId, label)}>{label}</button>)}
									</div>
								)}
							</div>
						);
					})}
					{done.map((session) => (
						<div key={session.id} className="owl-island-block">
							<div className="owl-island-row" role="none">
								<button type="button" role="menuitem" className="owl-island-row-main" onClick={() => openSession(session.id)}>
									<span className="owl-island-title" title={session.title}>{session.title}</span>
									<span className="owl-island-status">{outcomeText(session.outcome)}</span>
								</button>
								{islandCanReply(session.outcome) && <button type="button" className="owl-island-chip" onClick={() => beginReply(session.id)}>{t("island.reply")}</button>}
								<button type="button" className="owl-island-check" aria-label={t("island.ack", { title: session.title })} onClick={() => acknowledge(session.id)}>✓</button>
							</div>
							{replyFor === session.id && islandCanReply(session.outcome) && (
								<form className="owl-island-reply" onSubmit={(event) => { event.preventDefault(); sendReply(session.id, replyDraft); }}>
									<button type="button" className="owl-island-chip" onClick={() => sendReply(session.id, t("island.replyContinue"))}>{t("island.replyContinue")}</button>
									<input ref={replyInput} value={replyDraft} placeholder={t("island.replyPlaceholder")} aria-label={t("island.reply")} onChange={(event) => setReplyDraft(event.target.value)} />
									<button type="submit" className="owl-island-chip is-allow">{t("island.replySend")}</button>
								</form>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
