import type { FinishedMark, IslandOutcome, IslandSession } from "./dynamic-island-model.ts";

const MEMORY_KEY = "owl.dynamic-island.v1";

export type IslandMemoryScope = "all" | "chat" | "research";

export interface IslandMemorySnapshot {
	version: 1;
	running: readonly IslandSession[];
	finished: readonly FinishedMark[];
	expanded: boolean;
	replyFor: string | null;
	replyDraft: string;
}

export function emptyIslandMemory(): IslandMemorySnapshot {
	return { version: 1, running: [], finished: [], expanded: false, replyFor: null, replyDraft: "" };
}

/** 目录是本地身份；chat / research 可以分开存，顶栏同时显示两类时用 all。 */
export function islandMemoryKey(profile: string, scope: IslandMemoryScope = "all"): string {
	const normalized = profile.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return `${MEMORY_KEY}:${encodeURIComponent(normalized)}:${scope}`;
}

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function outcome(value: unknown): value is IslandOutcome {
	return value === "done" || value === "aborted" || value === "error";
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function parseIslandMemory(value: unknown): IslandMemorySnapshot | null {
	const source = object(value);
	if (!source || source.version !== 1 || !Array.isArray(source.running) || !Array.isArray(source.finished))
		return null;
	const running = new Map<string, IslandSession>();
	for (const value of source.running) {
		const row = object(value);
		if (
			!row ||
			typeof row.id !== "string" ||
			!row.id.trim() ||
			row.id.length > 512 ||
			!timestamp(row.startedAt) ||
			!timestamp(row.lastActivityAt)
		)
			continue;
		const waitKind = row.waitKind === "permission" || row.waitKind === "question" ? row.waitKind : "";
		running.set(row.id, {
			id: row.id,
			title: text(row.title) || row.id,
			startedAt: row.startedAt,
			lastActivityAt: row.lastActivityAt,
			step: text(row.step),
			waiting: row.waiting === true || waitKind !== "",
			waitKind,
			whisper: text(row.whisper),
		});
	}
	const finished = new Map<string, FinishedMark>();
	for (const value of source.finished) {
		const row = object(value);
		if (
			!row ||
			typeof row.id !== "string" ||
			!row.id.trim() ||
			row.id.length > 512 ||
			!timestamp(row.finishedAt) ||
			!outcome(row.outcome)
		)
			continue;
		finished.set(row.id, {
			id: row.id,
			title: text(row.title) || row.id,
			finishedAt: row.finishedAt,
			outcome: row.outcome,
		});
	}
	const replyFor =
		typeof source.replyFor === "string" && finished.get(source.replyFor)?.outcome === "done" ? source.replyFor : null;
	return {
		version: 1,
		running: [...running.values()],
		finished: [...finished.values()],
		expanded: source.expanded === true && (running.size > 0 || finished.size > 0),
		replyFor,
		replyDraft: replyFor ? text(source.replyDraft) : "",
	};
}

export function loadIslandMemory(
	storage: Pick<Storage, "getItem">,
	profile: string,
	scope: IslandMemoryScope = "all",
): IslandMemorySnapshot | null {
	if (!profile.trim()) return null;
	try {
		const saved = storage.getItem(islandMemoryKey(profile, scope));
		return saved ? parseIslandMemory(JSON.parse(saved)) : null;
	} catch {
		return null;
	}
}

export function saveIslandMemory(
	storage: Pick<Storage, "setItem">,
	profile: string,
	memory: IslandMemorySnapshot,
	scope: IslandMemoryScope = "all",
): boolean {
	if (!profile.trim()) return false;
	try {
		storage.setItem(islandMemoryKey(profile, scope), JSON.stringify(memory));
		return true;
	} catch {
		return false;
	}
}

/** settings.get 确认身份前收到的通知留在内存，确认后并入该身份的缓存。 */
export function mergeIslandMemory(saved: IslandMemorySnapshot, pending: IslandMemorySnapshot): IslandMemorySnapshot {
	const running = new Map(saved.running.map((session) => [session.id, session]));
	for (const session of pending.running) {
		const previous = running.get(session.id);
		running.set(
			session.id,
			session.startedAt > 0 || !previous ? session : { ...session, startedAt: previous.startedAt },
		);
	}
	const finished = new Map(saved.finished.map((session) => [session.id, session]));
	for (const session of pending.finished) {
		if ((finished.get(session.id)?.finishedAt ?? -1) <= session.finishedAt) finished.set(session.id, session);
		const live = running.get(session.id);
		if (live && live.startedAt <= session.finishedAt) running.delete(session.id);
	}
	const replyFor = pending.replyFor ?? saved.replyFor;
	return {
		...saved,
		running: [...running.values()],
		finished: [...finished.values()],
		expanded: saved.expanded || pending.expanded,
		replyFor,
		replyDraft: pending.replyFor ? pending.replyDraft : saved.replyDraft,
	};
}

/** 短断线先保留缓存，只有后端完成恢复并确认运行清单后才能撤下旧任务。 */
export function reconcileIslandMemory(
	memory: IslandMemorySnapshot,
	live: readonly IslandSession[],
	runningReady: boolean,
	now: number,
	titles?: ReadonlyMap<string, string>,
): IslandMemorySnapshot {
	const previous = new Map(memory.running.map((session) => [session.id, session]));
	const running = live.map((session) => {
		const saved = previous.get(session.id);
		if (!saved) return session;
		const sameRun = session.startedAt === 0 || session.startedAt === saved.startedAt;
		return {
			...session,
			title: titles?.get(session.id) || session.title || saved.title,
			startedAt: session.startedAt || saved.startedAt,
			lastActivityAt: session.lastActivityAt || saved.lastActivityAt,
			step: sameRun ? session.step || saved.step : session.step,
		};
	});
	const liveIds = new Set(live.map((session) => session.id));
	let finished = memory.finished
		.filter((session) => !liveIds.has(session.id))
		.map((session) => ({ ...session, title: titles?.get(session.id) || session.title }));
	for (const saved of previous.values()) {
		if (liveIds.has(saved.id)) continue;
		if (!runningReady) running.push(saved);
		else if (!finished.some((session) => session.id === saved.id)) {
			finished = [
				...finished,
				{ id: saved.id, title: titles?.get(saved.id) || saved.title, finishedAt: now, outcome: "aborted" },
			];
		}
	}
	const replyFor = finished.some((session) => session.id === memory.replyFor && session.outcome === "done")
		? memory.replyFor
		: null;
	const next: IslandMemorySnapshot = {
		...memory,
		running,
		finished,
		expanded: memory.expanded && (running.length > 0 || finished.length > 0),
		replyFor,
		replyDraft: replyFor ? memory.replyDraft : "",
	};
	return JSON.stringify(next) === JSON.stringify(memory) ? memory : next;
}

export function rememberIslandCompletion(
	memory: IslandMemorySnapshot,
	id: string,
	title: string,
	at: number,
	result: IslandOutcome,
): IslandMemorySnapshot {
	return {
		...memory,
		running: memory.running.filter((session) => session.id !== id),
		finished: [
			...memory.finished.filter((session) => session.id !== id),
			{ id, title, finishedAt: at, outcome: result },
		],
	};
}
