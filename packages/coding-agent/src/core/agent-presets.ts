import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionManager } from "./session-manager.ts";

/**
 * Agent 预设（参照 deepseek-harness 的 agent preset 机制）：
 * 一份命名的能力组合，决定一个会话的 Agent 能看到哪些工具、收到哪些追加提示词、
 * 默认用什么审批方式。预设不负责模型路由（provider/model 是会话级独立选择），
 * 也不是安全沙箱——自定义预设的提示词由用户提供，写入仍走常规审批。
 *
 * 内置四预设只读；用户修改内置的唯一路径是「复制创建」。会话在创建时绑定预设
 * （owl-agent-preset custom entry），绑定后仅在会话空白（还没跑过第一轮）时可以切换。
 */

/** 预设建议的初始审批模式（与桌面协议 ApprovalMode 同构；会话里仍可随时改）。 */
export type PresetApprovalMode = "auto" | "confirm" | "plan";

export interface AgentPresetDefinition {
	/** 稳定标识：内置为 standard/ptc/minimal/cordis，自定义须匹配 PRESET_ID_RE。 */
	id: string;
	name: string;
	description: string;
	/** 内置预设只读，roster 与编辑器据此拒绝写入。 */
	builtin: boolean;
	/** 花名册排序，小的在前。 */
	order: number;
	/**
	 * 工具增删，语义同 settings defaultTools 的修饰条目：裸工具名整体替换默认集
	 * （DEFAULT_TOOL_NAMES），`+name` 增、`-name` 减；undefined/空 = 完全继承现状。
	 */
	tools?: string[];
	/** 追加到系统提示词末尾的预设指令；支持 {{agentDir}} 占位符。 */
	appendPrompt?: string;
	/** 该预设的初始审批模式（仅影响新会话的初值）。 */
	approvalMode?: PresetApprovalMode;
}

export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const OWL_AGENT_PRESET_ENTRY = "owl-agent-preset";

const PTC_APPEND_PROMPT = [
	"<ptc_mode>",
	"当前处于 PTC 模式：适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总。",
	"- 批量场景优先用 codemode 写脚本一次性完成调用，不要逐条重复调用同类工具。",
	"- 工具产出先筛选、去重、汇总再汇报：给用户结论和整理后的结果，不粘贴原始输出。",
	"- 单次调用就能完成的简单任务不必强行脚本化，按任务规模选择做法。",
	"</ptc_mode>",
].join("\n");

const MINIMAL_APPEND_PROMPT = [
	"<minimal_mode>",
	"极简模式：仅使用终端与基础文件工具完成任务，不依赖技能、扩展或额外指令。",
	"- 能用一条命令完成的就用命令；回复保持简短直接，先给结果。",
	"- 这是基础能力测试场景：不安装依赖、不引入预设之外的流程。",
	"</minimal_mode>",
].join("\n");

const CORDIS_APPEND_PROMPT = [
	"<creator_mode>",
	"当前处于创造模式：用对话定制 Owl 本身，让 Agent 编写插件、添加新功能或界面，或创建用户自己的预设模式。",
	"- 用户要新增能力时优先做成可复用的插件或技能，而不是一次性脚本；完成后说明放在了哪、如何启用。",
	'- 用户想创建自己的预设模式时，把组合写成 JSON 保存到 {{agentDir}}/presets/<id>.json：字段包含 id（小写字母/数字/连字符）、name、description、order、tools（"+name"/"-name" 增删，或直接列工具名替换默认集）、appendPrompt（追加系统提示词）、approvalMode（"auto"|"confirm"|"plan"）。保存后告知用户重启会话可用，或让用户在设置里查看。',
	"- 改系统配置前先说明要改什么；内置预设（builtin: true）只读，创建预设必须用新的 id。",
	"</creator_mode>",
].join("\n");

/** 内置四预设。standard 即现状默认配置的打包：不加提示词、不改工具集。 */
export const BUILTIN_AGENT_PRESETS: readonly AgentPresetDefinition[] = [
	{
		id: "standard",
		name: "标准模式",
		description: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。",
		builtin: true,
		order: 1,
	},
	{
		id: "ptc",
		name: "PTC 模式",
		description: "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。",
		builtin: true,
		order: 2,
		tools: ["+codemode"],
		appendPrompt: PTC_APPEND_PROMPT,
	},
	{
		id: "minimal",
		name: "极简模式",
		description: "Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。",
		builtin: true,
		order: 3,
		tools: ["read", "bash", "edit"],
		appendPrompt: MINIMAL_APPEND_PROMPT,
		approvalMode: "auto",
	},
	{
		id: "cordis",
		name: "创造模式",
		description: "用对话定制 Owl：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。",
		builtin: true,
		order: 4,
		tools: ["+codemode"],
		appendPrompt: CORDIS_APPEND_PROMPT,
	},
];

const BUILTIN_IDS = new Set(BUILTIN_AGENT_PRESETS.map((preset) => preset.id));

export function isBuiltInPresetId(id: string): boolean {
	return BUILTIN_IDS.has(id);
}

function presetsDir(agentDir: string): string {
	return join(agentDir, "presets");
}

/** 把 appendPrompt 里的占位符换成会话实际值。 */
export function resolvePresetAppendPrompt(
	preset: AgentPresetDefinition,
	values: { agentDir: string },
): string | undefined {
	if (!preset.appendPrompt) return undefined;
	return preset.appendPrompt.replaceAll("{{agentDir}}", values.agentDir);
}

/** 按 order（再按名称）排序的花名册：内置在前段，自定义按 order 排其后。 */
export async function listAgentPresets(agentDir: string): Promise<AgentPresetDefinition[]> {
	const custom = listCustomAgentPresets(agentDir);
	return [...BUILTIN_AGENT_PRESETS, ...custom].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh"));
}

export function getAgentPreset(agentDir: string, id: string): AgentPresetDefinition | undefined {
	return (
		BUILTIN_AGENT_PRESETS.find((preset) => preset.id === id) ??
		listCustomAgentPresets(agentDir).find((preset) => preset.id === id)
	);
}

/** 读取 <agentDir>/presets/*.json；损坏的文件跳过并在 details 里给出原因（不阻断其余预设）。 */
export function listCustomAgentPresets(agentDir: string): AgentPresetDefinition[] {
	const dir = presetsDir(agentDir);
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	const presets: AgentPresetDefinition[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as AgentPresetDefinition;
			if (parsed && typeof parsed.id === "string" && parsed.builtin !== true) presets.push(normalizePreset(parsed));
		} catch {
			// 损坏的自定义预设不进花名册，与 DSH「健康定义保持可用」的处理一致。
		}
	}
	return presets;
}

/** 保存自定义预设；内置 id 与非法 id 一律拒绝。 */
export function saveCustomAgentPreset(agentDir: string, input: AgentPresetDefinition): AgentPresetDefinition {
	const preset = normalizePreset(input);
	if (isBuiltInPresetId(preset.id)) throw new Error(`内置预设只读，不能覆盖：${preset.id}`);
	if (!PRESET_ID_RE.test(preset.id)) throw new Error(`预设 id 只允许小写字母、数字和连字符：${preset.id}`);
	if (!preset.name.trim()) throw new Error("预设名称不能为空");
	mkdirSync(presetsDir(agentDir), { recursive: true });
	writeFileSync(join(presetsDir(agentDir), `${preset.id}.json`), JSON.stringify(preset, null, "\t") + "\n", "utf8");
	return preset;
}

export function deleteCustomAgentPreset(agentDir: string, id: string): void {
	if (isBuiltInPresetId(id)) throw new Error(`内置预设只读，不能删除：${id}`);
	try {
		unlinkSync(join(presetsDir(agentDir), `${id}.json`));
	} catch {
		throw new Error(`预设不存在：${id}`);
	}
}

function normalizePreset(input: AgentPresetDefinition): AgentPresetDefinition {
	const tools =
		input.tools === undefined ? undefined : input.tools.filter((name) => typeof name === "string" && name.trim());
	return {
		id: input.id,
		name: String(input.name ?? "").trim(),
		description: String(input.description ?? ""),
		builtin: false,
		order: Number.isFinite(input.order) ? input.order : 100,
		...(tools && tools.length > 0 ? { tools } : {}),
		...(input.appendPrompt ? { appendPrompt: String(input.appendPrompt) } : {}),
		...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
	};
}

// -- 会话绑定 ---------------------------------------------------------------

/** 会话绑定的预设 id（owl-agent-preset custom entry，取最新一条；未绑定为 undefined）。 */
export function getSessionPresetId(sessionManager: Pick<SessionManager, "getEntries">): string | undefined {
	const entry = sessionManager
		.getEntries()
		.findLast((item) => item.type === "custom" && item.customType === OWL_AGENT_PRESET_ENTRY);
	if (entry?.type !== "custom") return undefined;
	const data = entry.data as { id?: unknown } | undefined;
	return typeof data?.id === "string" && data.id ? data.id : undefined;
}

export function setSessionPresetEntry(sessionManager: SessionManager, id: string): void {
	sessionManager.appendCustomEntry(OWL_AGENT_PRESET_ENTRY, { id });
}

/**
 * 解析会话应使用的预设：显式请求 → 会话绑定 → 全局默认 → standard。
 * 请求的 id 不存在时不抛错（预设可能在别的机器上创建），回退到默认并保留原 id 于绑定记录。
 */
export function resolveAgentPreset(
	agentDir: string,
	requested?: string,
	getDefaultPreset?: () => string,
): AgentPresetDefinition {
	if (requested) {
		const found = getAgentPreset(agentDir, requested);
		if (found) return found;
	}
	const fallbackId = getDefaultPreset?.() ?? "standard";
	return getAgentPreset(agentDir, fallbackId) ?? BUILTIN_AGENT_PRESETS[0];
}

/**
 * 把预设的工具增删应用到当前活跃集：裸工具名整体替换，`+name`/`-name` 增删，
 * 语义与 settings defaultTools 的解析一致。未知工具名由 setActiveTools 侧的注册表过滤。
 */
export function applyPresetToolModifiers(
	active: readonly string[],
	modifiers: readonly string[] | undefined,
): string[] {
	if (!modifiers || modifiers.length === 0) return [...active];
	const isModifier = (entry: string) => entry.startsWith("+") || entry.startsWith("-");
	const plain = modifiers.filter((entry) => !isModifier(entry));
	const tools = plain.length > 0 ? [...plain] : [...active];
	for (const entry of modifiers) {
		if (!isModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}
