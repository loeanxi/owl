import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	assessToolForIntent,
	deriveIntentSteps,
	derivePreloadSteps,
	type IntentToolMetadata,
	intentSearchQuery,
} from "../src/extensions/tool-search/intent.ts";

// Representative public metadata, including the action schema shapes used by the installed tools.
const mediaControl: IntentToolMetadata = {
	name: "media_bridge_control",
	description: "Control the explicitly configured local media player. Use media_bridge_status first.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("play-pause"), Type.Literal("next"), Type.Literal("seek")]),
	}),
};
const mediaStatus: IntentToolMetadata = {
	name: "media_bridge_status",
	description: "Read the local media player status and available controls. Read-only; never pauses playback.",
	parameters: Type.Object({}),
};
const imageEdit: IntentToolMetadata = {
	name: "edit_image",
	description: "Edit, combine, or restyle existing images with the configured provider.",
	parameters: Type.Object({
		prompt: Type.String({ description: "Describe the changes to make." }),
		source_path: Type.Optional(Type.String()),
	}),
};
const memory: IntentToolMetadata = {
	name: "update_user_impression",
	description: "仅在用户本轮明确要求更新长期用户印象时，把偏好、习惯、背景或沟通风格合并写入档案。",
	parameters: Type.Object({ impression: Type.String() }),
};
const navigation: IntentToolMetadata = {
	name: "lsp_navigation",
	description: "Navigate source with language-server operations such as definition, references, hover, and rename.",
	parameters: Type.Object({
		operation: Type.Unsafe<string>({ type: "string", enum: ["definition", "references", "incomingCalls", "rename"] }),
	}),
};
const news: IntentToolMetadata = {
	name: "news_hot",
	description: "读取按最近48小时独立参与方计算的事件热点，不触发采集或模型调用。",
	parameters: Type.Object({ limit: Type.Optional(Type.Integer()) }),
};

describe("intent decomposition", () => {
	it.each([
		["把歌暂停一下", "media", "pause"],
		["把背景变透明", "image", "edit"],
		["这段代码谁在调用", "code", "references"],
		["查一下刚出的行业动态", "news", "search"],
		["瀏覽器截圖", "browser", "screenshot"],
		["找个附近适合办公的咖啡店", "map", "search"],
	])("preserves a concrete domain and action for %s", (query, capability, action) => {
		expect(deriveIntentSteps(query)).toMatchObject([{ capability, action, query }]);
	});

	it("separates research, reading the sources and creating the spreadsheet", () => {
		expect(deriveIntentSteps("查资料并整理 Excel").map(({ capability, action }) => ({ capability, action }))).toEqual(
			[
				{ capability: "web", action: "search" },
				{ capability: "web", action: "read" },
				{ capability: "spreadsheet", action: "create" },
			],
		);
	});

	it("does not silently discard an oversized plan", () => {
		expect(deriveIntentSteps("播放音乐；创建表格；编辑图片；查看新闻；打开网页")).toHaveLength(5);
	});

	it("does not treat an action nested inside a capability word as a preload action", () => {
		expect(
			derivePreloadSteps("从播放器删除收藏歌曲").map(({ capability, action }) => ({ capability, action })),
		).toEqual([{ capability: "media", action: "delete" }]);
		expect(derivePreloadSteps("把歌暂停一下")).toMatchObject([{ capability: "media", action: "pause" }]);
		expect(derivePreloadSteps("暂停播放器")).toMatchObject([{ capability: "media", action: "pause" }]);
	});

	it("leaves an unfamiliar request unknown instead of inventing intent", () => {
		expect(deriveIntentSteps("把星辰折起来")).toEqual([
			{ capability: "unknown", action: "unknown", query: "把星辰折起来", target: "把星辰折起来" },
		]);
	});

	it("retains technical conditions and emits cross-language recall terms", () => {
		const [step] = deriveIntentSteps("把背景变透明");
		expect(step.constraints).toEqual(["transparent background"]);
		expect(intentSearchQuery(step)).toContain("image");
		expect(intentSearchQuery(deriveIntentSteps("把歌暂停一下")[0])).toContain("play-pause");
	});
});

describe("tool intent evidence", () => {
	it("finds pause in nested action consts but never mistakes status for control", () => {
		const step = deriveIntentSteps("把歌暂停一下")[0];
		const supported = assessToolForIntent(step, mediaControl);
		expect(supported.status).toBe("supported");
		expect(supported.evidence.some((entry) => entry.includes("parameters.action.anyOf[0].const: play-pause"))).toBe(
			true,
		);
		expect(assessToolForIntent(step, mediaStatus).status).toBe("refine");
	});

	it("keeps image editing discoverable without claiming transparent output is guaranteed", () => {
		const step = deriveIntentSteps("把背景变透明")[0];
		expect(assessToolForIntent(step, memory).status).toBe("rejected");
		const candidate = assessToolForIntent(step, imageEdit);
		expect(candidate.status).toBe("refine");
		expect(candidate.missing).toContain("constraint (verify before execution): transparent background");
		expect(candidate.evidence).toContain("name: edit_image");
	});

	it("accepts explicit transparency metadata and rejects a negative guarantee", () => {
		const step = deriveIntentSteps("把背景变透明")[0];
		expect(
			assessToolForIntent(step, {
				...imageEdit,
				parameters: Type.Object({ transparent_background: Type.Boolean() }),
			}).status,
		).toBe("supported");
		expect(
			assessToolForIntent(step, {
				...imageEdit,
				description: `${imageEdit.description} Cannot produce transparent backgrounds.`,
			}).status,
		).toBe("refine");
	});

	it("finds code callers from declared operations and rejects incidental model-call prose", () => {
		const step = deriveIntentSteps("这段代码谁在调用")[0];
		expect(assessToolForIntent(step, navigation).status).toBe("supported");
		expect(assessToolForIntent(step, news).status).toBe("rejected");
		expect(assessToolForIntent(step, imageEdit).status).toBe("rejected");
	});

	it("does not add operations absent from a tool's authoritative action enum", () => {
		expect(
			assessToolForIntent(
				{ capability: "media", action: "pause" },
				{
					...mediaControl,
					description: "Control music playback including play and pause.",
					parameters: Type.Object({ action: Type.Unsafe<string>({ type: "string", enum: ["next", "seek"] }) }),
				},
			).status,
		).toBe("refine");
	});

	it("does not interpret output modes as the allowed actions", () => {
		expect(
			assessToolForIntent(
				{ capability: "web", action: "read" },
				{
					name: "fetch_content",
					description: "Read the content of web pages at a URL. Read-only.",
					parameters: Type.Object({
						mode: Type.Unsafe<string>({ type: "string", enum: ["readable", "raw", "answer"] }),
					}),
				},
			).status,
		).toBe("supported");
	});

	it("allows affirmative read-only search metadata, including a trailing control prohibition", () => {
		expect(
			assessToolForIntent(
				{ capability: "news", action: "search" },
				{
					name: "lookup",
					description: "Read-only search of news, but never modifies articles.",
				},
			).status,
		).toBe("supported");
	});

	it("does not use shared search/source words or auxiliary schema descriptions as domain evidence", () => {
		expect(
			assessToolForIntent(
				{ capability: "map", action: "search" },
				{
					name: "edit",
					description: "Edit exact file text. If changes affect nearby lines, merge them into one edit.",
				},
			).status,
		).toBe("rejected");
		expect(
			assessToolForIntent(
				{ capability: "code", action: "search" },
				{
					name: "web_search",
					description: "Search web sources and return source-linked results.",
				},
			).status,
		).toBe("rejected");
		expect(
			assessToolForIntent(
				{ capability: "web", action: "read" },
				{
					name: "news_read",
					description: "读取资讯内容。",
					parameters: Type.Object({ id: Type.String({ description: "从 news_search/news_hot 返回的真实 ID" }) }),
				},
			).status,
		).toBe("rejected");
	});

	it("retains tools from an unknown third-party capability without a domain allowlist", () => {
		expect(
			assessToolForIntent(
				{ capability: "quasar", action: "deploy" },
				{
					name: "quasar_deploy",
					description: "Deploy a project through the Quasar service.",
				},
			).status,
		).toBe("supported");
		expect(
			assessToolForIntent(deriveIntentSteps("quasar list deployments")[0], {
				name: "quasar_list_deployments",
				description: "List Quasar deployments.",
			}).status,
		).toBe("supported");
	});

	it("permits exact unknown tool discovery but does not treat an unknown sentence as a match", () => {
		const tool = { name: "acme_frobnicate", description: "Perform the vendor's specialized operation." };
		expect(assessToolForIntent(deriveIntentSteps(tool.name)[0], tool).status).toBe("supported");
		expect(assessToolForIntent(deriveIntentSteps("把星辰折起来")[0], tool).status).toBe("refine");
	});
});
