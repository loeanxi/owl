import type { SessionManager } from "../../core/session-manager.ts";
import type { ApprovalMode } from "./protocol.ts";

const APPROVAL_ENTRY = "owl-desktop-approval";

export function sessionApprovalMode(manager: SessionManager): ApprovalMode | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			entry.type !== "custom" ||
			entry.customType !== APPROVAL_ENTRY ||
			!entry.data ||
			typeof entry.data !== "object" ||
			!("mode" in entry.data)
		)
			continue;
		const mode = entry.data.mode;
		if (mode === "auto" || mode === "confirm" || mode === "plan") return mode;
	}
	return undefined;
}

export function saveSessionApprovalMode(manager: SessionManager, mode: ApprovalMode): void {
	if (sessionApprovalMode(manager) !== mode) manager.appendCustomEntry(APPROVAL_ENTRY, { mode });
}
