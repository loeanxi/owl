import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("models.json entries that redeclare a built-in model", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createRuntime(modelsJson: object): Promise<ModelRuntime> {
		const dir = mkdtempSync(join(tmpdir(), "pi-models-json-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify(modelsJson));
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
	}

	it("keeps built-in image input and thinking metadata when the entry omits them", async () => {
		const builtIn = (await createRuntime({ providers: {} })).getModel("zai-coding-cn", "glm-5.3-flash");
		expect(builtIn?.input).toContain("image");

		const runtime = await createRuntime({
			providers: { "zai-coding-cn": { models: [{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: true }] } },
		});
		const model = runtime.getModel("zai-coding-cn", "glm-5.3-flash");
		expect(model?.input).toEqual(builtIn?.input);
		expect(model?.thinkingLevelMap).toEqual(builtIn?.thinkingLevelMap);
		expect(model?.maxTokens).toBe(builtIn?.maxTokens);
	});

	it("lets an explicit input override the built-in value", async () => {
		const runtime = await createRuntime({
			providers: { "zai-coding-cn": { models: [{ id: "glm-5.3-flash", input: ["text"] }] } },
		});
		expect(runtime.getModel("zai-coding-cn", "glm-5.3-flash")?.input).toEqual(["text"]);
	});

	it("still defaults brand-new custom models to text input", async () => {
		const runtime = await createRuntime({
			providers: {
				custom: {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					apiKey: "x",
					models: [{ id: "my-model" }],
				},
			},
		});
		expect(runtime.getModel("custom", "my-model")?.input).toEqual(["text"]);
	});
});
