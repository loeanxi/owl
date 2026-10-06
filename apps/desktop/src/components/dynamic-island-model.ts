/** 顶栏灵动岛的纯状态：收起时写谁、已完成留到打勾、点一下做什么。 */

export interface IslandSession {
	id: string;
	title: string;
	/** 最近一次有动静的时间戳。越大越优先占胶囊。 */
	lastActivityAt: number;
	/** 这一轮开始的时间戳，用来显示已经跑了多久。 */
	startedAt: number;
	/** thinking / writing / 工具名。空字符串表示还没有步骤。 */
	step: string;
	waiting: boolean;
	/** 等你的原因。批权限优先于回答问题。 */
	waitKind: "" | "permission" | "question";
	/** 提问时贴在胶囊上的短句。已经裁过。 */
	whisper: string;
}

export type IslandOutcome = "done" | "aborted" | "error";

export interface FinishedMark {
	id: string;
	title: string;
	finishedAt: number;
	outcome: IslandOutcome;
}

export type IslandFace =
	| { kind: "idle" }
	| { kind: "done"; id: string; title: string; count: number; outcome: IslandOutcome }
	| { kind: "live"; id: string; title: string; waiting: boolean; waitKind: IslandSession["waitKind"]; count: number };

function attentionRank(session: IslandSession): number {
	if (session.waitKind === "permission") return 0;
	if (session.waitKind === "question" || session.waiting) return 1;
	return 2;
}

export function orderedRunning(running: readonly IslandSession[]): IslandSession[] {
	return [...running].sort((a, b) => {
		const rank = attentionRank(a) - attentionRank(b);
		if (rank !== 0) return rank;
		return b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id);
	});
}

export interface IslandPip {
	id: string;
	/** 胶囊上写着的那一段。 */
	lead: boolean;
	waiting: boolean;
}

/** 两段以上同时在跑时，胶囊左边排一串小灯。最多四盏，多出来的仍用数字。 */
export function islandPips(running: readonly IslandSession[], limit = 4): IslandPip[] {
	const ordered = orderedRunning(running);
	if (ordered.length < 2) return [];
	return ordered.slice(0, limit).map((session, index) => ({
		id: session.id,
		lead: index === 0,
		waiting: session.waiting || session.waitKind !== "",
	}));
}

/** 只有正常做完才能在岛上接着说。中止和失败要先看对话。 */
export function islandCanReply(outcome: IslandOutcome): boolean {
	return outcome === "done";
}

/** 岛上能直接点的提问选项：只有一道单选题，而且选项不超过四个。 */
export function islandQuestionChoices(input: { count: number; multi: boolean; labels: readonly string[] }): string[] {
	if (input.count !== 1 || input.multi) return [];
	const labels = input.labels.map((label) => label.trim()).filter((label) => label !== "");
	return labels.length > 0 && labels.length <= 4 ? labels : [];
}

/** 提问原文收成胶囊能放下的一句。 */
export function islandWhisper(text: string, limit = 18): string {
	const flat = text.trim().replace(/\s+/g, " ");
	if (!flat) return "";
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 跑了多久。一小时以内是 m:ss，再长加上小时。 */
export function formatRunClock(startedAt: number, now: number): string {
	const total = Math.max(0, Math.floor((now - startedAt) / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const clock = `${minutes}:${String(seconds).padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : clock;
}

/** 还没打勾的已完成会话。正在跑的不再算完成。 */
export function visibleFinished(running: readonly { id: string }[], finished: readonly FinishedMark[]): FinishedMark[] {
	const runningIds = new Set(running.map((session) => session.id));
	return finished
		.filter((item) => !runningIds.has(item.id))
		.sort((a, b) => b.finishedAt - a.finishedAt || a.id.localeCompare(b.id));
}

/** 有会话在跑时胶囊写最近还在产出的那段。没有在跑时，停在最近一条还没打勾的已完成上。 */
export function islandFace(running: readonly IslandSession[], finished: readonly FinishedMark[]): IslandFace {
	const latest = orderedRunning(running)[0];
	if (latest) return { kind: "live", id: latest.id, title: latest.title, waiting: latest.waiting || latest.waitKind !== "", waitKind: latest.waitKind, count: running.length };
	const done = visibleFinished(running, finished);
	const top = done[0];
	if (!top) return { kind: "idle" };
	return { kind: "done", id: top.id, title: top.title, count: done.length, outcome: top.outcome };
}

/** 快捷键要打开的那一段：胶囊上写着谁，就去谁那里。空闲没有目标。 */
export function islandJumpTarget(face: IslandFace): string | null {
	return face.kind === "idle" ? null : face.id;
}

export type IslandAction = { type: "none" } | { type: "toggle" } | { type: "open"; id: string };

/** 点胶囊。空闲没反应；只剩一段已完成时打开它；否则展开列表。 */
export function islandCompactAction(face: IslandFace): IslandAction {
	if (face.kind === "idle") return { type: "none" };
	if (face.kind === "done" && face.count === 1) return { type: "open", id: face.id };
	return { type: "toggle" };
}

export function rememberFinished(
	items: readonly { id: string; at: number; outcome: IslandOutcome }[],
	id: string,
	at: number,
	outcome: IslandOutcome = "done",
): { id: string; at: number; outcome: IslandOutcome }[] {
	return [...items.filter((item) => item.id !== id), { id, at, outcome }];
}

/** 用户打勾后，把这段已完成从岛上拿掉。不在列表里则原样返回。 */
export function dismissFinished<T extends { id: string }>(items: readonly T[], id: string): readonly T[] {
	if (!items.some((item) => item.id === id)) return items;
	return items.filter((item) => item.id !== id);
}

/** 与侧边栏同一套显示名：自定义名 > 首条用户消息 > 回退文案。 */
export function islandSessionTitle(
	row: { id?: string; name?: string; firstMessage?: string; parentSessionPath?: string },
	text: { unnamed: string; branch: string; fallback: string },
): string {
	const named = row.name?.trim();
	if (named) return named;
	const first = row.firstMessage?.trim().replace(/\s+/g, " ");
	const base = first ? (first.length > 48 ? `${first.slice(0, 48)}…` : first) : row.id ? text.fallback : text.unnamed;
	return row.parentSessionPath ? `${base} · ${text.branch}` : base;
}
