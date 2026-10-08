import type { ApprovalMode, DesktopApprovalEvent, PermissionRequest, ServerEventMessage } from "./protocol.ts";

/** Remove only the resolved request or the session whose approval policy changed. */
export function applyPermissionQueueEvent(
	queue: PermissionRequest[],
	message: ServerEventMessage,
): PermissionRequest[] {
	if (!message.event || typeof message.event !== "object") return queue;
	const event = message.event as Partial<DesktopApprovalEvent>;
	if (event.type === "permission_resolved" && typeof event.requestId === "string") {
		return queue.filter(
			(request) => request.sessionId !== message.sessionId || request.requestId !== event.requestId,
		);
	}
	if (event.type === "approval_mode_changed" && (event.approvalMode === "auto" || event.approvalMode === "plan")) {
		return queue.filter((request) => request.sessionId !== message.sessionId);
	}
	return queue;
}

/** Session observation never changes the user's persisted default for future chats. */
export function approvalModeFromEvent(message: ServerEventMessage): ApprovalMode | undefined {
	if (!message.event || typeof message.event !== "object") return undefined;
	const event = message.event as Partial<DesktopApprovalEvent>;
	if (event.type !== "approval_mode_changed") return undefined;
	const mode = event.approvalMode;
	return mode === "auto" || mode === "confirm" || mode === "plan" ? mode : undefined;
}

export interface PermissionResponseAttempt {
	requestId: string;
	sessionId: string;
	terminal: boolean;
}

/** A delayed failed response cannot revive a request retired by another client. */
export class PermissionResponseTracker {
	private readonly terminalIds = new Set<string>();
	private readonly attempts = new Set<PermissionResponseAttempt>();

	begin(request: PermissionRequest): PermissionResponseAttempt {
		const attempt = {
			requestId: request.requestId,
			sessionId: request.sessionId,
			terminal: this.terminalIds.has(request.requestId),
		};
		this.attempts.add(attempt);
		return attempt;
	}

	canRestore(attempt: PermissionResponseAttempt): boolean {
		return !attempt.terminal && !this.terminalIds.has(attempt.requestId);
	}

	finish(attempt: PermissionResponseAttempt): void {
		this.attempts.delete(attempt);
	}

	observe(message: ServerEventMessage, visible: readonly PermissionRequest[]): void {
		if (!message.event || typeof message.event !== "object") return;
		const event = message.event as { type?: string; requestId?: string; approvalMode?: string };
		if (event.type === "permission_resolved" && typeof event.requestId === "string") {
			this.retire(event.requestId, message.sessionId);
		} else if (
			event.type === "agent_settled" ||
			(event.type === "approval_mode_changed" && (event.approvalMode === "auto" || event.approvalMode === "plan"))
		) {
			for (const request of visible)
				if (request.sessionId === message.sessionId) this.retire(request.requestId, message.sessionId);
			for (const attempt of this.attempts)
				if (attempt.sessionId === message.sessionId) this.retire(attempt.requestId, message.sessionId);
		}
	}

	private retire(requestId: string, sessionId: string): void {
		this.terminalIds.add(requestId);
		for (const attempt of this.attempts)
			if (attempt.requestId === requestId && attempt.sessionId === sessionId) attempt.terminal = true;
		// UUIDs are never reused. Keep recent terminal requests for delayed toast callbacks,
		// while in-flight attempts retain their terminal bit even after this bounded cache evicts.
		if (this.terminalIds.size > 512) {
			const oldest = this.terminalIds.values().next().value;
			if (oldest !== undefined) this.terminalIds.delete(oldest);
		}
	}
}
