import { isReadOnlyDesktopTool } from "./browser-permissions.ts";
import type { ApprovalMode, DesktopApprovalEvent, DesktopServerMessage, PermissionRequestMessage } from "./protocol.ts";

type ResolutionReason = "response" | "mode-change" | "cancelled";
type PendingPermission = { message: PermissionRequestMessage; resolve: (approved: boolean) => void };

/** Shared approvals: one decision must retire the request on every connected UI. */
export class DesktopPermissionQueue {
	private readonly pending = new Map<string, PendingPermission>();
	private readonly broadcast: (message: DesktopServerMessage) => void;

	constructor(broadcast: (message: DesktopServerMessage) => void) {
		this.broadcast = broadcast;
	}

	request(message: PermissionRequestMessage): Promise<boolean> {
		return new Promise((resolve) => {
			this.pending.set(message.requestId, { message, resolve });
			this.broadcast(message);
		});
	}

	resolve(requestId: string, approved: boolean, reason: ResolutionReason = "response"): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) return false;
		this.pending.delete(requestId);
		const event: DesktopApprovalEvent = { type: "permission_resolved", requestId, approved, reason };
		this.broadcast({
			type: "event",
			sessionId: pending.message.sessionId,
			event,
		});
		pending.resolve(approved);
		return true;
	}

	cancelSession(sessionId: string): void {
		for (const [requestId, pending] of this.pending) {
			if (pending.message.sessionId === sessionId) this.resolve(requestId, false, "cancelled");
		}
	}

	changeMode(sessionId: string, approvalMode: ApprovalMode): void {
		const event: DesktopApprovalEvent = { type: "approval_mode_changed", approvalMode };
		this.broadcast({ type: "event", sessionId, event });
		if (approvalMode === "confirm") return;
		for (const [requestId, pending] of this.pending) {
			if (pending.message.sessionId !== sessionId) continue;
			this.resolve(
				requestId,
				approvalMode === "auto" || isReadOnlyDesktopTool(pending.message.toolName, pending.message.input),
				"mode-change",
			);
		}
	}

	forSession(sessionId: string): PermissionRequestMessage[] {
		return [...this.pending.values()]
			.filter((pending) => pending.message.sessionId === sessionId)
			.map((pending) => pending.message);
	}
}
