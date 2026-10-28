import { parseScheduleDelivery } from "../features/automation/schedule-delivery.ts";

export interface SessionTitleSource {
	id?: string;
	name?: string;
	firstMessage?: string;
	parentSessionPath?: string;
}

export interface SessionActivitySource {
	modified?: string;
	timestamp?: string;
	created?: string;
}

export type SessionPeriod = "today" | "yesterday" | "earlier";

/** Display cleanup never changes the stored name, first message, or session identity. */
export function sessionDisplayTitle(
	row: SessionTitleSource,
	unnamed: string,
	branchSuffix: string,
	maxLength = 48,
): string {
	const named = row.name?.trim();
	if (named) return named;
	let text = row.firstMessage?.trim() ?? "";
	text = text.replace(/^\[Attached files for this turn\]\r?\n(?:- [^\r\n]+\r?\n)+\r?\n/, "");
	if (text.startsWith("<owl-myself-turn>")) {
		const envelope = /^<owl-myself-turn>([^\r\n]*)<\/owl-myself-turn>(?:\r?\n|$)/.exec(text);
		try {
			const metadata: unknown = envelope ? JSON.parse(envelope[1]!) : undefined;
			text =
				metadata !== null && typeof metadata === "object" && "text" in metadata && typeof metadata.text === "string"
					? metadata.text
					: "";
		} catch {
			text = "";
		}
	}
	const skill = /^<skill\b([^>]*)>([\s\S]*?)<\/skill>\s*([\s\S]*)$/i.exec(text);
	if (skill) text = skill[3]?.trim() || /\bname=["']([^"']+)["']/.exec(skill[1] ?? "")?.[1] || "";
	else if (/^<skill\b/i.test(text)) text = /\bname=["']([^"']+)["']/.exec(text)?.[1] ?? "";
	const delivery = parseScheduleDelivery(text.replace(/\r\n/g, "\n"));
	if (delivery) text = delivery.name || delivery.prompt;
	else text = text.replace(/^〔owl-schedule:[^〕]*〕\s*/, "");
	text = text.replace(/\s+/g, " ").trim();
	if (/^(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])[^<>\r\n]*$/i.test(text)) {
		text =
			text
				.replace(/[\\/]+$/, "")
				.split(/[\\/]/)
				.at(-1) ?? "";
		if (/^[a-z]:$/i.test(text)) text = "";
	}
	const historyFile =
		/^(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl(?:\s+(.+))?$/i.exec(
			text,
		);
	if (historyFile) text = historyFile[2]?.trim() || `${unnamed} · ${historyFile[1]}`;
	if (/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,64})(?:\.jsonl?)?$/i.test(text))
		text = "";
	const title = text ? (text.length > maxLength ? `${text.slice(0, maxLength)}…` : text) : unnamed;
	return row.parentSessionPath ? `${title} · ${branchSuffix}` : title;
}

/** Use local calendar boundaries, including 23/25-hour days around daylight saving. */
export function groupSessionsByPeriod<T extends SessionActivitySource>(
	rows: readonly T[],
	now = Date.now(),
): Array<{ period: SessionPeriod; rows: T[] }> {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	const groups: Record<SessionPeriod, T[]> = { today: [], yesterday: [], earlier: [] };
	for (const row of rows) {
		const time = Date.parse(row.modified ?? row.timestamp ?? row.created ?? "");
		const period = time >= today.getTime() ? "today" : time >= yesterday.getTime() ? "yesterday" : "earlier";
		groups[period].push(row);
	}
	return (["today", "yesterday", "earlier"] as const)
		.filter((period) => groups[period].length > 0)
		.map((period) => ({ period, rows: groups[period] }));
}
