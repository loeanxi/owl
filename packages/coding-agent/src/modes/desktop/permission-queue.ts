import { isReadOnlyDesktopTool } from "./browser-permissions.ts";
import type { ApprovalMode, DesktopApprovalEvent, DesktopServerMessage, PermissionRequestMessage } from "./protocol.ts";

type ResolutionReason = "response" | "mode-change" | "cancelled" | "timeout";
type PendingPermission = {
	message: PermissionRequestMessage;
	resolve: (approved: boolean) => void;
	timer?: ReturnType<typeof setTimeout>;
};

export type DesktopPermissionQueueOptions = {
	/** 超时未裁决则按拒绝处理；0 / Infinity / 负数表示不超时。默认 30 分钟。 */
	timeoutMs?: number;
};

const DEFAULT_PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Shared approvals: one decision must retire the request on every connected UI. */
export class DesktopPermissionQueue {
	private readonly pending = new Map<string, PendingPermission>();
	private readonly broadcast: (message: DesktopServerMessage) => void;
	private readonly timeoutMs: number;

	constructor(broadcast: (message: DesktopServerMessage) => void, options?: DesktopPermissionQueueOptions) {
		this.broadcast = broadcast;
		const raw = options?.timeoutMs;
		if (typeof raw !== "number" || Number.isNaN(raw)) this.timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;
		else if (raw <= 0 || !Number.isFinite(raw)) this.timeoutMs = 0;
		else this.timeoutMs = raw;
	}

	request(message: PermissionRequestMessage): Promise<boolean> {
		return new Promise((resolve) => {
			const entry: PendingPermission = { message, resolve };
			if (this.timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.resolve(message.requestId, false, "timeout");
				}, this.timeoutMs);
			}
			this.pending.set(message.requestId, entry);
			this.broadcast(message);
		});
	}

	resolve(requestId: string, approved: boolean, reason: ResolutionReason = "response"): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) return false;
		this.pending.delete(requestId);
		if (pending.timer) clearTimeout(pending.timer);
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

	/** 桥关闭：挂起审批全部按取消处理并清掉定时器。 */
	cancelAll(): void {
		for (const requestId of [...this.pending.keys()]) this.resolve(requestId, false, "cancelled");
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

	/** 全部挂起审批（重连时按连接单播重放，不重新 broadcast）。 */
	pendingMessages(): PermissionRequestMessage[] {
		return [...this.pending.values()].map((pending) => pending.message);
	}
}
