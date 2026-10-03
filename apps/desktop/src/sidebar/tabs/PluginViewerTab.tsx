import { useEffect, useState } from "react";
import { t, useT } from "../../i18n/index.ts";
import { isWorkspaceViewerUrl } from "../../../../../packages/coding-agent/src/core/workspace-viewer-url.ts";
import type { WorkspaceViewerOpenResult } from "../../bridge/protocol.ts";
import { getTabDefinition, type TabComponentProps } from "../registry.ts";
import "./plugin-viewer.css";

/** The plugin's isolated local app owns its document editor and binary resources. */
export function PluginViewerTab({ client, cwd, tab }: TabComponentProps): React.JSX.Element {
	const t = useT();
	const viewerId = getTabDefinition(tab.kind)?.workspaceViewerId;
	const path = tab.path ?? "";
	const [viewer, setViewer] = useState<WorkspaceViewerOpenResult>();
	const [error, setError] = useState<string>();
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		const offStatus = client.onStatus((connected) => { if (connected) setRevision((value) => value + 1); });
		const offViewers = client.onViewersChanged((message) => {
			if (message.viewers.some((definition) => definition.id === viewerId)) setRevision((value) => value + 1);
		});
		return () => { offStatus(); offViewers(); };
	}, [client, viewerId]);
	useEffect(() => {
		let cancelled = false;
		setViewer(undefined);
		setError(undefined);
		if (!viewerId || !path) { setError(t("pviewer.unavailable")); return; }
		void client.request<WorkspaceViewerOpenResult>({ type: "viewer.open", viewerId, cwd, path }).then((response) => {
			if (cancelled) return;
			if (!response.ok || !response.result) throw new Error(response.error ?? t("pviewer.openFailed"));
			if (!isWorkspaceViewerUrl(response.result.url) || new URL(response.result.url).origin === window.location.origin) {
				throw new Error(t("pviewer.noLocalUrl"));
			}
			setViewer(response.result);
		}).catch((failure: unknown) => {
			if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
		});
		return () => { cancelled = true; };
	}, [client, cwd, path, viewerId, revision]);
	return (
		<div className="owl-plugin-viewer">
			<div className="owl-plugin-viewer-toolbar">
				<span title={path}>{viewer?.title ?? tab.title}</span>
				<button type="button" onClick={() => setRevision((value) => value + 1)}>{t("common.refresh")}</button>
			</div>
			{error && <p role="alert" className="owl-plugin-viewer-message">{error}</p>}
			{!viewer && !error && <p role="status" className="owl-plugin-viewer-message">{t("pviewer.opening")}</p>}
			{viewer && <iframe title={viewer.title ?? tab.title} src={viewer.url} sandbox="allow-scripts allow-same-origin allow-downloads" referrerPolicy="no-referrer" />}
		</div>
	);
}
