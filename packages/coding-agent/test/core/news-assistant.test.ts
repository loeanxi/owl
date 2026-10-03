import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../ai/src/index.ts";
import { fauxAssistantMessage } from "../../../ai/src/providers/faux.ts";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream.ts";
import { NewsService } from "../../src/core/news/service.ts";
import type { NewsModelCall, NewsModelResponse } from "../../src/core/news/types.ts";
import { callNewsModel } from "../../src/modes/desktop/news-model.ts";

const services: NewsService[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const directory of directories.splice(0)) {
		if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("owl-news-assistant-"))
			throw new Error("Unexpected news assistant fixture cleanup path");
		rmSync(directory, { recursive: true, force: true });
	}
});

function response(request: NewsModelCall): NewsModelResponse {
	return {
		text: "连接成功",
		provider: request.model?.provider ?? "fixture",
		model: request.model?.id ?? "default",
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: null },
	};
}

function fixture(callModel = vi.fn(async (request: NewsModelCall) => response(request))) {
	const agentDir = mkdtempSync(join(tmpdir(), "owl-news-assistant-"));
	directories.push(agentDir);
	const service = new NewsService({
		agentDir,
		callModel,
		resolveModel: async (_capability, configured) => configured ?? { provider: "fixture", id: "default" },
		fetch: async () => {
			throw new Error("News assistant fixture forbids external HTTP");
		},
		resolveHost: async () => {
			throw new Error("News assistant fixture forbids external DNS");
		},
	});
	services.push(service);
	return { service, callModel };
}

describe("news assistant without collected articles", () => {
	it("answers setup questions through the configured assistant model without inventing sources", async () => {
		const { service, callModel } = fixture();
		const model = { provider: "fixture", id: "assistant" };
		await service.handle({ action: "configure", patch: { modelCallsEnabled: true, models: { assistant: model } } });
		const result = await service.handle({
			action: "assistant",
			request: { question: "RSS 是什么？", itemIds: [] },
		});
		expect(result.answer).toBe("连接成功");
		expect(result.citations).toEqual([]);
		expect(callModel).toHaveBeenCalledOnce();
		const request = callModel.mock.calls[0]![0];
		expect(request.model).toEqual(model);
		expect(request.system).toContain("没有联网");
		expect(request.system).toContain("未读取资讯");
		expect(request.system).toContain("不得编造");
		expect(JSON.parse(request.user).sources).toEqual([]);
		expect(service.store.receipts()[0]?.status).toBe("completed");
	});

	it("keeps normal assistant calls behind the model processing switch", async () => {
		const { service, callModel } = fixture();
		await expect(
			service.handle({ action: "assistant", request: { question: "RSS 是什么？", itemIds: [] } }),
		).rejects.toThrow("资讯模型调用尚未开启");
		expect(callModel).not.toHaveBeenCalled();
	});

	it.each([{ itemIds: ["missing"] }, { itemIds: [], storyId: "missing" }, { itemIds: [], reportId: "missing" }])(
		"rejects explicitly selected unavailable context instead of silently answering generally: %j",
		async (context) => {
			const { service, callModel } = fixture();
			await service.handle({ action: "configure", patch: { modelCallsEnabled: true } });
			await expect(
				service.handle({ action: "assistant", request: { question: "分析一下", ...context } }),
			).rejects.toThrow("先选择可阅读的资讯");
			expect(callModel).not.toHaveBeenCalled();
		},
	);
});

describe("manual news model connection test", () => {
	it("really calls an unsaved model on every click while leaving background settings and saved model alone", async () => {
		const { service, callModel } = fixture();
		const savedModel = { provider: "fixture", id: "saved" };
		const draftModel = { provider: "fixture", id: "draft" };
		await service.handle({ action: "configure", patch: { models: { assistant: savedModel } } });
		for (let click = 0; click < 2; click++) {
			const result = await service.handle({ action: "test_model", model: draftModel });
			expect(result).toMatchObject({ model: draftModel, answer: "连接成功", usage: { cost: null } });
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		}
		expect(callModel).toHaveBeenCalledTimes(2);
		for (const [request] of callModel.mock.calls)
			expect(request).toMatchObject({
				capability: "assistant",
				purpose: "connection-test",
				model: draftModel,
				maxTokens: 64,
				temperature: 0,
			});
		const snapshot = await service.handle({ action: "snapshot" });
		expect(snapshot.configuration.modelCallsEnabled).toBe(false);
		expect(snapshot.configuration.collectEnabled).toBe(false);
		expect(snapshot.configuration.models.assistant).toEqual(savedModel);
		expect(service.store.receipts()).toHaveLength(2);
		expect(service.store.receipts().every((receipt) => receipt.status === "completed")).toBe(true);
	});

	it("tests the saved assistant model when no draft selection is supplied", async () => {
		const { service } = fixture();
		const model = { provider: "fixture", id: "saved" };
		await service.handle({ action: "configure", patch: { models: { assistant: model } } });
		expect((await service.handle({ action: "test_model" })).model).toEqual(model);
	});

	it("does not bypass a zero call budget for a manual connection test", async () => {
		const { service, callModel } = fixture();
		await service.handle({ action: "configure", patch: { budget: { perMinute: 0, perHour: 0, perDay: 0 } } });
		await expect(service.handle({ action: "test_model" })).rejects.toThrow("调用");
		expect(callModel).not.toHaveBeenCalled();
		expect(service.store.receipts()).toHaveLength(0);
	});

	it("counts a successful connection test against the same model call budget", async () => {
		const { service, callModel } = fixture();
		await service.handle({ action: "configure", patch: { budget: { perMinute: 1, perHour: 1, perDay: 1 } } });
		await service.handle({ action: "test_model" });
		await expect(service.handle({ action: "test_model" })).rejects.toThrow("调用次数已达到上限");
		expect(callModel).toHaveBeenCalledOnce();
		expect(service.store.receipts()).toHaveLength(1);
	});

	it("records unknown failed calls once and returns safe authentication guidance with the receipt ID", async () => {
		const sensitive = "Bearer pretend-secret-must-not-be-returned";
		const callModel = vi.fn(async (_request: NewsModelCall): Promise<NewsModelResponse> => {
			throw new Error(`HTTP 401 Unauthorized ${sensitive}`);
		});
		const { service } = fixture(callModel);
		let message = "";
		try {
			await service.handle({ action: "test_model" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("认证");
		expect(message).not.toContain(sensitive);
		expect(callModel).toHaveBeenCalledOnce();
		const receipts = service.store.receipts();
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.status).toBe("unknown");
		expect(message).toContain(receipts[0]!.id);
		expect(receipts[0]?.error).not.toContain(sensitive);
	});

	it.each([
		["401 Unauthorized", "认证"],
		["404 model not found", "模型或服务地址不存在"],
		["429 quota exceeded", "额度不足"],
		["request timed out", "超时"],
	])("preserves safe provider diagnostics through the adapter and receipt: %s", async (upstream, expected) => {
		const model: Model<"openai-completions"> = {
			id: "default",
			name: "Fixture",
			provider: "fixture",
			api: "openai-completions",
			baseUrl: "http://localhost:0",
			input: ["text"],
			reasoning: false,
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const sensitive = "Bearer pretend-secret-must-not-be-returned";
		const streamSimple = vi.fn(() => {
			const stream = new AssistantMessageEventStream();
			stream.end(fauxAssistantMessage("", { stopReason: "error", errorMessage: `${upstream} ${sensitive}` }));
			return stream;
		});
		const registry = { find: () => model, getAvailable: () => [model], streamSimple };
		const { service } = fixture(vi.fn((request: NewsModelCall) => callNewsModel({ registry }, request)));
		await expect(service.handle({ action: "test_model" })).rejects.toThrow(expected);
		expect(streamSimple).toHaveBeenCalledOnce();
		expect(service.store.receipts()[0]?.error).not.toContain(sensitive);
	});
});
