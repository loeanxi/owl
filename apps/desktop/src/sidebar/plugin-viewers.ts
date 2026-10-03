import type { BridgeClient } from "../bridge/client.ts";
import type { ViewerListResult, WorkspaceViewerInfo } from "../bridge/protocol.ts";
import { registerTab, type TabDefinition } from "./registry.ts";
import type { SidebarStore } from "./store.ts";

export const PLUGIN_VIEWER_KIND_PREFIX = "plugin-viewer:";

/** Keep the frontend's file routing in step with the active bridge plugins. */
export function attachPluginViewers(
	client: Pick<BridgeClient, "request" | "onStatus" | "onViewersChanged">,
	store: Pick<SidebarStore, "getState" | "closeTab">,
	component: TabDefinition["component"],
	icon: TabDefinition["icon"],
): () => void {
	const registered = new Map<string, { viewer: WorkspaceViewerInfo; dispose: () => void }>();
	let disposed = false;
	let revision = 0;
	const update = (viewers: WorkspaceViewerInfo[]): void => {
		const wanted = new Set(viewers.map((viewer) => viewer.id));
		for (const [id, registration] of registered) {
			if (wanted.has(id)) continue;
			registration.dispose();
			registered.delete(id);
			for (const tab of store.getState().tabs) {
				if (tab.kind === `${PLUGIN_VIEWER_KIND_PREFIX}${id}`) store.closeTab(tab.id);
			}
		}
		for (const viewer of viewers) {
			const previous = registered.get(viewer.id);
			if (previous?.viewer.title === viewer.title &&
				previous.viewer.extensions.join("\0") === viewer.extensions.join("\0")) continue;
			previous?.dispose();
			const dispose = registerTab({
				kind: `${PLUGIN_VIEWER_KIND_PREFIX}${viewer.id}`,
				title: viewer.title,
				exts: viewer.extensions,
				workspaceViewerId: viewer.id,
				component,
				icon,
			});
			registered.set(viewer.id, { viewer, dispose });
		}
	};
	const refresh = (): void => {
		const requestRevision = ++revision;
		void client.request<ViewerListResult>({ type: "viewer.list" }).then((response) => {
			if (!disposed && requestRevision === revision && response.ok && response.result) update(response.result.viewers);
		}).catch(() => {});
	};
	const offChanged = client.onViewersChanged((message) => {
		revision++;
		if (!disposed) update(message.viewers);
	});
	const offStatus = client.onStatus((connected) => { if (connected) refresh(); });
	refresh();
	return () => {
		disposed = true;
		offChanged();
		offStatus();
		for (const registration of registered.values()) registration.dispose();
		registered.clear();
	};
}
