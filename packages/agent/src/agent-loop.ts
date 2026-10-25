/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	type SystemMessage,
	type ToolResultMessage,
	type ToolStateChanges,
	toToolDeclaration,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const initialMessages = declareToolChanges(context, prompts);
	const newMessages: AgentMessage[] = [...initialMessages];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...initialMessages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of initialMessages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let explicitContinuation = false;
	let toolExecutions = 0;
	let truncatedToolResponses = 0;
	const failedUnknownTools = new Set<string>();
	const failedCallKeys = new Map<string, number>();
	let finalAnswerOnly = false;
	let stopRequest: AgentMessage | undefined;
	const requestedToolLimit = initialConfig.maxToolExecutions;
	const maxToolExecutions =
		typeof requestedToolLimit === "number" && Number.isSafeInteger(requestedToolLimit) && requestedToolLimit > 0
			? requestedToolLimit
			: DEFAULT_MAX_TOOL_EXECUTIONS;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
	const resetToolGuards = (): void => {
		finalAnswerOnly = false;
		stopRequest = undefined;
		toolExecutions = 0;
		truncatedToolResponses = 0;
		failedUnknownTools.clear();
		failedCallKeys.clear();
	};

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			let preparedMessages: AgentMessage[] = [];
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					preparedMessages = nextTurnSnapshot.messages ?? [];
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
					if (pendingMessages.length > 0) resetToolGuards();
				}
				await emit({ type: "turn_start" });
			}

			// Process prepared and queued messages before the next assistant response.
			for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				currentContext.messages.push(message);
				newMessages.push(message);
			}
			pendingMessages = [];

			const requestUpdate = await config.prepareRequest?.(
				{
					context: currentContext,
					model: config.model,
					thinkingLevel: config.reasoning ?? "off",
				},
				signal,
			);
			if (requestUpdate) {
				currentContext = requestUpdate.context ?? currentContext;
				config = {
					...config,
					model: requestUpdate.model ?? config.model,
					reasoning:
						requestUpdate.thinkingLevel === undefined
							? config.reasoning
							: requestUpdate.thinkingLevel === "off"
								? undefined
								: requestUpdate.thinkingLevel,
				};
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lastCompletedTurn = {
					message,
					toolResults: [],
					context: currentContext,
					newMessages,
				};
				await config.finishTurn?.(lastCompletedTurn, signal);
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			truncatedToolResponses =
				message.stopReason === "length" && toolCalls.length > 0 ? truncatedToolResponses + 1 : 0;

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// Discovery may have made a previously missing tool available since the last request.
				for (const tool of currentContext.tools ?? []) failedUnknownTools.delete(tool.name);
				const closing = finalAnswerOnly;
				const refusal = explainToolRefusal(toolCalls, {
					finalAnswerOnly,
					toolExecutions,
					maxToolExecutions,
					truncatedToolResponses,
					failedUnknownTools,
					failedCallKeys,
				});
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch = refusal
					? await refuseToolCalls(toolCalls, refusal.toolMessage, emit)
					: message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !refusal && !executedToolBatch.terminate;
				if (!refusal) {
					// A truncated response never executed: do not blacklist the complete retry
					// that its error message explicitly asks the model to send.
					if (message.stopReason !== "length") {
						toolExecutions += toolResults.length;
						rememberToolFailures(message, toolResults, failedUnknownTools, failedCallKeys);
					}
				} else if (!closing) {
					finalAnswerOnly = true;
					stopRequest = {
						role: "user",
						content: refusal.userMessage,
						timestamp: Date.now(),
					};
				}

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const decision = await config.finishTurn?.(lastCompletedTurn, signal);
			await emit({ type: "turn_end", message, toolResults });

			if (decision?.action === "end" || signal?.aborted) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			explicitContinuation = !finalAnswerOnly && decision?.action === "continue";
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (pendingMessages.length > 0) {
				// A real user steer starts a fresh budget. Drop the synthetic stop.
				resetToolGuards();
			} else if (stopRequest) {
				pendingMessages = [stopRequest];
				stopRequest = undefined;
				hasMoreToolCalls = true;
			}
			if (hasMoreToolCalls || pendingMessages.length > 0) {
				explicitContinuation = false;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them. A new user message gets its own tool budget.
			explicitContinuation = false;
			resetToolGuards();
			pendingMessages = followUpMessages;
			continue;
		}

		// No natural request was selected, so fulfill the continuation decision with one context-only turn.
		if (explicitContinuation) {
			explicitContinuation = false;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Declare tool loadout changes to the model.
 *
 * `context.tools` is what the runtime can execute; the transcript's system messages declare
 * what the model may call. Before each request the difference becomes `toolsAdded` and
 * `toolsRemoved` on a system message. When a pending system message exists, its tool fields
 * are treated as intent and replaced with the delta between the committed transcript and
 * the executable set, so replay always yields exactly `context.tools`. Otherwise a new
 * system message is inserted before the first non-system pending message.
 */
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	let systemIndex = -1;
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		if (pendingMessages[i].role === "system") {
			systemIndex = i;
			break;
		}
	}
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	const baseline = pending
		? pendingMessages.map((message, index) =>
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: pendingMessages;
	const changes = getToolStateChanges(
		getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(toToolDeclaration),
	);
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	if (pending) {
		// Keep the caller's message object when it already declares no tool changes.
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return pendingMessages;
		return baseline.map((message, index) => (index === systemIndex ? withToolChanges(pending, changes) : message));
	}
	if (unchanged) return pendingMessages;
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	const llmContext = normalizeContext({ messages: llmMessages });

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// 首包看门狗：模型请求在时限内一个流事件都没有（连 start/thinking 都没有），
	// 判定为无响应挂死——中止底层请求并合成为 stopReason "error" 的助手消息，
	// 让失败进入既有 model_error 失败记录管线，而不是永远停在"等待模型响应"。
	const firstPacketTimeoutMs = config.firstPacketTimeoutMs ?? DEFAULT_FIRST_PACKET_TIMEOUT_MS;
	const watchdog = new AbortController();
	let watchdogFired = false;
	watchdog.signal.addEventListener("abort", () => {
		watchdogFired = true;
	});
	let firstPacketTimer: ReturnType<typeof setTimeout> | undefined;
	// 用户主动中止（signal）优先级高于看门狗：只有看门狗单独触发时才改写为 error。
	const watchdogOnly = () => watchdogFired && !signal?.aborted;
	const firstPacketError = (): AssistantMessage => ({
		role: "assistant",
		content: [],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		thinkingLevel: config.reasoning ?? "off",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: `模型 ${config.model.provider}/${config.model.id} 在 ${Math.round(
			firstPacketTimeoutMs / 1000,
		)}s 内没有返回任何流事件（疑似无响应或网络挂起），已中止本轮。`,
		timestamp: Date.now(),
	});

	// 首包竞速：streamFn 的返回与第一个流事件都要和看门狗赛跑。
	// 不依赖底层流响应 abort 信号——任何实现的挂死都会被合成的错误消息兜住。
	const timeoutPromise =
		firstPacketTimeoutMs > 0
			? new Promise<never>((_, reject) => {
					firstPacketTimer = setTimeout(() => {
						watchdog.abort();
						reject(new Error(`模型首包超时（${firstPacketTimeoutMs}ms）`));
					}, firstPacketTimeoutMs);
				})
			: undefined;

	try {
		const runStreamFn = () =>
			streamFunction(config.model, llmContext, {
				...config,
				apiKey: resolvedApiKey,
				signal: signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal,
			});
		const response = await (timeoutPromise ? Promise.race([runStreamFn(), timeoutPromise]) : runStreamFn());
		// Record the requested level, whichever stream function answered.
		const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

		let partialMessage: AssistantMessage | null = null;
		let addedPartial = false;

		const iterator = (response as AsyncIterable<AssistantMessageEvent>)[Symbol.asyncIterator]();
		let step = timeoutPromise ? await Promise.race([iterator.next(), timeoutPromise]) : await iterator.next();
		if (firstPacketTimer !== undefined) {
			clearTimeout(firstPacketTimer);
			firstPacketTimer = undefined;
		}
		while (!step.done) {
			const event = step.value;
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;

				case "done":
				case "error": {
					if (watchdogOnly()) {
						const overridden = firstPacketError();
						if (addedPartial) {
							context.messages[context.messages.length - 1] = overridden;
						} else {
							context.messages.push(overridden);
						}
						if (!addedPartial) {
							await emit({ type: "message_start", message: overridden });
						}
						await emit({ type: "message_end", message: overridden });
						return overridden;
					}
					const finalMessage = await result();
					constrainAssistantToolCalls(finalMessage, context.tools);
					if (addedPartial) {
						context.messages[context.messages.length - 1] = finalMessage;
					} else {
						context.messages.push(finalMessage);
					}
					if (!addedPartial) {
						await emit({ type: "message_start", message: { ...finalMessage } });
					}
					await emit({ type: "message_end", message: finalMessage });
					return finalMessage;
				}
			}
			step = await iterator.next();
		}

		const finalMessage = await result();
		constrainAssistantToolCalls(finalMessage, context.tools);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return finalMessage;
	} catch (error) {
		if (watchdogOnly()) {
			const message = firstPacketError();
			context.messages.push(message);
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			return message;
		}
		throw error;
	} finally {
		if (firstPacketTimer !== undefined) clearTimeout(firstPacketTimer);
	}
}

/**
 * Successful work has no implicit lifetime cap. Callers can opt into a positive
 * maxToolExecutions budget; repeated failures and per-message flood guards remain active.
 */
export const DEFAULT_MAX_TOOL_EXECUTIONS = Number.POSITIVE_INFINITY;

/**
 * 首包看门狗默认时限：模型请求在这个时间内连一个流事件都没有，就按无响应挂死处理。
 * 只守首包（收到第一个事件即撤防），长回复本身不受影响。
 */
export const DEFAULT_FIRST_PACKET_TIMEOUT_MS = 120_000;

type ToolRefusal = {
	toolMessage: string;
	userMessage: string;
};

function explainToolRefusal(
	toolCalls: AgentToolCall[],
	state: {
		finalAnswerOnly: boolean;
		toolExecutions: number;
		maxToolExecutions: number;
		truncatedToolResponses: number;
		failedUnknownTools: ReadonlySet<string>;
		failedCallKeys: ReadonlyMap<string, number>;
	},
): ToolRefusal | undefined {
	if (toolCalls.length === 0) return undefined;
	if (state.finalAnswerOnly) {
		return {
			toolMessage: "本轮已经要求停止调用工具。这些调用没有执行。",
			userMessage: "",
		};
	}
	if (state.toolExecutions + toolCalls.length > state.maxToolExecutions) {
		return {
			toolMessage: `本轮工具调用预算为 ${state.maxToolExecutions} 次，已使用 ${state.toolExecutions} 次；剩余额度不足以执行本批 ${toolCalls.length} 次调用，这些调用没有执行。`,
			userMessage: `剩余工具调用预算不足以执行本批操作（本轮上限 ${state.maxToolExecutions} 次，已使用 ${state.toolExecutions} 次）。不要再调用任何工具。用用户的语言用几句话说明：已经确认的事实、还没做成的部分、一个下一步。`,
		};
	}
	if (state.truncatedToolResponses >= 3) {
		return {
			toolMessage: "工具调用连续 3 次被输出上限截断，未执行任何不完整调用；本轮已停止工具执行。",
			userMessage:
				"工具参数连续被输出上限截断。不要再调用工具，也不要声称完成；说明已完成的部分和阻塞，建议缩小单次工具参数或调整输出预算后继续。",
		};
	}
	if (toolCalls.some((call) => state.failedUnknownTools.has(call.name))) {
		const names = [
			...new Set(toolCalls.map((call) => call.name).filter((name) => state.failedUnknownTools.has(name))),
		];
		return {
			toolMessage: `工具 ${names.join(", ")} 在本轮已经确认不存在，这些调用没有执行。`,
			userMessage:
				"你又调用了本轮已经确认不存在的工具。不要再调用任何工具，也不要再猜工具名。用用户的语言说明卡在哪里，以及用现有工具能做的下一步。",
		};
	}
	const retries = new Map<string, number>();
	if (
		toolCalls.some((call) => {
			const key = toolCallKey(call.name, call.arguments);
			const failed = state.failedCallKeys.get(key) ?? 0;
			const requested = (retries.get(key) ?? 0) + 1;
			retries.set(key, requested);
			return failed > 0 && failed + requested > 3;
		})
	) {
		return {
			toolMessage: "同一调用已达到失败重试上限，或本批重复调用将超出 3 次尝试，没有再次执行。",
			userMessage:
				"你在重复一组已经失败的工具参数。不要再调用任何工具。用用户的语言说明这次失败的原因，以及需要用户决定的下一步。",
		};
	}
	return undefined;
}

function toolCallKey(name: string, args: unknown): string {
	return `${name}\n${stableValue(args)}`;
}

function stableValue(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => stableValue(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
		.join(",")}}`;
}

function toolResultText(message: ToolResultMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((block) => (block.type === "text" && "text" in block ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function rememberToolFailures(
	assistant: AssistantMessage,
	results: ToolResultMessage[],
	unknownTools: Set<string>,
	failedKeys: Map<string, number>,
): void {
	const calls = new Map(
		assistant.content.filter((block) => block.type === "toolCall").map((block) => [block.id, block]),
	);
	// A successful file repair starts a fresh verification window. Reads and polls
	// must not clear unrelated failed attempts. Record this batch's failures below
	// so parallel repairs cannot hide a simultaneous failure.
	if (results.some((result) => !result.isError && ["edit", "write", "apply_patch"].includes(result.toolName)))
		failedKeys.clear();
	for (const result of results) {
		const call = calls.get(result.toolCallId);
		if (!call) continue;
		const key = toolCallKey(call.name, call.arguments);
		if (!result.isError) {
			failedKeys.delete(key);
			continue;
		}
		const unknownName = /^Tool ([^\s.]+) not found\b/.exec(toolResultText(result))?.[1];
		if (unknownName) {
			unknownTools.add(unknownName);
			continue;
		}
		failedKeys.set(key, (failedKeys.get(key) ?? 0) + 1);
		if (failedKeys.size > 100) failedKeys.delete(failedKeys.keys().next().value!);
	}
}

async function refuseToolCalls(
	toolCalls: AgentToolCall[],
	reason: string,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(reason),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/** One assistant message may run at most this many tool calls. A larger batch is not executed. */
const MAX_TOOL_CALLS_PER_MESSAGE = 16;
/** Unknown tool names may appear at most this many times before the whole batch is refused. */
const MAX_UNKNOWN_TOOL_CALLS_PER_MESSAGE = 3;

/**
 * Collapse a tool-call flood before the message is persisted or executed.
 *
 * Duplicate calls to the same unknown name keep the first one. A batch larger than
 * {@link MAX_TOOL_CALLS_PER_MESSAGE}, or with more than {@link MAX_UNKNOWN_TOOL_CALLS_PER_MESSAGE}
 * unknown calls, drops every tool call and records one explanation on the assistant
 * message. That keeps the transcript from storing one full error per hallucinated call.
 */
function constrainAssistantToolCalls(message: AssistantMessage, tools: readonly AgentTool<any>[] | undefined): void {
	if (message.stopReason === "error" || message.stopReason === "aborted") return;
	const toolCalls = message.content.filter((block) => block.type === "toolCall");
	if (toolCalls.length === 0) return;

	const known = new Set((tools ?? []).map((tool) => tool.name));
	const unknownCalls = toolCalls.filter((call) => !known.has(call.name));
	if (toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE || unknownCalls.length > MAX_UNKNOWN_TOOL_CALLS_PER_MESSAGE) {
		const unknownNames = [...new Set(unknownCalls.map((call) => call.name))];
		const available = [...known].join(", ") || "(none)";
		const reason =
			toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE
				? `This response contained ${toolCalls.length} tool calls, over the limit of ${MAX_TOOL_CALLS_PER_MESSAGE}. None were executed.`
				: `This response contained ${unknownCalls.length} calls to tools that are not registered, over the limit of ${MAX_UNKNOWN_TOOL_CALLS_PER_MESSAGE}. None were executed.`;
		const unknownNote = unknownNames.length > 0 ? ` Unknown names: ${unknownNames.join(", ")}.` : "";
		message.content = [
			...message.content.filter((block) => block.type !== "toolCall"),
			{
				type: "text",
				text: `${reason}${unknownNote} Available tools: ${available}. Don't guess other tool names; search file content with bash (grep/rg) and locate files with bash (find/ls).`,
			},
		];
		if (message.stopReason === "toolUse") message.stopReason = "stop";
		return;
	}

	const seenUnknown = new Set<string>();
	const dropped = new Set<(typeof toolCalls)[number]>();
	for (const call of toolCalls) {
		if (known.has(call.name)) continue;
		if (seenUnknown.has(call.name)) dropped.add(call);
		else seenUnknown.add(call.name);
	}
	if (dropped.size === 0) return;
	message.content = message.content.filter((block) => block.type !== "toolCall" || !dropped.has(block));
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		// 模型高频凭训练习惯猜工具名（grep/symbol_search 等）；只回一句 not found 会让它
		// 换个名字继续猜。给出可用清单和搜索替代路径，让模型第一次失败就回到 bash。
		const available = tools.map((t) => t.name).join(", ");
		return {
			kind: "immediate",
			result: createErrorToolResult(
				`Tool ${toolCall.name} not found. Available tools: ${available || "(none)"}. Don't guess other tool names; search file content with bash (grep/rg) and locate files with bash (find/ls).`,
			),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				result.details = { toolExecutionBlocked: true };
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: AgentContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
