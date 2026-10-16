/**
 * Session-side mirror of the queued user input, extracted from AgentSession.
 *
 * The real steering/followUp queues live on the Agent (pi-agent-core); this
 * tracker keeps the text mirror the session and UI read (queue_update events,
 * getSteeringMessages/getFollowUpMessages, pendingMessageCount) and owns the
 * invariant that every mutation emits exactly one queue_update. Delivery
 * removal uses the queue identity, so identical text and image-only inputs stay independent.
 */

import { randomUUID } from "node:crypto";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";

export interface QueuedUserInput {
	text: string;
	images?: ImageContent[];
	attachedPaths?: string[];
}

export type QueuedUserMessage = UserMessage & { owlQueueId: string; owlQueueInput?: QueuedUserInput };

/** Synchronous snapshot of all lanes; the model cannot drain while this call restores them. */
export function snapshotAgentQueue(agent: Agent): { steering: AgentMessage[]; followUp: AgentMessage[] } {
	const snapshot = { steering: [] as AgentMessage[], followUp: [] as AgentMessage[] };
	try {
		for (const lane of ["steering", "followUp"] as const) {
			for (;;) {
				const message = lane === "steering" ? agent.takeSteeringAt(0) : agent.takeFollowUpAt(0);
				if (!message) break;
				if (message.role === "user") {
					const queued = message as UserMessage & { owlQueueId?: string };
					queued.owlQueueId ??= randomUUID();
				}
				snapshot[lane].push(message);
			}
		}
		return snapshot;
	} finally {
		for (const message of snapshot.steering) agent.steer(message);
		for (const message of snapshot.followUp) agent.followUp(message);
	}
}

/** Original editor material is kept separate from model-only attachment/skill wrappers. */
export function queuedInputOf(message: UserMessage): QueuedUserInput {
	const queued = message as UserMessage & { owlQueueInput?: QueuedUserInput };
	if (queued.owlQueueInput) return structuredClone(queued.owlQueueInput);
	const content = message.content;
	let text =
		typeof content === "string"
			? content
			: content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	const attachedPaths: string[] = [];
	const header = /^\[Attached files for this turn\]\n((?:- [^\n]*\n)*)\n/.exec(text);
	if (header) {
		for (const line of header[1].split("\n")) if (line.startsWith("- ")) attachedPaths.push(line.slice(2));
		text = text.slice(header[0].length);
	}
	const images = typeof content === "string" ? [] : content.filter((part) => part.type === "image");
	return { text, images: structuredClone(images), attachedPaths };
}

type TrackedInput = { text: string; messageId?: string };

export interface QueueSnapshot {
	steering: string[];
	followUp: string[];
}

export class SessionQueueTracker {
	private readonly deps: { emit(event: AgentSessionEvent): void };
	private _steering: TrackedInput[] = [];
	private _followUp: TrackedInput[] = [];

	constructor(deps: { emit(event: AgentSessionEvent): void }) {
		this.deps = deps;
	}

	/** Pending steering messages (read-only view). */
	get steering(): readonly string[] {
		return this._steering.map((item) => item.text);
	}

	/** Pending follow-up messages (read-only view). */
	get followUp(): readonly string[] {
		return this._followUp.map((item) => item.text);
	}

	/** Number of pending messages across both queues. */
	get count(): number {
		return this._steering.length + this._followUp.length;
	}

	pushSteering(text: string, messageId?: string): void {
		this._steering.push({ text, messageId });
		this._emitUpdate();
	}

	pushFollowUp(text: string, messageId?: string): void {
		this._followUp.push({ text, messageId });
		this._emitUpdate();
	}

	/** Drop one pending line. The index matches the agent queue, steering before follow-up is not assumed. */
	removeAt(lane: "steering" | "followUp", index: number): string | undefined {
		const list = lane === "steering" ? this._steering : this._followUp;
		if (index < 0 || index >= list.length) return undefined;
		const [item] = list.splice(index, 1);
		this._emitUpdate();
		return item.text;
	}

	/** A queued follow-up should join the current turn at the next tool boundary. */
	moveFollowUpToSteering(index: number): string | undefined {
		if (index < 0 || index >= this._followUp.length) return undefined;
		const [item] = this._followUp.splice(index, 1);
		this._steering.push(item);
		this._emitUpdate();
		return item.text;
	}

	removeId(lane: "steering" | "followUp", messageId: string): void {
		const list = lane === "steering" ? this._steering : this._followUp;
		const index = list.findIndex((item) => item.messageId === messageId);
		if (index >= 0) this.removeAt(lane, index);
	}

	promoteId(messageId: string): void {
		const index = this._followUp.findIndex((item) => item.messageId === messageId);
		if (index >= 0) this.moveFollowUpToSteering(index);
	}

	/**
	 * Drop the first queue entry matching a delivered user message's text,
	 * checking steering first. Emits queue_update when something was removed.
	 */
	removeDelivered(messageText: string, messageId?: string): void {
		const matches = (item: TrackedInput) =>
			messageId ? item.messageId === messageId : item.text === messageText && item.messageId === undefined;
		const steeringIndex = this._steering.findIndex(matches);
		if (steeringIndex !== -1) {
			this._steering.splice(steeringIndex, 1);
			this._emitUpdate();
			return;
		}
		const followUpIndex = this._followUp.findIndex(matches);
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
			steering: [...this.steering],
			followUp: [...this.followUp],
		};
		this._steering = [];
		this._followUp = [];
		this._emitUpdate();
		return snapshot;
	}

	private _emitUpdate(): void {
		this.deps.emit({
			type: "queue_update",
			steering: [...this.steering],
			followUp: [...this.followUp],
		});
	}
}
