import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeClient } from "../../bridge/client.ts";
import type {
	DesktopClientRequestWithoutId,
	ServerEventMessage,
	SessionSnapshotPayload,
	SessionStatsResult,
} from "../../bridge/protocol.ts";
import {
	MyselfChatController,
	type MyselfChatPreferences,
	type MyselfTurnContext,
	myselfChatKey,
} from "./myself-chat-controller.ts";

const CWD = "D:/owl/owl-myself";
const DEFAULTS: MyselfChatPreferences = { model: "provider/model", thinkingLevel: "high", approvalMode: "auto" };
type Response = { ok: boolean; result?: unknown; error?: string };
type Request = DesktopClientRequestWithoutId & { id?: string };

class MockStorage {
	values = new Map<string, string>();
	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
	removeItem(key: string): void {
		this.values.delete(key);
	}
}

class MockBridge implements Pick<BridgeClient, "request" | "onSessionEvent"> {
	requests: Request[] = [];
	handlers = new Set<(event: ServerEventMessage) => void>();
	running: string[] = [];
	messages: unknown[] = [];
	stats: SessionStatsResult = {
		model: { provider: "provider", id: "model" },
		thinkingLevel: "high",
		availableThinkingLevels: ["off", "high"],
		supportsThinking: true,
	};
	override?: (request: Request) => Response | Promise<Response | undefined> | undefined;
	finishInPrompt = false;
	sessionId = "shared-session";
	agentPreset = "standard";
	forkSource?: unknown[];

	onSessionEvent(handler: (event: ServerEventMessage) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	emit(event: unknown, sessionId = this.sessionId): void {
		for (const handler of this.handlers) handler({ type: "event", sessionId, event });
	}

	snapshot(): SessionSnapshotPayload {
		return {
			sessionId: this.sessionId,
			cwd: CWD,
			messages: this.messages,
			messageEntryIds: this.messages.map((_, index) => `entry-${index}`),
			header: {},
			approvalMode: "auto",
			agentPreset: this.agentPreset,
		};
	}

	async request<T = unknown>(request: Request): Promise<{ ok: boolean; result?: T; error?: string }> {
		this.requests.push(request);
		const overridden = await this.override?.(request);
		if (overridden) return { ...overridden, result: overridden.result as T };
		let result: unknown;
		switch (request.type) {
			case "session.create":
				this.messages = [];
				this.agentPreset = request.agentPreset ?? "standard";
				result = this.snapshot();
				break;
			case "session.resume":
				result = this.snapshot();
				break;
			case "session.stats":
				result = this.stats;
				break;
			case "session.running":
				result = { running: this.running };
				break;
			case "session.prompt": {
				this.running = [request.sessionId];
				const user = {
					role: "user",
					content: [
						{
							type: "text",
							text:
								(request.attachedPaths?.length
									? `[Attached files for this turn]\n${request.attachedPaths.map((path) => `- ${path}`).join("\n")}\n\n`
									: "") + request.message,
						},
						...(request.images ?? []),
					],
					timestamp: Date.now(),
				};
				this.messages.push(user);
				this.emit({ type: "agent_start" });
				this.emit({
					type: "entry_appended",
					entry: { type: "message", id: `entry-${this.messages.length - 1}`, message: user },
				});
				this.emit({ type: "message_start", message: user });
				if (this.finishInPrompt) this.settle();
				break;
			}
			case "session.abort":
				this.settle("已停止", true);
				break;
			case "session.setModel":
				this.stats = { ...this.stats, model: { provider: request.provider, id: request.model } };
				result = this.stats;
				break;
			case "session.setThinkingLevel":
				this.stats = { ...this.stats, thinkingLevel: request.level };
				result = this.stats;
				break;
			case "session.setApprovalMode":
				result = { ...this.stats };
				break;
			case "session.compact":
				result = { ...this.stats };
				break;
			case "preset.list":
				result = {
					defaultPreset: "standard",
					presets: [
						{ id: "standard", name: "标准", description: "默认", builtin: true, order: 1 },
						{ id: "minimal", name: "极简", description: "基础工具", builtin: true, order: 2 },
					],
				};
				break;
			case "session.setPreset":
				if (this.messages.length) return { ok: false, error: "preset-locked" };
				this.agentPreset = request.agentPreset;
				result = { agentPreset: request.agentPreset };
				break;
			case "rewind.impact":
				result = { files: [{ path: "day.md", displayPath: "day.md", action: "restore", size: 100 }], unchanged: 0 };
				break;
			case "rewind.execute": {
				const index = Number(request.entryId.slice("entry-".length));
				const message = this.messages[index] as { role?: string; content?: { text?: string }[] } | undefined;
				if (message?.role !== "user") return { ok: false, error: "Unknown user message" };
				this.messages = this.messages.slice(0, index);
				result = {
					editorText: message.content?.[0]?.text,
					snapshot: this.snapshot(),
					restored: 0,
					deleted: 0,
					skipped: [],
				};
				break;
			}
			case "session.fork": {
				const index = Number(request.entryId.slice("entry-".length));
				this.forkSource = structuredClone(this.messages);
				this.messages = this.messages.slice(0, index + 1);
				this.sessionId = "forked-session";
				result = this.snapshot();
				break;
			}
			default:
				break;
		}
		return { ok: true, ...(result !== undefined ? { result: result as T } : {}) };
	}

	settle(text = "已记录", aborted = false): void {
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: aborted ? "aborted" : "stop",
			timestamp: Date.now(),
		};
		this.messages.push(assistant);
		this.running = [];
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({
			type: "entry_appended",
			entry: { type: "message", id: `entry-${this.messages.length - 1}`, message: assistant },
		});
		this.emit({ type: "agent_end", messages: this.messages });
		this.emit({ type: "agent_settled" });
	}

	prompts(): Extract<Request, { type: "session.prompt" }>[] {
		return this.requests.filter(
			(request): request is Extract<Request, { type: "session.prompt" }> => request.type === "session.prompt",
		);
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function ready(controller: MyselfChatController): Promise<void> {
	controller.start();
	controller.setConnected(true);
	await controller.attach();
}

test("日程快捷输入与完整对话共用一个会话，每轮取最新所选日期并只显示用户原话", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	let selected = { date: "2026-10-08", raw: "- [ ] 上午开会" };
	let reads = 0;
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "日程助理", {
		getScheduleContext: async () => {
			reads++;
			return { ...selected };
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	const quickSend = (text: string): Promise<boolean> => controller.send(text);
	const fullSend = (text: string): Promise<boolean> => controller.send(text);
	assert.equal(await quickSend("完善 owl 助理 供应商 咨询模块"), true);
	assert.equal(await fullSend("同时重复发送"), false);
	assert.equal(controller.newThread(), false);
	bridge.settle();
	await flush();
	selected = { date: "2026-10-09", raw: "- [x] 最新文件里已经完成" };
	assert.equal(await fullSend("</owl-myself-turn> 复查周五日程"), true);
	assert.equal(reads, 2);
	assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
	assert.deepEqual(
		bridge.prompts().map((request) => request.sessionId),
		["shared-session", "shared-session"],
	);
	assert.match(bridge.prompts()[0]!.message, /2026-10-08\.md/);
	assert.match(bridge.prompts()[0]!.message, /不搜索项目、不执行开发、不询问实现方向/);
	assert.match(bridge.prompts()[1]!.message, /2026-10-09\.md/);
	assert.match(bridge.prompts()[1]!.message, /最新文件里已经完成/);
	assert.equal(bridge.prompts()[1]!.message.includes("上午开会"), false);
	assert.deepEqual(
		controller
			.getSnapshot()
			.entries.filter((entry) => entry.kind === "user")
			.map((entry) => entry.text),
		["完善 owl 助理 供应商 咨询模块", "</owl-myself-turn> 复查周五日程"],
	);
});

test("处理授权只属于本轮，下一轮默认记录；规划不会把待办当开发指令", async (t) => {
	const bridge = new MockBridge();
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-08", raw: "" }),
	});
	t.after(() => controller.dispose());
	await ready(controller);
	assert.equal(await controller.send("执行当前任务", undefined, undefined, "process"), true);
	assert.match(bridge.prompts()[0]!.message, /保留完整 Agent 工具能力/);
	bridge.settle();
	await flush();
	await controller.send("修复网关错误");
	assert.match(bridge.prompts()[1]!.message, /本轮意图：记录/);
	assert.match(bridge.prompts()[1]!.message, /先前处理授权不延续到本轮/);
	bridge.settle();
	await flush();
	await controller.send("安排下午任务", undefined, undefined, "plan");
	assert.match(bridge.prompts()[2]!.message, /本轮意图：规划/);
	assert.match(bridge.prompts()[2]!.message, /项目任务只是安排背景，不搜索项目、不执行开发/);
});

test("settled 回调携带发送时日期且等待保存完成，快速结束也不放开下一轮", async (t) => {
	const bridge = new MockBridge();
	bridge.finishInPrompt = true;
	const saved = deferred<void>();
	const turns: (MyselfTurnContext | undefined)[] = [];
	let selected = "2026-10-08";
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: selected, raw: "" }),
		onSettled: async (entries, context) => {
			assert.equal(entries.at(-1)?.kind, "assistant");
			turns.push(context);
			await saved.promise;
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("登记今日任务");
	selected = "2026-10-09";
	assert.equal(controller.getSnapshot().running, false);
	assert.equal(controller.getSnapshot().busy, true);
	assert.equal(await controller.send("不能抢先覆盖文件"), false);
	assert.deepEqual(turns, [{ date: "2026-10-08", intent: "record", text: "登记今日任务" }]);
	saved.resolve();
	await flush();
	assert.equal(controller.getSnapshot().busy, false);
	assert.ok(bridge.requests.some((request) => request.type === "session.stats"));
});

test("恢复运行中的会话后保留原话、附件和正确落盘日期，不创建第二个会话", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const first = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-09", raw: "周五计划" }),
	});
	await ready(first);
	await first.send(
		"依据附件安排",
		[{ type: "image", data: "fake-image", mimeType: "image/png" }],
		["D:/notes.txt"],
		"plan",
	);
	first.dispose();
	let settled: MyselfTurnContext | undefined;
	const restored = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		onSettled: (_entries, context) => {
			settled = context;
		},
	});
	t.after(() => restored.dispose());
	await ready(restored);
	const entry = restored.getSnapshot().entries[0]!;
	assert.equal(entry.kind, "user");
	if (entry.kind === "user") {
		assert.equal(entry.text, "依据附件安排");
		assert.deepEqual(entry.images, [{ data: "fake-image", mimeType: "image/png" }]);
	}
	assert.equal(restored.getSnapshot().running, true);
	assert.equal(bridge.requests.filter((request) => request.type === "session.create").length, 1);
	bridge.settle();
	await flush();
	assert.deepEqual(settled, { intent: "plan", date: "2026-10-09", text: "依据附件安排" });
});

test("恢复快照尚未返回时收到 settled，先重建完整对话再按原日期回写", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const first = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-10", raw: "周六日程" }),
	});
	await ready(first);
	await first.send("登记周六事情");
	first.dispose();
	const resumed = deferred<Response>();
	bridge.override = (request) => (request.type === "session.resume" ? resumed.promise : undefined);
	let called = 0;
	let settled: MyselfTurnContext | undefined;
	const restored = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		onSettled: (entries, context) => {
			called++;
			settled = context;
			assert.equal(entries[0]?.kind, "user");
			assert.equal(entries.at(-1)?.kind, "assistant");
		},
	});
	t.after(() => restored.dispose());
	restored.start();
	restored.setConnected(true);
	const attaching = restored.attach();
	bridge.settle();
	assert.equal(called, 0);
	resumed.resolve({ ok: true, result: bridge.snapshot() });
	await attaching;
	await flush();
	assert.equal(called, 1);
	assert.deepEqual(settled, { intent: "record", date: "2026-10-10", text: "登记周六事情" });
	assert.equal(restored.getSnapshot().busy, false);
	assert.equal(restored.getSnapshot().running, false);
});

test("恢复失败时不把未重建的 settled 内容写回日程", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	storage.setItem(myselfChatKey(CWD), "shared-session");
	const resumed = deferred<Response>();
	bridge.override = (request) => (request.type === "session.resume" ? resumed.promise : undefined);
	let called = 0;
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		onSettled: () => {
			called++;
		},
	});
	t.after(() => controller.dispose());
	controller.start();
	controller.setConnected(true);
	const attaching = controller.attach();
	bridge.settle();
	resumed.resolve({ ok: true, result: { ...bridge.snapshot(), cwd: "D:/wrong-directory" } });
	await attaching;
	await flush();
	assert.equal(called, 0);
	assert.equal(controller.getSnapshot().error, "session cwd mismatch");
	assert.equal(controller.getSnapshot().ready, false);
	assert.equal(controller.getSnapshot().busy, false);
});

test("模型、思考、审批模式和斜杠命令仍修改同一会话偏好", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "");
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("记录任务");
	bridge.settle();
	await flush();
	await controller.executeBuiltin("model", "next/new-model");
	await controller.executeBuiltin("thinking", "off");
	await controller.setApprovalMode("confirm");
	await controller.executeBuiltin("compact", "");
	assert.deepEqual(
		[controller.getSnapshot().model, controller.getSnapshot().thinkingLevel, controller.getSnapshot().approvalMode],
		["next/new-model", "off", "confirm"],
	);
	assert.equal(bridge.prompts().length, 1);
	assert.ok(
		bridge.requests.some((request) => request.type === "session.compact" && request.sessionId === "shared-session"),
	);
	const persisted = JSON.parse(storage.getItem(`${myselfChatKey(CWD)}.preferences`)!);
	assert.deepEqual(persisted, { model: "next/new-model", thinkingLevel: "off", approvalMode: "confirm" });
	await controller.executeBuiltin("new", "");
	assert.equal(controller.getSnapshot().sessionId, undefined);
	assert.equal(storage.getItem(myselfChatKey(CWD)), null);
});

test("停止只作用于助理会话，并通过 settled 回调完成收尾", async (t) => {
	const bridge = new MockBridge();
	let callbacks = 0;
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		onSettled: () => {
			callbacks++;
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("记录任务");
	bridge.emit({ type: "agent_settled" }, "unrelated-session");
	assert.equal(controller.getSnapshot().running, true);
	await controller.abort();
	await flush();
	assert.equal(controller.getSnapshot().running, false);
	assert.equal(callbacks, 1);
	assert.ok(
		bridge.requests.some((request) => request.type === "session.abort" && request.sessionId === "shared-session"),
	);
});

test("读取当前日期失败时保留原话及意图供重试，不发送旧日程", async (t) => {
	const bridge = new MockBridge();
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		getScheduleContext: async () => {
			throw new Error("read failed");
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	assert.equal(await controller.send("安排今日", undefined, undefined, "plan"), false);
	assert.equal(controller.getSnapshot().error, "read failed");
	assert.equal(controller.getSnapshot().failedPrompt?.intent, "plan");
	assert.equal(controller.getSnapshot().busy, false);
	assert.equal(bridge.requests.length, 0);
});

test("断线期间完成的日程读取不能创建或发送旧一轮", async (t) => {
	const bridge = new MockBridge();
	const context = deferred<{ date: string; raw: string }>();
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		getScheduleContext: () => context.promise,
	});
	t.after(() => controller.dispose());
	await ready(controller);
	const pending = controller.send("记录任务");
	controller.setConnected(false);
	context.resolve({ date: "2026-10-08", raw: "" });
	assert.equal(await pending, false);
	assert.equal(bridge.requests.length, 0);
	assert.equal(controller.getSnapshot().ready, false);
});

test("保存失败呈现错误并解除忙碌，不让异常逃出桥事件", async (t) => {
	const bridge = new MockBridge();
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		onSettled: async () => {
			throw new Error("write failed");
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("记录任务");
	assert.doesNotThrow(() => bridge.settle());
	await flush();
	assert.equal(controller.getSnapshot().error, "write failed");
	assert.equal(controller.getSnapshot().busy, false);
});

test("专家复用路径保持首轮角色铺垫，不注入助理记录规则", async (t) => {
	const bridge = new MockBridge();
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "专家角色：", {
		keyPrefix: "owl.expert.chat",
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("分析设计");
	bridge.settle();
	await flush();
	await controller.send("继续分析");
	assert.deepEqual(
		bridge.prompts().map((request) => request.message),
		["专家角色：分析设计", "继续分析"],
	);
});

test("默认持久化前缀但没有日程callback的面试官保留角色，不套记录边界", async (t) => {
	const bridge = new MockBridge();
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "面试官角色：");
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("给这段反问打分");
	bridge.settle();
	await flush();
	await controller.send("继续评价");
	assert.deepEqual(
		bridge.prompts().map((prompt) => prompt.message),
		["面试官角色：给这段反问打分", "继续评价"],
	);
	assert.equal(
		bridge.prompts().some((prompt) => prompt.message.includes("本轮日程边界")),
		false,
	);
});

test("预设在空白会话选择，既有对话仅暂存下次预设；new清旧锁和消息metadata", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-08", raw: "" }),
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.refreshPresets();
	assert.equal(controller.getSnapshot().defaultPreset, "standard");
	assert.equal(controller.getSnapshot().agentPresets?.length, 2);
	assert.equal(await controller.setAgentPreset("minimal"), true);
	await controller.send("记录待办");
	bridge.settle();
	await flush();
	assert.equal(bridge.requests.find((request) => request.type === "session.create")?.agentPreset, "minimal");
	assert.equal(controller.getSnapshot().agentPreset, "minimal");
	assert.equal(controller.getSnapshot().agentPresetLocked, true);
	assert.equal(await controller.setAgentPreset("standard"), true);
	assert.equal(controller.getSnapshot().agentPreset, "minimal");
	assert.equal(
		bridge.requests.some((request) => request.type === "session.setPreset"),
		false,
	);
	bridge.emit({ type: "queue_update", steering: ["下一条"], followUp: ["后来一条"] });
	assert.equal(controller.newThread(), true);
	assert.equal(controller.getSnapshot().agentPreset, undefined);
	assert.equal(controller.getSnapshot().agentPresetLocked, false);
	assert.equal(controller.getSnapshot().nextAgentPreset, "standard");
	assert.deepEqual(controller.getSnapshot().queue, { steering: [], followUp: [] });
	assert.equal(controller.getSnapshot().paused, false);
	assert.equal(controller.getTurnContext("entry-0"), undefined);
	await controller.send("新会话记录");
	assert.equal(bridge.requests.filter((request) => request.type === "session.create").at(-1)?.agentPreset, "standard");
});

test("恢复空白会话可以setPreset，原始快照有隐藏消息则锁定预设", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	storage.setItem(myselfChatKey(CWD), "shared-session");
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "");
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.refreshPresets();
	assert.equal(await controller.setAgentPreset("minimal"), true);
	assert.equal(controller.getSnapshot().agentPreset, "minimal");
	assert.equal(bridge.requests.filter((request) => request.type === "session.setPreset").length, 1);
	controller.dispose();
	bridge.messages = [{ role: "custom", content: "隐藏续跑消息" }];
	const restored = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "");
	t.after(() => restored.dispose());
	await ready(restored);
	assert.equal(restored.getSnapshot().entries.length, 0);
	assert.equal(restored.getSnapshot().agentPresetLocked, true);
	assert.equal(await restored.setAgentPreset("standard"), true);
	assert.equal(restored.getSnapshot().agentPreset, "minimal");
	assert.equal(bridge.requests.filter((request) => request.type === "session.setPreset").length, 1);
});

test("再生成与编辑只回退对话，读取最新原日期并保留intent、图片与文件引用", async (t) => {
	const bridge = new MockBridge();
	let selected = "2026-10-07";
	const reads: string[] = [];
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		getScheduleContext: (date) => {
			const target = date ?? selected;
			reads.push(target);
			return { date: target, raw: `${target} 最新文件` };
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send(
		"执行原来那件事",
		[{ type: "image", data: "original-image", mimeType: "image/png" }],
		["资料.md"],
		"process",
	);
	bridge.settle();
	await flush();
	selected = "2026-10-09";
	assert.deepEqual(
		controller
			.getSnapshot()
			.entries.filter((entry) => entry.kind === "user")
			.map((entry) => entry.text),
		["执行原来那件事"],
	);
	assert.equal(await controller.regenerate(), true);
	assert.equal(bridge.requests.filter((request) => request.type === "rewind.execute").at(-1)?.mode, "conversation");
	let prompt = bridge.prompts().at(-1)!;
	let context = JSON.parse(
		prompt.message.split("\n", 1)[0]!.slice("<owl-myself-turn>".length, -"</owl-myself-turn>".length),
	);
	assert.equal(context.date, "2026-10-07");
	assert.equal(context.intent, "process");
	assert.deepEqual(prompt.attachedPaths, ["资料.md"]);
	assert.equal((prompt.images?.[0] as { data: string }).data, "original-image");
	assert.match(prompt.message, /2026-10-07 最新文件/);
	bridge.settle();
	await flush();
	assert.equal(
		await controller.editMessage("entry-0", "改成另一件事", [{ data: "edited-image", mimeType: "image/jpeg" }]),
		true,
	);
	prompt = bridge.prompts().at(-1)!;
	context = JSON.parse(
		prompt.message.split("\n", 1)[0]!.slice("<owl-myself-turn>".length, -"</owl-myself-turn>".length),
	);
	assert.equal(context.text, "改成另一件事");
	assert.equal(context.date, "2026-10-07");
	assert.equal(context.intent, "process");
	assert.deepEqual(prompt.attachedPaths, ["资料.md"]);
	assert.equal((prompt.images?.[0] as { data: string }).data, "edited-image");
	assert.deepEqual(reads, ["2026-10-07", "2026-10-07", "2026-10-07"]);
	assert.equal(
		bridge.requests.some(
			(request) => request.type === "fs.write" || (request.type === "rewind.execute" && request.mode === "both"),
		),
		false,
	);
});

test("SDK附件前置header的历史快照保留原话/date/intent，旧metadata也能从header恢复paths", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	storage.setItem(myselfChatKey(CWD), "shared-session");
	bridge.messages = [
		{
			role: "user",
			timestamp: Date.now(),
			content: [
				{
					type: "text",
					text: '[Attached files for this turn]\r\n- old-notes.md\r\n\r\n<owl-myself-turn>{"date":"2026-10-06","intent":"plan","text":"安排历史日期"}</owl-myself-turn>\n\n内部日程边界',
				},
			],
		},
		{ role: "assistant", content: [{ type: "text", text: "已安排" }], stopReason: "stop", timestamp: Date.now() },
	];
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: (date) => ({ date: date ?? "2026-10-08", raw: "旧日期最新文件" }),
	});
	t.after(() => controller.dispose());
	await ready(controller);
	assert.equal(controller.getSnapshot().entries[0]?.kind, "user");
	assert.equal((controller.getSnapshot().entries[0] as { text: string }).text, "安排历史日期");
	assert.deepEqual(controller.getTurnContext("entry-0"), { date: "2026-10-06", intent: "plan", text: "安排历史日期" });
	assert.equal(await controller.regenerate(), true);
	const prompt = bridge.prompts().at(-1)!;
	assert.deepEqual(prompt.attachedPaths, ["old-notes.md"]);
	assert.match(prompt.message, /"date":"2026-10-06"/);
	assert.match(prompt.message, /"intent":"plan"/);
});

test("分支只在idle创建并切换保存绑定，原历史与日程不回退，新绑定忽略原session事件", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-08", raw: "保留日程" }),
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("第一条");
	bridge.settle("第一条回答");
	await flush();
	await controller.send("还在运行");
	assert.equal(await controller.branch("entry-1"), false);
	assert.equal(
		bridge.requests.some((request) => request.type === "session.fork"),
		false,
	);
	bridge.settle("第二条回答");
	await flush();
	const original = structuredClone(bridge.messages);
	assert.equal(await controller.branch("entry-1"), true);
	assert.equal(controller.getSnapshot().sessionId, "forked-session");
	assert.equal(storage.getItem(myselfChatKey(CWD)), "forked-session");
	assert.deepEqual(bridge.forkSource, original);
	assert.deepEqual(
		controller
			.getSnapshot()
			.entries.filter((entry) => entry.kind === "user")
			.map((entry) => entry.text),
		["第一条"],
	);
	assert.equal(controller.getSnapshot().agentPresetLocked, true);
	const before = structuredClone(controller.getSnapshot().entries);
	bridge.emit({ type: "message_start", message: { role: "assistant", content: [] } }, "shared-session");
	assert.deepEqual(controller.getSnapshot().entries, before);
	assert.equal(
		bridge.requests.some((request) => request.type === "fs.write" || request.type === "rewind.execute"),
		false,
	);
});

test("回退拒绝或断线时不重发，分支断线响应不能改持久化绑定", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-08", raw: "" }),
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("原消息");
	bridge.settle();
	await flush();
	const before = structuredClone(controller.getSnapshot().entries);
	bridge.override = (request) =>
		request.type === "rewind.execute" ? { ok: false, error: "回退已被取消" } : undefined;
	assert.equal(await controller.regenerate(), false);
	assert.equal(bridge.prompts().length, 1);
	assert.deepEqual(controller.getSnapshot().entries, before);
	assert.equal(controller.getSnapshot().busy, false);
	assert.equal(controller.getSnapshot().error, "回退已被取消");
	const fork = deferred<Response>();
	bridge.override = (request) => (request.type === "session.fork" ? fork.promise : undefined);
	const pending = controller.branch("entry-1");
	controller.setConnected(false);
	fork.resolve({ ok: true, result: { ...bridge.snapshot(), sessionId: "stale-fork" } });
	assert.equal(await pending, false);
	assert.equal(storage.getItem(myselfChatKey(CWD)), "shared-session");
	assert.equal(controller.getSnapshot().sessionId, "shared-session");
});

test("误点新会话后跨刷新找回原对话，历史恢复不创建/发送且保留原日期意图附件", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const first = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-08", raw: "原日程" }),
	});
	await ready(first);
	await first.send(
		"今天的原对话",
		[{ type: "image", data: "kept-image", mimeType: "image/png" }],
		["notes.md"],
		"plan",
	);
	bridge.settle();
	await flush();
	const original = structuredClone(bridge.snapshot());
	assert.equal(first.newThread(), true);
	assert.equal(first.getSnapshot().previousSessionId, "shared-session");
	first.dispose();
	let settledCalls = 0;
	const recovered = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		getScheduleContext: () => ({ date: "2026-10-09", raw: "当前日程" }),
		onSettled: () => {
			settledCalls++;
		},
	});
	t.after(() => recovered.dispose());
	await ready(recovered);
	assert.equal(recovered.getSnapshot().previousSessionId, "shared-session");
	const user = original.messages[0] as { content: { text: string }[] };
	bridge.override = (request) =>
		request.type === "session.list"
			? {
					ok: true,
					result: [
						{
							id: "shared-session",
							cwd: CWD,
							created: "2026-10-08T00:00:00Z",
							modified: "2026-10-08T01:00:00Z",
							messageCount: 2,
							firstMessage: user.content[0]!.text,
							scope: "chat",
						},
						{ id: "foreign", cwd: "D:/another-project", firstMessage: "别的目录", scope: "chat" },
						{
							id: "archived",
							cwd: CWD,
							firstMessage: "归档记录",
							scope: "chat",
							archivedAt: "2026-10-08T02:00:00Z",
						},
						{ id: "research", cwd: CWD, firstMessage: "研究会话", scope: "research" },
					],
				}
			: request.type === "session.resume"
				? { ok: true, result: original }
				: undefined;
	const before = bridge.requests.length;
	await recovered.refreshHistory();
	assert.deepEqual(
		recovered.getSnapshot().history?.map((row) => [row.id, row.title]),
		[["shared-session", "今天的原对话"]],
	);
	assert.equal(await recovered.switchSession("shared-session"), true);
	assert.equal(recovered.getSnapshot().sessionId, "shared-session");
	assert.equal(storage.getItem(myselfChatKey(CWD)), "shared-session");
	const restored = recovered.getSnapshot().entries.find((entry) => entry.kind === "user");
	assert.ok(restored?.kind === "user");
	assert.equal(restored.text, "今天的原对话");
	assert.equal(restored.entryId, "entry-0");
	assert.deepEqual(restored.images, [{ data: "kept-image", mimeType: "image/png" }]);
	assert.deepEqual(recovered.getTurnContext("entry-0"), { date: "2026-10-08", intent: "plan", text: "今天的原对话" });
	assert.equal(settledCalls, 0);
	assert.equal(
		bridge.requests
			.slice(before)
			.some((request) => ["session.create", "session.prompt", "fs.write"].includes(request.type)),
		false,
	);
	const resumes = bridge.requests.filter((request) => request.type === "session.resume").length;
	assert.equal(await recovered.switchSession("shared-session"), true);
	assert.equal(bridge.requests.filter((request) => request.type === "session.resume").length, resumes);
});

test("历史恢复失败/跨目录/越角色不会覆盖当前有效会话和持久化绑定", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "");
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("当前有效会话");
	bridge.settle();
	await flush();
	const original = structuredClone(controller.getSnapshot().entries);
	const valid = { ...bridge.snapshot(), sessionId: "target" };
	for (const response of [
		{ ok: false, error: "目标会话已删除" },
		{ ok: true, result: { ...valid, cwd: "D:/other-project" } },
		{ ok: true, result: { ...valid, sessionId: "wrong-id" } },
		{ ok: true, result: { ...valid, researchMode: "general" } },
		{ ok: true, result: { ...valid, mailContext: {} } },
	]) {
		bridge.override = (request) => (request.type === "session.resume" ? response : undefined);
		assert.equal(await controller.switchSession("target"), false);
		assert.equal(controller.getSnapshot().sessionId, "shared-session");
		assert.equal(storage.getItem(myselfChatKey(CWD)), "shared-session");
		assert.deepEqual(controller.getSnapshot().entries, original);
		assert.equal(controller.getSnapshot().busy, false);
		assert.ok(controller.getSnapshot().historyError);
	}
});

test("历史已经恢复后运行查询失败只是刷新失败，不能返回恢复失败并留下busy", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "");
	t.after(() => controller.dispose());
	await ready(controller);
	const target = { ...bridge.snapshot(), sessionId: "target" };
	bridge.override = (request) => {
		if (request.type === "session.resume") return { ok: true, result: target };
		if (request.type === "session.running") throw new Error("running query failed");
		return undefined;
	};
	assert.equal(await controller.switchSession("target"), true);
	assert.equal(controller.getSnapshot().sessionId, "target");
	assert.equal(storage.getItem(myselfChatKey(CWD)), "target");
	assert.equal(controller.getSnapshot().busy, false);
	assert.equal(controller.getSnapshot().historyError, undefined);
});

test("历史恢复尾部遇到真实settled时保留日程落盘busy锁直到callback完成", async (t) => {
	const bridge = new MockBridge();
	const saved = deferred<void>();
	let calls = 0;
	const controller = new MyselfChatController(bridge, new MockStorage(), CWD, DEFAULTS, () => "", {
		onSettled: async () => {
			calls++;
			await saved.promise;
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	const target = { ...bridge.snapshot(), sessionId: "target", running: true };
	bridge.override = (request) => {
		if (request.type === "session.resume") return { ok: true, result: target };
		if (request.type === "session.running") {
			bridge.emit({ type: "agent_settled" }, "target");
			return { ok: true, result: { running: [] } };
		}
		return undefined;
	};
	assert.equal(await controller.switchSession("target"), true);
	assert.equal(calls, 1);
	assert.equal(controller.getSnapshot().busy, true);
	assert.equal(await controller.switchSession("another"), false);
	saved.resolve();
	await flush();
	assert.equal(controller.getSnapshot().busy, false);
});

test("运行/落盘时禁止切历史，恢复等待中断线丢弃迟到回包并保留旧消息", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	const saved = deferred<void>();
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		onSettled: () => saved.promise,
	});
	t.after(() => controller.dispose());
	await ready(controller);
	await controller.send("正在处理");
	assert.equal(await controller.switchSession("target"), false);
	bridge.settle();
	assert.equal(await controller.switchSession("target"), false);
	assert.equal(
		bridge.requests.some((request) => request.type === "session.resume"),
		false,
	);
	saved.resolve();
	await flush();
	const original = structuredClone(controller.getSnapshot().entries);
	const pending = deferred<Response>();
	bridge.override = (request) => (request.type === "session.resume" ? pending.promise : undefined);
	const switching = controller.switchSession("target");
	controller.setConnected(false);
	pending.resolve({ ok: true, result: { ...bridge.snapshot(), sessionId: "target" } });
	assert.equal(await switching, false);
	assert.equal(storage.getItem(myselfChatKey(CWD)), "shared-session");
	assert.equal(controller.getSnapshot().sessionId, "shared-session");
	assert.deepEqual(controller.getSnapshot().entries, original);
});

test("旧绑定失效也能选历史重新恢复，旧primer/命名envelope标题清洗且候选settled不落盘", async (t) => {
	const bridge = new MockBridge();
	const storage = new MockStorage();
	storage.setItem(myselfChatKey(CWD), "deleted-session");
	let restored = false;
	let callbacks = 0;
	const target = {
		...bridge.snapshot(),
		sessionId: "deleted-session",
		messages: [{ role: "user", content: [{ type: "text", text: "真正的历史事项" }] }],
		messageEntryIds: ["historic-user"],
	};
	bridge.override = (request) => {
		if (request.type === "session.resume") {
			if (!restored) return { ok: false, error: "旧绑定已失效" };
			bridge.emit({ type: "agent_settled" }, "deleted-session");
			return { ok: true, result: target };
		}
		if (request.type === "session.list")
			return {
				ok: true,
				result: [
					{
						id: "deleted-session",
						cwd: "D:\\OWL\\owl-myself",
						firstMessage: "你是用户的个人助理 Owl Si,运行在面板里。\n私有日程内容\n---\n真正的历史事项",
						name: "fork1 · 来自「<owl-myself-turn>截断的旧metadata」",
						modified: "2026-10-08T02:00:00Z",
						scope: "chat",
					},
					{
						id: "named",
						cwd: CWD,
						name: '<owl-myself-turn>{"date":"2026-10-08","intent":"record","text":"命名原话"}</owl-myself-turn>',
						firstMessage: "回退正文",
						scope: "chat",
					},
					{ id: "mail", cwd: CWD, name: "邮件", scope: "chat", customTypes: ["owl-mail-agent-context"] },
				],
			};
		return undefined;
	};
	const controller = new MyselfChatController(bridge, storage, CWD, DEFAULTS, () => "", {
		onSettled: () => {
			callbacks++;
		},
	});
	t.after(() => controller.dispose());
	await ready(controller);
	assert.equal(controller.getSnapshot().ready, false);
	assert.equal(controller.getSnapshot().previousSessionId, undefined);
	await controller.refreshHistory();
	assert.deepEqual(
		controller.getSnapshot().history?.map((row) => [row.id, row.title]),
		[
			["deleted-session", "真正的历史事项"],
			["named", "命名原话"],
		],
	);
	restored = true;
	assert.equal(await controller.switchSession("deleted-session"), true);
	assert.equal(controller.getSnapshot().ready, true);
	assert.equal(callbacks, 0);
	assert.equal(controller.getSnapshot().entries[0]?.kind, "user");
	assert.equal(
		bridge.requests.some((request) => ["session.create", "session.prompt", "fs.write"].includes(request.type)),
		false,
	);
});
