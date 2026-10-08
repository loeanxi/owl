/**
 * SDK 桥管理器与对话适配 —— 移植自 manager `bridge/SdkRuntimeManager`
 * + `SdkGatewayService`（CURSOR/COPILOT/QODER 三平台）。
 *
 * 账号进程按凭据指纹复用；目录回退清理与 gateway-sessions 工作区隔离；
 * chat 为回合制：start("chat") 后事件队列消费 text_delta/tool_call/usage/
 * done/error；工具调用即 DEFERRED 段（usage -1 哨兵），回合交还客户端。
 *
 * 工具调用先把回合停在桥上，下一次带 tool 结果的请求用 tool_result 续上，
 * 不再取消后整段重放。网关侧的 ContinuationRegistry 负责把续接钉回这个账号。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
	type Account,
	type AccountStore,
	GatewayFault,
	type Platform,
	parseCredentials,
	type UpstreamChatClient,
} from "owl-pool";
import { aggregateStreamToCompletion } from "./aggregate.ts";
import { latestToolResults } from "./continuation.ts";
import { type BridgeEvent, SdkRuntimeClient } from "./sdk-runtime.ts";

export interface SdkBridgeConfig {
	nodeExecutable: string;
	/** bridge/main.mjs 路径。 */
	script: string;
	/** 账号隔离根目录。 */
	homeRoot: string;
	/** 回合整体超时毫秒。 */
	requestTimeoutMs: number;
	/** 空闲回收毫秒（manager: 600s）。 */
	idleRecycleMs: number;
	userHome: string;
}

interface RuntimeEntry {
	fingerprint: string;
	client: SdkRuntimeClient;
}

export class SdkBridgeManager {
	readonly #config: SdkBridgeConfig;
	readonly #clients = new Map<string, RuntimeEntry>();
	#janitor: NodeJS.Timeout | undefined;

	constructor(config: SdkBridgeConfig, _accounts: AccountStore) {
		this.#config = config;
		// 空闲回收：30s 一查，无监听器且空闲超限即关进程
		this.#janitor = setInterval(() => {
			for (const [accountId, entry] of [...this.#clients]) {
				if (entry.client.idleFor(config.idleRecycleMs)) {
					this.#clients.delete(accountId);
					entry.client.close();
				}
			}
		}, 30_000);
		this.#janitor.unref();
	}

	stop(): void {
		if (this.#janitor !== undefined) {
			clearInterval(this.#janitor);
			this.#janitor = undefined;
		}
		for (const entry of this.#clients.values()) {
			entry.client.close();
		}
		this.#clients.clear();
	}

	/** 取账号运行时：凭据指纹一致且存活则复用，否则重建。 */
	async clientFor(account: Account): Promise<SdkRuntimeClient> {
		const credentials = parseCredentials(account);
		const fingerprint = `${account.platform}:${JSON.stringify(credentials)}`;
		const existing = this.#clients.get(account.id);
		if (existing !== undefined && existing.fingerprint === fingerprint && existing.client.isAlive()) {
			return existing.client;
		}
		this.invalidate(account.id);
		try {
			const client = await SdkRuntimeClient.create({
				nodeExecutable: this.#config.nodeExecutable,
				script: this.#config.script,
				platform: account.platform,
				account: account,
				accountHome: this.homeOf(account),
				credentials,
				userHome: this.#config.userHome,
			});
			this.#clients.set(account.id, { fingerprint, client });
			return client;
		} catch (error) {
			if (error instanceof GatewayFault) {
				throw error;
			}
			throw new GatewayFault(503, "runtime_not_installed", "平台运行组件不可用，请检查安装与启动配置");
		}
	}

	invalidate(accountId: string): void {
		const entry = this.#clients.get(accountId);
		if (entry !== undefined) {
			this.#clients.delete(accountId);
			entry.client.close();
		}
	}

	/** 账号目录必须位于配置根下且互不嵌套（链接逃逸一律拒绝）。 */
	homeOf(account: Account): string {
		const root = realpathSync(mkdirAndResolve(this.#config.homeRoot));
		const selected = resolve(root, account.platform.toLowerCase(), account.id);
		if (!selected.startsWith(root + (root.includes("\\") ? "\\" : "/")) || selected === root) {
			throw new GatewayFault(400, "account_home_outside_root", "账号目录必须位于配置的账号根目录下");
		}
		mkdirSync(selected, { recursive: true });
		return realpathSync(selected);
	}
}

function mkdirAndResolve(path: string): string {
	mkdirSync(path, { recursive: true });
	return realpathSync(path);
}

export interface SdkSegment {
	text: string;
	calls: Array<Record<string, unknown>>;
	usage: [number, number, number];
	source: "KNOWN" | "UNKNOWN" | "DEFERRED";
	finishReason: string;
	accountId: string;
}

interface PendingTool {
	publicId: string;
	runtimeId: string;
	turn: OpenTurn;
}

interface OpenTurn {
	id: string;
	owner: string;
	publicModel: string;
	accountId: string;
	queue: BridgeEvent[];
	chatId: string;
	client: SdkRuntimeClient;
	lastAccess: number;
	done?: Promise<BridgeEvent[]>;
}

/** 三平台的桥式 UpstreamChatClient（每平台一个实例，共享 manager）。 */
export class SdkBridgeChatClient implements UpstreamChatClient {
	readonly #manager: SdkBridgeManager;
	readonly #platform: Platform;
	readonly #config: SdkBridgeConfig;
	readonly #pendingTools = new Map<string, PendingTool>();

	constructor(manager: SdkBridgeManager, _accounts: AccountStore, platform: Platform, config: SdkBridgeConfig) {
		this.#manager = manager;
		this.#platform = platform;
		this.#config = config;
	}

	platform(): Platform {
		return this.#platform;
	}

	async chatCompletion(
		account: Account,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const { body } = await aggregateStreamToCompletion(this, account, payload, signal);
		return body;
	}

	async chatCompletionStream(
		account: Account,
		payload: Record<string, unknown>,
		onChunk: (chunkJson: string) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const id = segmentId();
		let roleSent = false;
		const sendDelta = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
			onChunk(JSON.stringify(chunkOf(id, payload.model, delta, finishReason)));
		};
		const segment = await this.awaitTurn(
			account,
			payload,
			(text) => {
				if (!roleSent) {
					roleSent = true;
					sendDelta({ role: "assistant" });
				}
				sendDelta({ content: text });
			},
			signal,
		);
		if (!roleSent) {
			sendDelta({ role: "assistant" });
		}
		// tool_calls 逐个、finish、usage（usage_source 审计口径）
		segment.calls.forEach((call, index) => {
			sendDelta({ tool_calls: [{ ...call, index }] });
		});
		sendDelta({}, segment.finishReason);
		onChunk(
			JSON.stringify({
				...chunkOf(id, payload.model, {}),
				choices: [],
				usage: usageOf(segment),
				usage_source: segment.source,
			}),
		);
	}

	/** 开回合并等待段结束（文本流式回调；工具调用即 DEFERRED 返回）。 */
	async awaitTurn(
		account: Account,
		payload: Record<string, unknown>,
		onText: (text: string) => void,
		signal?: AbortSignal,
	): Promise<SdkSegment> {
		signal?.throwIfAborted();
		const resumed = await this.#resume(account, payload, onText, signal);
		if (resumed !== null) {
			return resumed;
		}
		this.#dropParked(account.id);
		const client = await this.#manager.clientFor(account);
		signal?.throwIfAborted();
		const turnId = randomUUID();
		const command: Record<string, unknown> = { turnId, model: payload.model };
		for (const field of [
			"messages",
			"tools",
			"reasoning_effort",
			"max_tokens",
			"max_completion_tokens",
			"temperature",
			"top_p",
			"tool_choice",
			"parallel_tool_calls",
			"stop",
		]) {
			if (field in payload) {
				command[field] = payload[field];
			}
		}
		if (this.#platform === "QODER" && payload.context_window !== undefined) {
			command.context_window = payload.context_window;
		}
		if (
			command.reasoning_effort === undefined &&
			isMap(payload.reasoning) &&
			typeof payload.reasoning.effort === "string"
		) {
			command.reasoning_effort = payload.reasoning.effort;
		}
		const budget = payload.max_completion_tokens ?? payload.max_tokens;
		if (budget !== null && budget !== undefined) {
			command.outputTokenBudget = budget;
		}

		const turn: OpenTurn = {
			id: turnId,
			owner: "public",
			publicModel: String(payload.model ?? ""),
			accountId: account.id,
			queue: [],
			chatId: "",
			client,
			lastAccess: Date.now(),
		};

		const completion = new Promise<BridgeEvent[]>((resolveEvent, rejectEvent) => {
			turn.chatId = client.start("chat", command, (event) => {
				turn.lastAccess = Date.now();
				if (event.event === "result") {
					resolveEvent([event]);
				} else if (event.event === "error") {
					rejectEvent(failureOf(event));
				} else {
					turn.queue.push(event);
				}
			});
		});

		turn.done = completion;
		void completion.catch(() => {});
		return this.#awaitSegments(turn, completion, onText, client, signal);
	}

	async #resume(
		account: Account,
		payload: Record<string, unknown>,
		onText: (text: string) => void,
		signal?: AbortSignal,
	): Promise<SdkSegment | null> {
		const results = latestToolResults(payload);
		const ids = Object.keys(results);
		if (ids.length === 0) {
			return null;
		}
		const parked = ids.map((id) => this.#pendingTools.get(id));
		if (parked.some((item) => item === undefined)) {
			return null;
		}
		const turn = parked[0]!.turn;
		if (turn.accountId !== account.id || parked.some((item) => item!.turn !== turn) || turn.done === undefined) {
			return null;
		}
		for (const id of ids) {
			if (signal?.aborted) {
				this.#cancelQuietly(turn, turn.client);
				for (const [toolId, pending] of this.#pendingTools)
					if (pending.turn === turn) this.#pendingTools.delete(toolId);
				signal.throwIfAborted();
			}
			const pending = this.#pendingTools.get(id)!;
			const content = results[id];
			await turn.client.request(
				"tool_result",
				{
					turnId: turn.id,
					toolCallId: pending.runtimeId,
					content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
					isError: false,
				},
				this.#config.requestTimeoutMs,
			);
			this.#pendingTools.delete(id);
		}
		return this.#awaitSegments(turn, turn.done, onText, turn.client, signal);
	}

	#dropParked(accountId: string): void {
		for (const [id, pending] of this.#pendingTools) {
			if (pending.turn.accountId === accountId) {
				this.#cancelQuietly(pending.turn, pending.turn.client);
				this.#pendingTools.delete(id);
			}
		}
	}

	async #awaitSegments(
		turn: OpenTurn,
		completion: Promise<BridgeEvent[]>,
		onText: (text: string) => void,
		client: SdkRuntimeClient,
		signal?: AbortSignal,
	): Promise<SdkSegment> {
		const text: string[] = [];
		const calls: Array<Record<string, unknown>> = [];
		const usage: [number, number, number] = [-1, -1, -1];
		let source: SdkSegment["source"] = "UNKNOWN";
		let invalidUsage = false;
		let finishReason = "stop";
		const deadline = Date.now() + this.#config.requestTimeoutMs;
		for (;;) {
			if (signal?.aborted) {
				this.#cancelQuietly(turn, client);
				for (const [id, pending] of this.#pendingTools) if (pending.turn === turn) this.#pendingTools.delete(id);
				signal.throwIfAborted();
			}
			if (Date.now() > deadline) {
				this.#cancelQuietly(turn, client);
				throw new GatewayFault(504, "upstream_timeout", "模型响应超时");
			}
			const event = turn.queue.shift();
			if (event === undefined) {
				// 已收到工具调用且短暂静默 → DEFERRED 段交还客户端
				if (calls.length > 0) {
					return {
						text: text.join(""),
						calls,
						usage: [-1, -1, -1],
						source: "DEFERRED",
						finishReason: "tool_calls",
						accountId: turn.accountId,
					};
				}
				// result 事件已到 → 收尾
				const settled = await Promise.race([
					completion.then(() => "done" as const),
					new Promise<"wait">((resolveWait) => setTimeout(() => resolveWait("wait"), 25)),
				]);
				if (settled === "done") {
					this.#cancelQuietly(turn, client);
					return { text: text.join(""), calls, usage, source, finishReason, accountId: turn.accountId };
				}
				continue;
			}
			turn.lastAccess = Date.now();
			const type = event.event;
			if (type === "text_delta") {
				const delta = typeof event.text === "string" ? event.text : "";
				if (delta.length > 0) {
					text.push(delta);
					onText(delta);
				}
			} else if (type === "tool_call") {
				const runtimeId = String(event.toolCallId ?? "");
				const name = String(event.name ?? "");
				if (runtimeId.length === 0 || name.length === 0) {
					this.#cancelQuietly(turn, client);
					throw new GatewayFault(502, "invalid_tool_call", "模型返回的工具调用格式无效");
				}
				const publicId = `call_gw_${randomUUID().replaceAll("-", "")}`;
				this.#pendingTools.set(publicId, { publicId, runtimeId, turn });
				calls.push({
					id: publicId,
					type: "function",
					function: {
						name,
						arguments:
							typeof event.arguments === "string" ? event.arguments : JSON.stringify(event.arguments ?? {}),
					},
				});
			} else if (type === "usage") {
				if (event.inputTokens == null && event.outputTokens == null && event.usageSource === undefined) continue;
				const input = tokenCount(event.inputTokens),
					output = tokenCount(event.outputTokens);
				if (
					input < 0 ||
					output < 0 ||
					!Number.isSafeInteger(input + output) ||
					(event.usageSource !== undefined && event.usageSource !== "KNOWN")
				) {
					invalidUsage = true;
					usage.fill(-1);
					source = "UNKNOWN";
				} else if (!invalidUsage) {
					usage[0] = input;
					usage[1] = output;
					usage[2] = input + output;
					source = "KNOWN";
				}
			} else if (type === "done") {
				if (typeof event.finishReason === "string" && event.finishReason.length > 0) {
					finishReason = event.finishReason;
				}
				this.#cancelQuietly(turn, client);
				return { text: text.join(""), calls, usage, source, finishReason, accountId: turn.accountId };
			}
			// 其余事件类型无输出语义
		}
	}

	#cancelQuietly(turn: OpenTurn, client: SdkRuntimeClient): void {
		try {
			client.start("cancel", { turnId: turn.id }, () => {});
		} catch {
			// 进程已亡时忽略
		}
	}
}

function isMap(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function usageOf(segment: SdkSegment): Record<string, unknown> {
	return { prompt_tokens: segment.usage[0], completion_tokens: segment.usage[1], total_tokens: segment.usage[2] };
}

function chunkOf(
	id: string,
	model: unknown,
	delta: Record<string, unknown>,
	finishReason: string | null = null,
): Record<string, unknown> {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: String(model ?? ""),
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function segmentId(): string {
	return `chatcmpl_${randomUUID().replaceAll("-", "")}`;
}

function failureOf(event: BridgeEvent): GatewayFault {
	return new GatewayFault(503, "runtime_unavailable", String(event.code ?? "模型服务暂时不可用"));
}
