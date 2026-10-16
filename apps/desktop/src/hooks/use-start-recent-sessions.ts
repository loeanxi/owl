import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { sessionDisplayTitle, type SessionTitleSource } from "../components/session-list-presentation.ts";
import { matchesSessionScope } from "../components/sidebar-scope.ts";
import { useT } from "../i18n/index.ts";
import { samePath } from "../utils/paths.ts";

export type StartRecentSession = { id: string; title: string; time?: string };
export type StartRecentSessionRow = SessionTitleSource & {
	cwd?: string;
	scope?: unknown;
	archivedAt?: unknown;
	modified?: string;
	created?: string;
	messageCount?: number;
};

/** The home page only resumes populated ordinary conversations in the current project. */
export function selectStartRecentSessions(rows: readonly StartRecentSessionRow[], cwd: string, unnamed: string, branchSuffix: string): StartRecentSession[] {
	if (!cwd.trim()) return [];
	return rows
		.filter((row): row is StartRecentSessionRow & { id: string } => Boolean(
			row.id?.trim() && samePath(row.cwd, cwd) && matchesSessionScope(row, "chat")
			&& !row.archivedAt && row.messageCount !== 0
			&& ((row.messageCount ?? 0) > 0 || row.firstMessage?.trim() || row.name?.trim()),
		))
		.sort((a, b) => String(b.modified ?? b.created ?? "").localeCompare(String(a.modified ?? a.created ?? "")))
		.slice(0, 3)
		.map((row) => ({
			id: row.id,
			title: sessionDisplayTitle(row, unnamed, branchSuffix),
			time: row.modified ?? row.created,
		}));
}

/** Read-only home data; ownership changes hide cached results before the next effect runs. */
export function useStartRecentSessions(client: BridgeClient, { active, connected, profile, cwd, revision }: {
	active: boolean;
	connected: boolean;
	profile?: string;
	cwd: string;
	revision: number;
}): readonly StartRecentSession[] {
	const t = useT();
	const [snapshot, setSnapshot] = useState<{ client: BridgeClient; profile: string; cwd: string; rows: StartRecentSessionRow[] }>();
	const enabled = active && connected && Boolean(profile?.trim()) && Boolean(cwd.trim());
	useEffect(() => {
		if (!enabled || !profile) return;
		let disposed = false;
		setSnapshot(undefined);
		void client.request<StartRecentSessionRow[]>({ type: "session.list", scope: "chat" }).then((response) => {
			if (!disposed && response.ok) setSnapshot({ client, profile, cwd, rows: response.result ?? [] });
		}).catch(() => {});
		return () => { disposed = true; };
	}, [client, enabled, profile, cwd, revision]);
	if (!enabled || !snapshot || snapshot.client !== client || snapshot.profile !== profile || !samePath(snapshot.cwd, cwd)) return [];
	return selectStartRecentSessions(snapshot.rows, cwd, t("sidebar.sessionUnnamed"), t("app.branchSuffix"));
}
