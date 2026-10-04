import {
	type AuthInteraction,
	createProvider,
	envApiKeyAuth,
	type Model,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

// vitest 全局注入 PI_OFFLINE=1（离线测试约定）；这里要验证的恰是登录后的联网拉取，
// 保存原值、运行期间移除，结束后还原。
const originalOffline = process.env.PI_OFFLINE;
delete process.env.PI_OFFLINE;
afterEach(() => {
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
});

const stubStreams = {
	stream: (): never => {
		throw new Error("streaming is not used in this test");
	},
	streamSimple: (): never => {
		throw new Error("streaming is not used in this test");
	},
};

const fetchedModel: Model<"openai-completions"> = {
	id: "dyn-model",
	name: "Dyn Model",
	api: "openai-completions",
	provider: "test-dynamic",
	baseUrl: "http://test-gateway/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 32_768,
	reasoning: false,
	type: "chat",
};

/** 纯动态目录厂商的测试替身：基线为空，联网 refresh 后才有模型（同 loean 模式）。 */
function makeDynamicProvider(options: { fetchError?: Error } = {}): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: "test-dynamic",
		name: "Test Dynamic",
		baseUrl: "http://test-gateway/v1",
		auth: { apiKey: envApiKeyAuth("Test Dynamic key", ["TEST_DYNAMIC_API_KEY"]) },
		models: [],
		api: stubStreams,
		fetchModels: async (context: RefreshModelsContext) => {
			// 与 loean 相同的契约：离线阶段不出结果；无 Key 不发请求
			if (!context.allowNetwork) return [];
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (!key) return [];
			if (options.fetchError) throw options.fetchError;
			return [fetchedModel];
		},
	});
}

const loginInteraction: AuthInteraction = { prompt: async () => "test-key", notify: () => {} };

describe("ModelRuntime dynamic provider catalogs", () => {
	it("login fetches an empty-baseline provider's catalog over the network", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(makeDynamicProvider());
		expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "test-dynamic")).toEqual([]);

		// 桌面快捷接入路径：auth.login(api_key) → Key 落盘后应立刻联网拉目录
		await runtime.login("test-dynamic", "api_key", loginInteraction);

		const models = runtime.getAvailableSnapshot().filter((model) => model.provider === "test-dynamic");
		expect(models.map((model) => model.id)).toEqual(["dyn-model"]);
	});

	it("a failing catalog fetch does not fail the login (key stays stored)", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(makeDynamicProvider({ fetchError: new Error("gateway down") }));

		await expect(runtime.login("test-dynamic", "api_key", loginInteraction)).resolves.toMatchObject({
			type: "api_key",
		});
		expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "test-dynamic")).toEqual([]);
		// 凭据已落盘：修复网关后重登（或重试）即可拿到目录
		const credentials = await runtime.listCredentials();
		expect(credentials.map((entry) => entry.providerId)).toContain("test-dynamic");
	});
});
