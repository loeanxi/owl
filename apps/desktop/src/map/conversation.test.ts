import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopClientRequestWithoutId, ServerEventMessage } from "../bridge/protocol.ts";
import type { ChatEntry } from "../hooks/transcript.ts";
import {
	MapConversation,
	type MapConversationClient,
	type MapConversationConfig,
	type MapConversationContext,
	mapPrompt,
} from "./conversation.ts";

interface Reply {
	ok: boolean;
	result?: unknown;
	error?: string;
}

class FakeBridge implements MapConversationClient {
	requests: DesktopClientRequestWithoutId[] = [];
	events = new Set<(message: ServerEventMessage) => void>();
	statuses = new Set<(connected: boolean) => void>();
	created = 0;
	snapshot: Record<string, unknown>[] = [];
	active: string[] = [];
	handler?: (request: DesktopClientRequestWithoutId) => Reply | Promise<Reply>;

	async request<T = unknown>(
		request: DesktopClientRequestWithoutId & { id?: string },
	): Promise<{ ok: boolean; result?: T; error?: string }> {
		this.requests.push(request);
		const response = this.handler ? await this.handler(request) : this.defaultReply(request);
		return { ...response, result: response.result as T | undefined };
	}

	defaultReply(request: DesktopClientRequestWithoutId): Reply {
		if (request.type === "session.create")
			return { ok: true, result: { sessionId: `map-${++this.created}`, cwd: request.cwd, messages: [] } };
		if (request.type === "session.resume")
			return { ok: true, result: { sessionId: request.sessionId, cwd: config.cwd, messages: this.snapshot } };
		if (request.type === "session.running") return { ok: true, result: { running: this.active } };
		if (request.type === "session.setModel")
			return { ok: true, result: { model: { provider: request.provider, id: request.model }, thinkingLevel: "low" } };
		return { ok: true };
	}

	onSessionEvent(handler: (message: ServerEventMessage) => void): () => void {
		this.events.add(handler);
		return () => {
			this.events.delete(handler);
		};
	}

	onStatus(handler: (connected: boolean) => void): () => void {
		this.statuses.add(handler);
		return () => {
			this.statuses.delete(handler);
		};
	}

	emit(sessionId: string, event: Record<string, unknown>): void {
		for (const handler of this.events) handler({ type: "event", sessionId, event });
	}

	status(connected: boolean): void {
		for (const handler of this.statuses) handler(connected);
	}
}

const config: MapConversationConfig = {
	cwd: "D:/owl/demo-workspace",
	provider: "chosen-provider",
	model: "chosen-model",
	thinkingLevel: "high",
	approvalMode: "confirm",
};
const context: MapConversationContext = {
	region: "all",
	filters: ["quiet"],
	selectedPlaceId: "liubai",
	candidates: ["liubai", "muchuang"],
};

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function entryText(entry: ChatEntry | undefined): string | undefined {
	return entry?.kind === "user" || entry?.kind === "assistant" ? entry.text : undefined;
}

function finish(bridge: FakeBridge, id: string, rawText: string, answer: string): void {
	bridge.emit(id, { type: "agent_start" });
	bridge.emit(id, { type: "message_start", message: { role: "assistant" } });
	bridge.emit(id, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: answer } });
	bridge.emit(id, {
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: mapPrompt(rawText, context) }] },
			{ role: "assistant", content: [{ type: "text", text: answer }] },
		],
	});
	bridge.emit(id, { type: "agent_settled" });
}

test("the selected Owl model handles greetings, streams and keeps isolated multi-turn context", async (t) => {
	const bridge = new FakeBridge();
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	assert.equal(bridge.events.size, 0, "constructor is pure");
	conversation.subscribe(() => {});
	assert.equal(await conversation.send("你好", context), true);
	assert.deepEqual(bridge.requests[0], { type: "session.create", ...config });
	const prompt = bridge.requests.find((request) => request.type === "session.prompt");
	assert.ok(prompt?.type === "session.prompt");
	assert.equal(prompt.sessionId, "map-1");
	assert.ok(prompt.message.endsWith("你好"));
	assert.ok(prompt.message.includes("fictional demo data"));
	assert.equal(conversation.getState().busy, true);
	assert.equal(await conversation.send("重复发送", context), false);
	bridge.emit("main-chat", { type: "message_start", message: { role: "assistant" } });
	assert.equal(conversation.getState().entries.length, 1);
	bridge.emit("map-1", { type: "agent_start" });
	bridge.emit("map-1", { type: "message_start", message: { role: "assistant" } });
	bridge.emit("map-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你" } });
	bridge.emit("map-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好！" } });
	assert.equal(conversation.getState().entries.at(-1)?.kind, "assistant");
	assert.equal(entryText(conversation.getState().entries.at(-1)), "你好！");
	bridge.emit("map-1", {
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: prompt.message }] },
			{ role: "assistant", content: [{ type: "text", text: "你好！" }] },
		],
	});
	bridge.emit("map-1", { type: "agent_settled" });
	assert.equal(conversation.getState().busy, false);
	assert.equal(entryText(conversation.getState().entries[0]), "你好", "context stays out of the visible user message");
	assert.equal(await conversation.send("比较一下预算", context), true);
	finish(bridge, "map-1", "比较一下预算", "我们可以比较两个演示地点。");
	assert.deepEqual(
		conversation.getState().entries.map((entry) => entry.kind),
		["user", "assistant", "user", "assistant"],
	);
	assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
	assert.equal(bridge.requests.filter((request) => request.type === "session.prompt").length, 2);
});

test("model, effort and permission changes wait for the next turn and override adaptive effort", async (t) => {
	const bridge = new FakeBridge();
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	assert.equal(await conversation.send("你好", context), true);
	conversation.setConfig({ ...config, provider: "next-provider", model: "next-model", approvalMode: "plan" });
	assert.equal(bridge.requests.filter((request) => request.type.startsWith("session.set")).length, 0);
	finish(bridge, "map-1", "你好", "你好。");
	assert.equal(await conversation.send("继续聊聊", context), true);
	assert.deepEqual(
		bridge.requests.slice(2).map((request) => request.type),
		["session.setModel", "session.setThinkingLevel", "session.setApprovalMode", "session.prompt"],
	);
	assert.deepEqual(bridge.requests[3], { type: "session.setThinkingLevel", sessionId: "map-1", level: "high" });
	assert.equal(conversation.getState().entries.filter((entry) => entry.kind === "user").length, 2);
});

test("failed create and prompt requests remain retryable without phantom busy states or user rows", async (t) => {
	for (const phase of ["create", "prompt"] as const) {
		for (const throws of [false, true]) {
			const bridge = new FakeBridge();
			let fail = true;
			bridge.handler = (request) => {
				if (fail && request.type === `session.${phase}`) {
					fail = false;
					if (throws) throw new Error("bridge failed");
					return { ok: false, error: "request rejected" };
				}
				return bridge.defaultReply(request);
			};
			const conversation = new MapConversation(bridge, config, true);
			t.after(() => conversation.dispose());
			assert.equal(await conversation.send("你好", context), false);
			assert.equal(conversation.getState().busy, false);
			assert.deepEqual(conversation.getState().entries, []);
			assert.ok(conversation.getState().error);
			assert.equal(await conversation.send("你好", context), true);
			finish(bridge, conversation.getState().sessionId ?? "", "你好", "你好。");
			assert.equal(conversation.getState().entries.length, 2);
		}
	}
});

test("a workspace change defeats stale creation and never sends a new prompt to the previous workspace", async (t) => {
	const bridge = new FakeBridge();
	const first = deferred<Reply>();
	const second = deferred<Reply>();
	bridge.handler = (request) =>
		request.type === "session.create"
			? request.cwd === config.cwd
				? first.promise
				: second.promise
			: bridge.defaultReply(request);
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	const staleSend = conversation.send("旧项目", context);
	conversation.setConfig({ ...config, cwd: "D:/another-workspace" });
	const currentSend = conversation.send("新项目", context);
	second.resolve({ ok: true, result: { sessionId: "new-map" } });
	assert.equal(await currentSend, true);
	first.resolve({ ok: true, result: { sessionId: "old-map" } });
	assert.equal(await staleSend, false);
	assert.equal(conversation.getState().sessionId, "new-map");
	assert.equal(entryText(conversation.getState().entries[0]), "新项目");
	const prompts = bridge.requests.filter((request) => request.type === "session.prompt");
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].sessionId, "new-map");
});

test("a config change while creating synchronizes the latest UI choice before sending", async (t) => {
	const bridge = new FakeBridge();
	const created = deferred<Reply>();
	bridge.handler = (request) => (request.type === "session.create" ? created.promise : bridge.defaultReply(request));
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	const sent = conversation.send("你好", context);
	conversation.setConfig({ ...config, model: "new-ui-model", thinkingLevel: "medium" });
	created.resolve({ ok: true, result: { sessionId: "map-current" } });
	assert.equal(await sent, true);
	assert.deepEqual(
		bridge.requests.map((request) => request.type),
		["session.create", "session.setModel", "session.setThinkingLevel", "session.prompt"],
	);
	assert.deepEqual(bridge.requests[1], {
		type: "session.setModel",
		sessionId: "map-current",
		provider: config.provider,
		model: "new-ui-model",
	});
	assert.deepEqual(bridge.requests[2], { type: "session.setThinkingLevel", sessionId: "map-current", level: "medium" });
});

test("new exploration clears only the map thread and abort targets only its own current session", async (t) => {
	const bridge = new FakeBridge();
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	await conversation.send("你好", context);
	finish(bridge, "map-1", "你好", "你好。");
	conversation.newThread();
	assert.deepEqual(conversation.getState().entries, []);
	assert.equal(conversation.getState().sessionId, undefined);
	await conversation.send("再次探索", context);
	bridge.emit("map-1", { type: "message_start", message: { role: "assistant" } });
	assert.equal(conversation.getState().entries.length, 1);
	assert.equal(await conversation.abort(), true);
	assert.deepEqual(bridge.requests.at(-1), { type: "session.abort", sessionId: "map-2" });
	assert.equal(conversation.getState().busy, false);
	conversation.dispose();
	assert.equal(bridge.events.size, 0);
	assert.equal(bridge.statuses.size, 0);
	assert.equal(bridge.requests.filter((request) => request.type === "session.abort").length, 1);
});

test("StrictMode attach, detach and reattach remain usable without constructor or listener leaks", async (t) => {
	const bridge = new FakeBridge();
	const discarded = new MapConversation(bridge, config, true);
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => {
		discarded.dispose();
		conversation.dispose();
	});
	assert.equal(bridge.events.size, 0);
	const off = conversation.subscribe(() => {});
	assert.equal(bridge.events.size, 1);
	off();
	assert.equal(bridge.events.size, 0);
	conversation.dispose();
	conversation.subscribe(() => {});
	assert.equal(bridge.events.size, 1);
	assert.equal(await conversation.send("你好", context), true);
	finish(bridge, "map-1", "你好", "你好。");
	assert.equal(entryText(conversation.getState().entries.at(-1)), "你好。");
	assert.equal(bridge.statuses.size, 1);
});

test("reconnect restores missed streamed messages without exposing map context and preserves a running thread", async (t) => {
	const bridge = new FakeBridge();
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	conversation.subscribe(() => {});
	await conversation.send("你好", context);
	bridge.emit("map-1", { type: "agent_start" });
	bridge.status(false);
	assert.equal(conversation.getState().connected, false);
	bridge.snapshot = [
		{ role: "user", content: [{ type: "text", text: mapPrompt("你好", context) }] },
		{ role: "assistant", content: [{ type: "text", text: "重连后保留的回答" }] },
	];
	bridge.active = ["map-1", "main-chat"];
	bridge.status(true);
	await flush();
	assert.equal(conversation.getState().sessionId, "map-1");
	assert.equal(conversation.getState().busy, true);
	assert.equal(entryText(conversation.getState().entries[0]), "你好");
	assert.equal(entryText(conversation.getState().entries.at(-1)), "重连后保留的回答");
	assert.ok(bridge.requests.some((request) => request.type === "session.resume" && request.sessionId === "map-1"));
	assert.equal(bridge.requests.find((request) => request.type === "session.resume")?.approvalMode, "confirm");
	bridge.emit("map-1", { type: "agent_settled" });
	assert.equal(conversation.getState().busy, false);
	assert.equal(await conversation.send("继续", context), true);
	assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
});

test("aborting during creation cancels the pending prompt even if session creation succeeds later", async (t) => {
	const bridge = new FakeBridge();
	const created = deferred<Reply>();
	bridge.handler = () => created.promise;
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	const pending = conversation.send("你好", context);
	assert.equal(await conversation.abort(), true);
	created.resolve({ ok: true, result: { sessionId: "late-map" } });
	assert.equal(await pending, false);
	assert.equal(conversation.getState().sessionId, undefined);
	assert.equal(conversation.getState().busy, false);
	assert.deepEqual(
		bridge.requests.map((request) => request.type),
		["session.create"],
	);
});

test("map context keeps identifiers as fictional data rather than fabricating real addresses", () => {
	const prompt = mapPrompt("  原样的问题\n第二行  ", context);
	assert.ok(prompt.endsWith("  原样的问题\n第二行  "));
	assert.ok(prompt.includes('"fictional":true'));
	assert.ok(prompt.includes('"illustratedArea":"湖滨"'));
	assert.equal(prompt.includes('"address"'), false);
	assert.equal(prompt.includes("chosen-model"), false);
});

test("a run that settles before the prompt acknowledgement cannot resurrect the busy indicator", async (t) => {
	const bridge = new FakeBridge();
	const acknowledged = deferred<Reply>();
	bridge.handler = (request) =>
		request.type === "session.prompt" ? acknowledged.promise : bridge.defaultReply(request);
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	const sent = conversation.send("你好", context);
	await flush();
	finish(bridge, "map-1", "你好", "很快返回的回答");
	assert.equal(conversation.getState().running, false);
	acknowledged.resolve({ ok: true });
	assert.equal(await sent, true);
	assert.equal(conversation.getState().busy, false);
});

test("failed model synchronization preserves context and stops before dispatching a prompt", async (t) => {
	const bridge = new FakeBridge();
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	await conversation.send("你好", context);
	finish(bridge, "map-1", "你好", "你好。");
	conversation.setConfig({ ...config, model: "unavailable-model" });
	bridge.handler = (request) =>
		request.type === "session.setModel" ? { ok: false, error: "Model is unavailable" } : bridge.defaultReply(request);
	assert.equal(await conversation.send("继续", context), false);
	assert.equal(conversation.getState().busy, false);
	assert.equal(conversation.getState().entries.length, 2);
	assert.equal(bridge.requests.filter((request) => request.type === "session.prompt").length, 1);
	bridge.handler = undefined;
	assert.equal(await conversation.send("继续", context), true);
	assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
});

test("an unacknowledged prompt disconnects locally and can send again after completed snapshot recovery", async (t) => {
	const bridge = new FakeBridge();
	const unacknowledged = deferred<Reply>();
	let holdPrompt = true;
	bridge.handler = (request) => {
		if (request.type === "session.prompt" && holdPrompt) {
			holdPrompt = false;
			return unacknowledged.promise;
		}
		return bridge.defaultReply(request);
	};
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	const pending = conversation.send("你好", context);
	await flush();
	assert.equal(conversation.getState().submitting, true);
	bridge.status(false);
	bridge.snapshot = [
		{ role: "user", content: [{ type: "text", text: mapPrompt("你好", context) }] },
		{ role: "assistant", content: [{ type: "text", text: "断线期间完成的回答" }] },
	];
	bridge.status(true);
	await flush();
	assert.equal(conversation.getState().busy, false);
	assert.equal(entryText(conversation.getState().entries.at(-1)), "断线期间完成的回答");
	assert.equal(await conversation.send("再聊一轮", context), true);
	assert.equal(await pending, false, "a bridge promise that never resolves must not retain the local send");
	assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
	assert.equal(bridge.requests.filter((request) => request.type === "session.prompt").length, 2);
});

test("disconnect during an unacknowledged create unlocks the form and ignores its stale completion", async (t) => {
	const bridge = new FakeBridge();
	const unacknowledged = deferred<Reply>();
	let holdCreate = true;
	bridge.handler = (request) => {
		if (request.type === "session.create" && holdCreate) {
			holdCreate = false;
			return unacknowledged.promise;
		}
		return bridge.defaultReply(request);
	};
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	const pending = conversation.send("创建时断线", context);
	bridge.status(false);
	assert.equal(conversation.getState().submitting, false);
	assert.equal(conversation.getState().sessionId, undefined);
	bridge.status(true);
	assert.equal(await conversation.send("重连后发送", context), true);
	assert.equal(await pending, false);
	unacknowledged.resolve({ ok: true, result: { sessionId: "stale-map" } });
	await flush();
	assert.equal(conversation.getState().sessionId, "map-1");
	assert.equal(entryText(conversation.getState().entries[0]), "重连后发送");
	assert.equal(bridge.requests.filter((request) => request.type === "session.prompt").length, 1);
});

test("a reconnect snapshot cannot overwrite newer live stream events", async (t) => {
	const bridge = new FakeBridge();
	const restored = deferred<Reply>();
	const conversation = new MapConversation(bridge, config, true);
	t.after(() => conversation.dispose());
	await conversation.send("你好", context);
	bridge.emit("map-1", { type: "agent_start" });
	bridge.emit("map-1", { type: "message_start", message: { role: "assistant" } });
	bridge.emit("map-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "流式" } });
	bridge.status(false);
	bridge.handler = (request) => (request.type === "session.resume" ? restored.promise : bridge.defaultReply(request));
	bridge.status(true);
	bridge.emit("map-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "更新" } });
	bridge.emit("map-1", { type: "agent_settled" });
	restored.resolve({
		ok: true,
		result: {
			sessionId: "map-1",
			cwd: config.cwd,
			messages: [{ role: "assistant", content: [{ type: "text", text: "旧恢复快照" }] }],
		},
	});
	await flush();
	assert.equal(entryText(conversation.getState().entries.at(-1)), "流式更新");
	assert.equal(conversation.getState().busy, false);
});

test("resuming a still-running map thread preserves its selected approval mode without changing model or effort", async (t) => {
	for (const approvalMode of ["confirm", "plan"] as const) {
		const bridge = new FakeBridge();
		let resumedMode = "auto";
		const conversation = new MapConversation(bridge, { ...config, approvalMode }, true);
		t.after(() => conversation.dispose());
		await conversation.send("你好", context);
		bridge.active = ["map-1"];
		bridge.handler = (request) => {
			if (request.type === "session.resume") resumedMode = request.approvalMode ?? "auto";
			return bridge.defaultReply(request);
		};
		bridge.status(false);
		bridge.status(true);
		await flush();
		assert.equal(resumedMode, approvalMode);
		assert.equal(conversation.getState().running, true);
		assert.deepEqual(
			bridge.requests.find((request) => request.type === "session.resume"),
			{
				type: "session.resume",
				sessionId: "map-1",
				approvalMode,
			},
		);
		assert.equal(
			bridge.requests.some(
				(request) => request.type === "session.setModel" || request.type === "session.setThinkingLevel",
			),
			false,
		);
	}
});
