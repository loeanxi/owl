import type { SourceUpdateCheck } from "../bridge/native.ts";
import type { TextKey } from "../i18n/index.ts";

export type UpdateNotice = {
	tone: "info" | "success" | "warning" | "error";
	key: TextKey;
	vars?: Record<string, string | number>;
};

export function describeSourceUpdate(result: SourceUpdateCheck): UpdateNotice {
	const shared = {
		version: result.appVersion,
		local: result.localCommit,
		remote: result.remoteCommit,
		upstream: result.upstream,
	};
	switch (result.status) {
		case "upToDate":
			return { tone: "success", key: "rail.updateCurrent", vars: shared };
		case "updateAvailable":
			return { tone: "warning", key: "rail.updateAvailable", vars: { ...shared, behind: result.behind } };
		case "localAhead":
			return { tone: "info", key: "rail.updateLocalAhead", vars: { ...shared, ahead: result.ahead } };
		case "diverged":
			return { tone: "warning", key: "rail.updateDiverged", vars: { ...shared, behind: result.behind, ahead: result.ahead } };
	}
}

export function readableUpdateError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	if (typeof error === "string" && error.trim()) return error.trim();
	return String(error || "unknown");
}
