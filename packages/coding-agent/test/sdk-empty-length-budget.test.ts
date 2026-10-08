import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { streamSimple as anthropicStreamSimple } from "../../ai/src/api/anthropic-messages.ts";
import { streamSimple as openaiStreamSimple } from "../../ai/src/api/openai-completions.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { defineTool } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createTaskCheckExtension } from "../src/extensions/task-check/index.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});
type Response = { kind: "length" | "empty" | "done" } | { kind: "action"; phase: string };

async function setup(
	options: {
		settings?: Partial<Settings>;
		maxTokens?: number;
		reasoning?: boolean;
		projectRequestMaxTokens?: number;
		budgetDialect?: boolean;
		thinking?: "max" | "off";
		api?: "openai-completions" | "anthropic-messages";
		guard?: boolean;
	} = {},
) {
	const temp = mkdtempSync(join(tmpdir(), "owl-recovery-budget-"));
	const cwd = join(temp, "project");
	const agentDir = join(temp, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const model: Model<Api> = {
		id: "budget-model",
		name: "Budget Fixture",
		provider: "budget-fixture",
		api: options.api ?? "openai-completions",
		baseUrl: "https://offline.invalid/v1",
		reasoning: options.reasoning ?? true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: options.maxTokens ?? 128000,
		...(options.budgetDialect
			? { compat: { supportsThinkingTokenBudget: true, maxTokensField: "max_tokens" as const } }
			: {}),
		thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", max: "max" },
	};
	const secondModel = { ...model, id: "budget-model-2" };
	const settings: Settings = {
		cacheWarming: "off",
		defaultThinkingLevel: options.thinking ?? "max",
		compaction: { enabled: false },
		retry: { enabled: false },
		...options.settings,
	};
	const manager =
		options.projectRequestMaxTokens === undefined
			? SettingsManager.inMemory(settings)
			: SettingsManager.fromStorage({
					withLock(scope, callback) {
						callback(
							JSON.stringify(
								scope === "global" ? settings : { requestMaxTokens: options.projectRequestMaxTokens },
							),
						);
					},
				});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: manager,
		extensionFactories: options.guard ? [createTaskCheckExtension()] : [],
	});
	await loader.reload();
	const auth = AuthStorage.create(join(agentDir, "auth.json"));
	await auth.modify(model.provider, async () => ({ type: "api_key", key: "offline-fixture" }));
	const registry = await createModelRegistry(auth, join(agentDir, "models.json"));
	let responses: Response[] = [];
	let transportCalls = 0;
	const records: string[] = [];
	const calls: Array<{ model: string; sdkMaxTokens?: number; rawMaxTokens?: number; thinking?: string }> = [];
	let requestHook: ((index: number, session: AgentSession) => void | Promise<void>) | undefined;
	registry.registerProvider(model.provider, {
		api: model.api,
		models: [model, secondModel],
		streamSimple(requestModel, context, providerOptions) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				let rawMaxTokens: number | undefined;
				let thinking: string | undefined;
				const captureOptions = {
					...providerOptions,
					apiKey: "offline-fixture",
					onPayload(payload: unknown) {
						if (typeof payload !== "object" || payload === null) throw Error("Invalid offline payload");
						if ("max_tokens" in payload && typeof payload.max_tokens === "number")
							rawMaxTokens = payload.max_tokens;
						if ("max_completion_tokens" in payload && typeof payload.max_completion_tokens === "number")
							rawMaxTokens = payload.max_completion_tokens;
						if ("reasoning_effort" in payload && typeof payload.reasoning_effort === "string")
							thinking = payload.reasoning_effort;
						throw Error("OFFLINE_PAYLOAD_CAPTURE");
					},
					fetch: async () => {
						transportCalls++;
						throw Error("Network disabled");
					},
				};
				if (requestModel.api === "openai-completions")
					await openaiStreamSimple(requestModel as Model<"openai-completions">, context, captureOptions).result();
				else
					await anthropicStreamSimple(
						requestModel as Model<"anthropic-messages">,
						context,
						captureOptions,
					).result();
				calls.push({ model: requestModel.id, sdkMaxTokens: providerOptions?.maxTokens, rawMaxTokens, thinking });
				await requestHook?.(calls.length, session);
				const response = responses.shift();
				if (!response) {
					stream.end({
						...fauxAssistantMessage("Unexpected extra fixture request", { stopReason: "error" }),
						api: requestModel.api,
						model: requestModel.id,
						provider: requestModel.provider,
					});
					return;
				}
				const body =
					response.kind === "length"
						? fauxThinking("Thinking only")
						: response.kind === "empty"
							? ""
							: response.kind === "action"
								? fauxToolCall("record", { phase: response.phase })
								: "done";
				stream.end({
					...fauxAssistantMessage(body, {
						stopReason:
							response.kind === "length" || response.kind === "empty"
								? "length"
								: response.kind === "action"
									? "toolUse"
									: "stop",
					}),
					api: requestModel.api,
					model: requestModel.id,
					provider: requestModel.provider,
				});
			})();
			return stream;
		},
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: options.thinking ?? "max",
		modelRuntime: getModelRuntime(registry),
		settingsManager: manager,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader: loader,
		tools: ["record"],
		customTools: [
			defineTool({
				name: "record",
				label: "Record",
				description: "Offline completed side effect",
				parameters: Type.Object({ phase: Type.String() }),
				async execute(_id, params) {
					records.push(params.phase);
					return { content: [{ type: "text", text: `Recorded ${params.phase}` }], details: undefined };
				},
			}),
		],
	});
	cleanup.push(() => {
		session.dispose();
		registry.unregisterProvider(model.provider);
		rmSync(temp, { recursive: true, force: true });
	});
	return {
		session,
		manager,
		calls,
		records,
		secondModel,
		transportCalls: () => transportCalls,
		pending: () => responses.length,
		respond: (items: Response[]) => {
			responses = items.slice();
		},
		hook: (callback: typeof requestHook) => {
			requestHook = callback;
		},
	};
}

const sequence: Response[] = [
	{ kind: "action", phase: "before" },
	{ kind: "length" },
	{ kind: "action", phase: "after" },
	{ kind: "done" },
];

describe("default-only output budget after thinking-only truncation", () => {
	it("raises only the remaining current-user SDK/payload budget and preserves completed effects and thinking", async () => {
		const fixture = await setup();
		fixture.respond(sequence);
		await fixture.session.prompt("Complete the authorized local task.");
		expect(fixture.calls.map((call) => call.sdkMaxTokens)).toEqual([16384, 16384, 32768, 32768]);
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 32768, 32768]);
		expect(fixture.calls.every((call) => call.thinking === "max")).toBe(true);
		expect(fixture.session.thinkingLevel).toBe("max");
		expect(fixture.manager.getSettings().requestMaxTokens).toBeUndefined();
		expect(fixture.records).toEqual(["before", "after"]);
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(fixture.transportCalls()).toBe(0);
	});

	it.each([16384, 4096])("keeps explicitly configured cap %s unchanged", async (requestMaxTokens) => {
		const fixture = await setup({ settings: { requestMaxTokens } });
		fixture.respond(sequence);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([
			requestMaxTokens,
			requestMaxTokens,
			requestMaxTokens,
			requestMaxTokens,
		]);
	});

	it("protects explicit SDK stream caps", async () => {
		const fixture = await setup();
		const previous = fixture.session.agent.streamFunction;
		fixture.session.agent.streamFunction = (model, context, options) =>
			previous(model, context, { ...options, maxTokens: 4096 });
		fixture.respond(sequence);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([4096, 4096, 4096, 4096]);
	});

	it("does not earn uplift from a failure explicitly capped by its SDK caller", async () => {
		const fixture = await setup();
		const previous = fixture.session.agent.streamFunction;
		fixture.session.agent.streamFunction = (model, context, options) =>
			previous(model, context, fixture.calls.length === 1 ? { ...options, maxTokens: 4096 } : options);
		fixture.respond(sequence);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 4096, 16384, 16384]);
	});

	it("keeps a raw project output cap authoritative", async () => {
		const fixture = await setup({ projectRequestMaxTokens: 4096 });
		fixture.respond(sequence);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.manager.getGlobalSettings().requestMaxTokens).toBeUndefined();
		expect(fixture.manager.getProjectSettings().requestMaxTokens).toBe(4096);
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([4096, 4096, 4096, 4096]);
	});

	it("does not raise the budget for an empty length response without positive thinking evidence", async () => {
		const fixture = await setup();
		fixture.respond([{ kind: "empty" }, { kind: "done" }]);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384]);
	});

	it("bounds uplift by the model's output capability", async () => {
		const fixture = await setup({ maxTokens: 20000 });
		fixture.respond(sequence);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 20000, 20000]);
	});

	it("yields the temporary ceiling when a new fixed-thinking budget needs more answer room", async () => {
		const fixture = await setup({ budgetDialect: true });
		const previous = fixture.session.agent.streamFunction;
		fixture.session.agent.streamFunction = (model, context, options) =>
			previous(
				model,
				context,
				fixture.calls.length === 3 ? { ...options, thinkingBudgets: { high: 65536 } } : options,
			);
		fixture.respond([...sequence.slice(0, 3), { kind: "action", phase: "explicit-thinking" }, { kind: "done" }]);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([17408, 17408, 32768, 66560, 17408]);
		expect(fixture.calls.every((call) => call.thinking === "max")).toBe(true);
	});

	it("does not lower an already larger default SDK budget and call that an uplift", async () => {
		const fixture = await setup({ budgetDialect: true, settings: { thinkingBudgets: { high: 65536 } } });
		fixture.respond(sequence);
		await fixture.session.prompt("Complete the local task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([66560, 66560, 66560, 66560]);
	});

	it.each([{ reasoning: false }, { thinking: "off" as const }, { api: "anthropic-messages" as const }])(
		"keeps existing recovery without uplift outside the observed positive-thinking API path: %j",
		async (options) => {
			const fixture = await setup(options);
			fixture.respond(sequence);
			await fixture.session.prompt("Complete the local task.");
			expect(fixture.calls.map((call) => call.sdkMaxTokens)).toEqual([16384, 16384, 16384, 16384]);
		},
	);

	it("resets uplift on a fresh real user request", async () => {
		const fixture = await setup();
		fixture.respond(sequence);
		await fixture.session.prompt("First task.");
		fixture.respond([{ kind: "done" }]);
		await fixture.session.prompt("Second task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 32768, 32768, 16384]);
	});

	it("ends incomplete on a second length response without another escalation", async () => {
		const fixture = await setup();
		fixture.respond([{ kind: "length" }, { kind: "length" }, { kind: "done" }]);
		const settled: boolean[] = [];
		fixture.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.push(event.aborted);
		});
		await fixture.session.prompt("Task that cannot yet complete.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 32768]);
		expect(fixture.pending()).toBe(1);
		expect(settled).toEqual([true]);
	});

	it("does not inherit uplift into a queued real user request", async () => {
		const fixture = await setup();
		fixture.respond([...sequence, { kind: "done" }]);
		fixture.hook((index, session) => {
			if (index === 3)
				session.agent.followUp({ role: "user", content: "Now answer this new question.", timestamp: Date.now() });
		});
		await fixture.session.prompt("Original task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 32768, 32768, 16384]);
	});

	it("clears uplift after a selected-model change", async () => {
		const fixture = await setup();
		fixture.respond(sequence);
		fixture.hook(async (index, session) => {
			if (index === 3) await session.setModel(fixture.secondModel);
		});
		await fixture.session.prompt("Original task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 32768, 16384]);
		expect(fixture.calls.at(-1)?.model).toBe(fixture.secondModel.id);
	});

	it("yields the temporary ceiling after the user changes the thinking selection", async () => {
		const fixture = await setup();
		fixture.respond(sequence);
		fixture.hook((index, session) => {
			if (index === 3) session.setThinkingLevel("high");
		});
		await fixture.session.prompt("Original task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 32768, 16384]);
		expect(fixture.calls.at(-1)?.thinking).toBe("high");
		expect(fixture.manager.getDefaultThinkingLevel()).toBe("max");
	});

	it("requires positive thinking in the actual failed SDK request, not only the mounted selection", async () => {
		const fixture = await setup();
		const previous = fixture.session.agent.streamFunction;
		fixture.session.agent.streamFunction = (model, context, options) =>
			previous(model, context, { ...options, reasoning: undefined });
		fixture.respond(sequence);
		await fixture.session.prompt("Original task.");
		expect(fixture.session.thinkingLevel).toBe("max");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 16384, 16384]);
	});

	it("never raises or recovers past the model-turn guard", async () => {
		const fixture = await setup({ guard: true, settings: { agentMaxTurns: 2 } });
		fixture.respond(sequence);
		await fixture.session.prompt("Original task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384]);
		expect(fixture.pending()).toBe(2);
	});

	it("keeps the default 64-round guard despite the recovery and visible budget messages", async () => {
		const fixture = await setup({ guard: true });
		fixture.respond([
			{ kind: "action", phase: "before" },
			{ kind: "length" },
			...Array.from({ length: 62 }, (_, index): Response => ({ kind: "action", phase: `progress-${index}` })),
			{ kind: "done" },
		]);
		const settled: boolean[] = [];
		fixture.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.push(event.aborted);
		});
		await fixture.session.prompt("Many authorized local steps.");
		expect(fixture.calls).toHaveLength(64);
		expect(fixture.calls.slice(2).every((call) => call.rawMaxTokens === 32768)).toBe(true);
		expect(fixture.pending()).toBe(1);
		expect(settled).toEqual([true]);
		expect(fixture.transportCalls()).toBe(0);
	});

	it("clears the temporary ceiling on abort before accepting a new real user request", async () => {
		const fixture = await setup();
		fixture.respond(sequence);
		let aborted = false;
		fixture.session.subscribe((event) => {
			if (
				!aborted &&
				fixture.records.length === 2 &&
				event.type === "message_end" &&
				event.message.role === "toolResult"
			) {
				aborted = true;
				void fixture.session.abort();
			}
		});
		await fixture.session.prompt("Original task.");
		expect(fixture.calls.map((call) => call.rawMaxTokens)).toEqual([16384, 16384, 32768]);
		expect(fixture.pending()).toBe(1);
		fixture.respond([{ kind: "done" }]);
		await fixture.session.prompt("New task.");
		expect(fixture.calls.at(-1)?.rawMaxTokens).toBe(16384);
	});
});
