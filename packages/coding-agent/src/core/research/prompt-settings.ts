import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { atomicWriteFileSync, withFileLockSync } from "../../utils/atomic-file.ts";
import { RESEARCH_PROMPT_LIMITS, RESEARCH_PROMPT_MODEL_FAMILY_PATTERN } from "./prompt-models.ts";

export interface ResearchPromptPreset {
	id: string;
	name: string;
	content: string;
	description?: string;
	sourceUrl?: string;
	/** Intended model families; these tags do not select a model or activate a preset. */
	modelFamilies?: string[];
}

export interface ResearchPromptSettings {
	version: 1;
	enabled: boolean;
	activePresetId: string | null;
	presets: ResearchPromptPreset[];
}

export interface ResearchPromptsResult {
	settings: ResearchPromptSettings;
	/** Editable role and execution instructions; the tool and evidence contract remains separate. */
	defaultPrompt: string;
}

export interface ResearchPromptsExportResult {
	savedPath: string;
}

export const RESEARCH_PROMPTS_FILE = "research-prompts.json";
export const MAX_RESEARCH_PROMPT_FILE_BYTES = RESEARCH_PROMPT_LIMITS.fileBytes;
export const MAX_RESEARCH_PROMPT_CONTENT_LENGTH = RESEARCH_PROMPT_LIMITS.contentChars;

const settingsSchema = Type.Object(
	{
		version: Type.Literal(1),
		enabled: Type.Boolean(),
		activePresetId: Type.Union([Type.String({ minLength: 1, maxLength: 80 }), Type.Null()]),
		presets: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
					name: Type.String({ minLength: 1, maxLength: RESEARCH_PROMPT_LIMITS.nameChars }),
					content: Type.String({ maxLength: MAX_RESEARCH_PROMPT_CONTENT_LENGTH }),
					description: Type.Optional(Type.String({ maxLength: RESEARCH_PROMPT_LIMITS.descriptionChars })),
					sourceUrl: Type.Optional(Type.String({ maxLength: RESEARCH_PROMPT_LIMITS.sourceUrlChars })),
					modelFamilies: Type.Optional(
						Type.Array(
							Type.String({ minLength: 1, maxLength: 64, pattern: RESEARCH_PROMPT_MODEL_FAMILY_PATTERN }),
							{ minItems: 1, maxItems: RESEARCH_PROMPT_LIMITS.modelFamilies, uniqueItems: true },
						),
					),
				},
				{ additionalProperties: false },
			),
			{ maxItems: RESEARCH_PROMPT_LIMITS.presets },
		),
	},
	{ additionalProperties: false },
);

/** Fresh defaults avoid sharing editable objects between profiles or responses. */
export function createDefaultResearchPromptSettings(): ResearchPromptSettings {
	return {
		version: 1,
		enabled: false,
		activePresetId: null,
		presets: [
			{
				id: "evidence-first",
				modelFamilies: ["general"],
				name: "证据优先",
				description: "先整理来源和观察，再给结论与待核实事项。",
				content:
					"你是 Owl 研究助手。先明确用户目标和所需交付物，再读取现有资料并选择实际可用的方法。保留来源、观察时间与关键原文；把观察到的事实、有依据的推断和待核实事项分开。先完成最小有用样本，核对结果后继续已授权工作。交付时先给主要发现，再给来源、实际验证和剩余缺口，使用简短中文。",
			},
			{
				id: "reproducible-analysis",
				modelFamilies: ["general"],
				name: "可复现分析",
				description: "按假设、操作、观察和验证组织研究过程。",
				content:
					"你是 Owl 研究助手。把研究问题转成可以观察的假设和完成条件，从用户已提供的文件、日志或网址开始。每一步记录实际输入、执行方法、预期观察与真实结果；遇到反证及时调整假设。优先小范围复现，保留可用命令、参数、版本与产物路径。只有缺少无法从现有材料找到的关键信息时提一个简短问题。最终交付实际复现步骤、验证结论与尚未覆盖的条件。",
			},
			{
				id: "source-tracing",
				modelFamilies: ["general"],
				name: "源码与调用链",
				description: "从真实入口、参数和引用追踪行为，并保留代码依据。",
				content:
					"你是 Owl 研究助手。理解程序行为时先定位真实入口和输入，再追踪参数来源、关键函数、调用关系与数据去向。读取相关实现，结合现有静态分析工具逐段核对，不凭文件名或字符串猜测完整机制。说明每个结论对应的源码位置、函数或实际工具证据；缺少实现或语义不能确认时明确标为待验证。交付简明调用链、关键分支、代码依据和必要的复现材料。",
			},
		],
	};
}

/** Validate the full replacement before touching the existing file. Empty drafts may be saved while disabled. */
export function normalizeResearchPromptSettings(value: unknown): ResearchPromptSettings {
	if (!Value.Check(settingsSchema, value)) throw new Error("研究提示词设置格式无效或超出字段长度限制");
	const settings = value as ResearchPromptSettings;
	const ids = new Set<string>();
	for (const preset of settings.presets) {
		if (ids.has(preset.id)) throw new Error("研究提示词预设 id 不能重复");
		ids.add(preset.id);
		if (!preset.name.trim()) throw new Error("研究提示词预设名称不能为空");
		if (preset.sourceUrl?.trim()) {
			let url: URL;
			try {
				url = new URL(preset.sourceUrl);
			} catch {
				throw new Error("研究提示词来源 URL 无效");
			}
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
				throw new Error("研究提示词来源只接受不含凭据的 HTTP(S) URL");
			}
		}
	}
	const activePreset = settings.presets.find((preset) => preset.id === settings.activePresetId);
	if (settings.activePresetId !== null && !activePreset) throw new Error("选中的研究提示词预设不存在");
	if (settings.enabled && !activePreset?.content.trim()) throw new Error("启用研究提示词覆盖前，请选择内容非空的预设");
	const serialized = JSON.stringify(settings);
	if (Buffer.byteLength(serialized, "utf8") > MAX_RESEARCH_PROMPT_FILE_BYTES) {
		throw new Error("研究提示词设置过大，请减少预设或内容");
	}
	return JSON.parse(serialized) as ResearchPromptSettings;
}

/** Reload on every call so existing research sessions see changes on their next turn. */
export function loadResearchPromptSettings(agentDir: string): ResearchPromptSettings {
	const path = join(agentDir, RESEARCH_PROMPTS_FILE);
	let content: string;
	try {
		if (statSync(path).size > MAX_RESEARCH_PROMPT_FILE_BYTES) throw new Error("研究提示词设置文件过大");
		content = readFileSync(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return createDefaultResearchPromptSettings();
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("研究提示词设置文件不是有效的 JSON");
	}
	return normalizeResearchPromptSettings(value);
}

function writeResearchPromptSettings(agentDir: string, settings: ResearchPromptSettings): ResearchPromptSettings {
	atomicWriteFileSync(join(agentDir, RESEARCH_PROMPTS_FILE), JSON.stringify(settings), { mode: 0o600 });
	return settings;
}

/** Atomically replace the library under the same cross-process lock as apply and restore. */
export function saveResearchPromptSettings(agentDir: string, value: unknown): ResearchPromptSettings {
	const settings = normalizeResearchPromptSettings(value);
	return withFileLockSync(join(agentDir, RESEARCH_PROMPTS_FILE), () =>
		writeResearchPromptSettings(agentDir, settings),
	);
}

export function applyResearchPromptPreset(agentDir: string, presetId: unknown): ResearchPromptSettings {
	if (typeof presetId !== "string" || !presetId.trim()) throw new Error("请选择研究提示词预设");
	return withFileLockSync(join(agentDir, RESEARCH_PROMPTS_FILE), () => {
		const settings = normalizeResearchPromptSettings({
			...loadResearchPromptSettings(agentDir),
			enabled: true,
			activePresetId: presetId,
		});
		return writeResearchPromptSettings(agentDir, settings);
	});
}

/** Disable the override while retaining the library and selected preset for later use. */
export function restoreResearchPromptDefaults(agentDir: string): ResearchPromptSettings {
	return withFileLockSync(join(agentDir, RESEARCH_PROMPTS_FILE), () => {
		const settings = { ...loadResearchPromptSettings(agentDir), enabled: false };
		return writeResearchPromptSettings(agentDir, settings);
	});
}

export function getActiveResearchPrompt(settings: ResearchPromptSettings): string | undefined {
	if (!settings.enabled) return undefined;
	return settings.presets.find((preset) => preset.id === settings.activePresetId)?.content;
}

/** Export a validated snapshot without saving or applying the workbench's edited settings. */
export function exportResearchPromptSettings(
	value: unknown,
	exportDir = process.env.OWL_EXPORT_DIR ?? join(homedir(), "Downloads"),
): ResearchPromptsExportResult {
	const settings = normalizeResearchPromptSettings(value);
	const serialized = JSON.stringify(settings);
	const destination = resolve(exportDir);
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	for (let attempt = 0; attempt < 5; attempt++) {
		const savedPath = join(destination, `owl-research-prompts-${timestamp}-${randomUUID()}.json`);
		const written = withFileLockSync(savedPath, () => {
			if (existsSync(savedPath)) return false;
			// Keep the export within the same byte limit as persisted and imported snapshots.
			atomicWriteFileSync(savedPath, serialized, { mode: 0o600 });
			return true;
		});
		if (written) return { savedPath };
	}
	throw new Error("无法生成唯一的研究提示词导出文件，请重试");
}
