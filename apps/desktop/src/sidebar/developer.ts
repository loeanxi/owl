import type { SidebarStore } from "./store.ts";
import { t } from "../i18n/index.ts";

/**
 * Opens a developer layout in the tools workbench without replacing tabs or
 * sessions. Terminal is not part of the preset: it lives in the dedicated
 * bottom dock (App opens that panel alongside).
 */
export function openDeveloperWorkbench(
	store: Pick<SidebarStore, "getState" | "openSingleton" | "openNew" | "activate">,
	isEnabled: (kind: string) => boolean,
): boolean {
	const kinds = ["files", "changes"].filter(isEnabled);
	if (kinds.length === 0) return false;
	for (const kind of kinds) store.openSingleton(kind, kind === "files" ? t("dev.files") : t("dev.changes"));
	const first = store.getState().tabs.find((tab) => tab.kind === kinds[0]);
	if (first) store.activate(first.id);
	return true;
}
