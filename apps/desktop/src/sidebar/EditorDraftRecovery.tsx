import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { EditorDraftSummary } from "../bridge/protocol.ts";
import { getUiLanguage, useT } from "../i18n/index.ts";
import { type EditorLocalDraftSummary, listEditorLocalDrafts } from "./editor-local-drafts.ts";
import { type SidebarStore, useSidebarState } from "./store.ts";
import "./editor-safety.css";

export function EditorDraftRecovery({
	client,
	cwd,
	profile,
	connected,
	store,
	onOpen,
	enabled = true,
}: {
	client: BridgeClient;
	cwd: string;
	profile?: string;
	connected: boolean;
	store: SidebarStore;
	onOpen: () => void;
	enabled?: boolean;
}): React.JSX.Element | null {
	useT();
	const en = getUiLanguage() === "en";
	const state = useSidebarState(store);
	const opened = state.tabs
		.filter((tab) => tab.kind === "editor")
		.map((tab) => tab.path ?? "")
		.sort()
		.join("\0");
	const owner = JSON.stringify([profile, cwd]);
	const [result, setResult] = useState<{
		owner: string;
		drafts: EditorDraftSummary[];
		local: EditorLocalDraftSummary[];
		error?: string;
		localError?: string;
	}>();
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!profile) return;
		let active = true;
		let local: EditorLocalDraftSummary[] = [];
		let localError: string | undefined;
		try {
			local = listEditorLocalDrafts(localStorage, profile, cwd);
		} catch (error) {
			localError = error instanceof Error ? error.message : String(error);
		}
		setResult((previous) => ({ owner, drafts: previous?.owner === owner ? previous.drafts : [], local, localError }));
		if (!connected) return;
		void client
			.request<{ drafts: EditorDraftSummary[] }>({ type: "editor.draft.list", cwd, expectedProfile: profile })
			.then((response) => {
				if (!active) return;
				if (!response.ok) throw new Error(response.error ?? (en ? "Could not load drafts" : "无法读取草稿"));
				// The host scopes this request by canonical cwd; a junction alias may differ lexically.
				setResult({ owner, drafts: response.result?.drafts ?? [], local, localError });
			})
			.catch((error: unknown) => {
				if (active)
					setResult({
						owner,
						drafts: [],
						local,
						localError,
						error: error instanceof Error ? error.message : String(error),
					});
			});
		return () => {
			active = false;
		};
	}, [client, cwd, profile, connected, opened, revision, owner, en]);
	useEffect(() => {
		const changed = (event: StorageEvent): void => {
			if (event.key?.startsWith("owl.editor.wal.")) setRevision((value) => value + 1);
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, []);
	if (!profile || result?.owner !== owner) return null;
	const candidates = new Map<string, number>();
	for (const draft of result.drafts) candidates.set(draft.path, 0);
	for (const draft of result.local) candidates.set(draft.path, (candidates.get(draft.path) ?? 0) + 1);
	const drafts = [...candidates].filter(
		([path]) => !state.tabs.some((tab) => tab.kind === "editor" && tab.path === path),
	);
	if (!drafts.length && !result.error && !result.localError) return null;
	return (
		<section className="owl-editor-draft-recovery" aria-label={en ? "Recoverable drafts" : "可恢复的草稿"}>
			<div>
				<strong>
					{en ? "Recoverable drafts" : "可恢复的草稿"} · {drafts.length}
				</strong>
				<button type="button" onClick={() => setRevision((value) => value + 1)}>
					{en ? "Refresh" : "刷新"}
				</button>
			</div>
			{result.error && (
				<p className="owl-editor-safety-error" role="alert">
					{result.error}
				</p>
			)}
			{result.localError && (
				<p className="owl-editor-safety-error" role="alert">
					{en ? "Local backups could not be listed" : "无法列出本机备份"}: {result.localError}
				</p>
			)}
			{drafts.map(([path, localCount]) => (
				<button
					key={path}
					type="button"
					disabled={!enabled || (!connected && localCount === 0)}
					title={
						!enabled ? (en ? "Enable the code editor to recover this draft" : "启用代码编辑器后可恢复草稿") : path
					}
					onClick={() => {
						store.openFileTab("editor", path, path.split("/").at(-1) ?? path);
						onOpen();
					}}
				>
					{en ? "Open draft" : "打开草稿"} · {path}
					{localCount > 0 && <span> · {en ? `${localCount} local backups` : `${localCount} 份本机备份`}</span>}
				</button>
			))}
		</section>
	);
}
