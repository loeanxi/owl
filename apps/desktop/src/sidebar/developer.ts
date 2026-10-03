import type { SidebarStore } from "./store.ts";

/** Opens a developer layout in the existing workbench without replacing tabs or sessions. */
export function openDeveloperWorkbench(
	store: Pick<SidebarStore, "getState" | "openSingleton" | "openNew" | "activate">,
	isEnabled: (kind: string) => boolean,
): boolean {
	const kinds = ["files", "changes", "terminal"].filter(isEnabled);
	if (kinds.length === 0) return false;
	for (const kind of kinds) {
		if (kind === "terminal") {
			const terminal = store.getState().tabs.find((tab) => tab.kind === "terminal");
			if (terminal) store.activate(terminal.id);
			else store.openNew("terminal", "终端");
		} else store.openSingleton(kind, kind === "files" ? "文件" : "文件变动");
	}
	const first = store.getState().tabs.find((tab) => tab.kind === kinds[0]);
	if (first) store.activate(first.id);
	return true;
}
