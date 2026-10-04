/**
 * Session-side mirror of the queued user input, extracted from AgentSession.
 *
 * The real steering/followUp queues live on the Agent (pi-agent-core); this
 * tracker keeps the text mirror the session and UI read (queue_update events,
 * getSteeringMessages/getFollowUpMessages, pendingMessageCount) and owns the
 * invariant that every mutation emits exactly one queue_update. Delivery
 * removal matches by message text, steering before followUp.
 */

import type { AgentSessionEvent } from "./agent-session.ts";

export interface QueueSnapshot {
	steering: string[];
	followUp: string[];
}

export class SessionQueueTracker {
	private readonly deps: { emit(event: AgentSessionEvent): void };
	private _steering: string[] = [];
	private _followUp: string[] = [];

	constructor(deps: { emit(event: AgentSessionEvent): void }) {
		this.deps = deps;
	}

	/** Pending steering messages (read-only view). */
	get steering(): readonly string[] {
		return this._steering;
	}

	/** Pending follow-up messages (read-only view). */
	get followUp(): readonly string[] {
		return this._followUp;
	}

	/** Number of pending messages across both queues. */
	get count(): number {
		return this._steering.length + this._followUp.length;
	}

	pushSteering(text: string): void {
		this._steering.push(text);
		this._emitUpdate();
	}

	pushFollowUp(text: string): void {
		this._followUp.push(text);
		this._emitUpdate();
	}

	/**
	 * Drop the first queue entry matching a delivered user message's text,
	 * checking steering first. Emits queue_update when something was removed.
	 */
	removeDelivered(messageText: string): void {
		const steeringIndex = this._steering.indexOf(messageText);
		if (steeringIndex !== -1) {
			this._steering.splice(steeringIndex, 1);
			this._emitUpdate();
			return;
		}
		const followUpIndex = this._followUp.indexOf(messageText);
		if (followUpIndex !== -1) {
			this._followUp.splice(followUpIndex, 1);
			this._emitUpdate();
		}
	}

	/**
	 * Clear both queues and return what was pending.
	 * Useful for restoring to editor when user aborts.
	 */
	clear(): QueueSnapshot {
		const snapshot: QueueSnapshot = {
			steering: [...this._steering],
			followUp: [...this._followUp],
		};
		this._steering = [];
		this._followUp = [];
		this._emitUpdate();
		return snapshot;
	}

	private _emitUpdate(): void {
		this.deps.emit({
			type: "queue_update",
			steering: [...this._steering],
			followUp: [...this._followUp],
		});
	}
}
