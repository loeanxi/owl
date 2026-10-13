import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "../extensions/index.ts";
import type { SessionManager } from "../session-manager.ts";
import { diagnoseResearchTurn } from "./diagnosis.ts";
import {
	isResearchTaskRecord,
	RESEARCH_TASK_ENTRY,
	RESEARCH_TASK_FIELDS,
	type ResearchTaskFact,
	type ResearchTaskRecord,
} from "./task-state.ts";

export const RESEARCH_TASK_TOOL = "research_task";
type TaskSession = Pick<SessionManager, "getEntries" | "getBranch" | "getSessionId">;
type AppendTask = (customType: string, data: ResearchTaskRecord) => void;
const TEMPLATE =
	'标准格式：{"action":"update","facts":[{"field":"environment","value":"<用户原文中的值>","inputId":"<inputs.id>","quote":"<用户原文摘录>"}],"missingMaterials":["<缺少的实际材料>"]}；只读当前记录用 {"action":"inspect"}；检查工作区产物用 {"action":"check","artifactPath":"<文件路径>","kind":"file_exists","criterion":"<本次检查条件>"}。';

function hash(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}
function hashInputs(inputs: ResearchTaskRecord["inputs"]): string {
	return hash(
		JSON.stringify(inputs.map((item) => [item.id, item.sha256, item.attachedPaths ?? [], item.imageCount ?? 0])),
	);
}

/** Separate the actual latest request from saved facts whose task relationship needs review. */
export function getResearchTurnContext(task: ResearchTaskRecord) {
	const latestInput = task.inputs.at(-1);
	if (!latestInput) throw new Error("研究任务缺少当前输入");
	return structuredClone({
		latestInput,
		inputHash: task.inputHash,
		previousTask: {
			taskId: task.taskId,
			originalRequest: task.originalRequest,
			inputs: task.inputs.slice(0, -1),
			facts: task.facts,
			missingMaterials: task.missingMaterials,
			toolMatches: task.toolMatches,
		},
		selectedModel: task.modelFit.selected,
		goalVerified: task.acceptance.goalVerified,
	});
}
function requireScope(manager: TaskSession): void {
	const entry = manager.getEntries().findLast((e) => e.type === "custom" && e.customType === "owl-research-mode");
	if (
		entry?.type !== "custom" ||
		!entry.data ||
		typeof entry.data !== "object" ||
		!("mode" in entry.data) ||
		!["auto", "crawl", "web", "binary", "model", "osint"].includes(String(entry.data.mode))
	)
		throw new Error("普通会话不能读写研究任务记录");
}

export function getResearchTask(manager: TaskSession): ResearchTaskRecord | undefined {
	requireScope(manager);
	const entry = manager.getBranch().findLast((e) => e.type === "custom" && e.customType === RESEARCH_TASK_ENTRY);
	if (entry?.type !== "custom") return undefined;
	if (!isResearchTaskRecord(entry.data, manager.getSessionId()))
		throw new Error("研究任务记录损坏或会话归属不符，不能恢复旧记录");
	return structuredClone(entry.data);
}

function persist(manager: SessionManager, task: ResearchTaskRecord, append?: AppendTask): ResearchTaskRecord {
	task.id = randomUUID();
	task.revision++;
	task.updatedAt = new Date().toISOString();
	if (!isResearchTaskRecord(task, manager.getSessionId())) throw new Error("研究任务记录无效，不能保存");
	if (append) append(RESEARCH_TASK_ENTRY, structuredClone(task));
	else manager.appendCustomEntry(RESEARCH_TASK_ENTRY, structuredClone(task));
	return structuredClone(task);
}

function emptyFacts(): ResearchTaskRecord["facts"] {
	return {
		target: { state: "unreviewed", value: null, evidence: [] },
		function: { state: "unreviewed", value: null, evidence: [] },
		environment: { state: "unreviewed", value: null, evidence: [] },
		dataSource: { state: "unreviewed", value: null, evidence: [] },
		authorization: { state: "unreviewed", value: null, evidence: [] },
		deliverable: { state: "unreviewed", value: null, evidence: [] },
		acceptance: { state: "unreviewed", value: null, evidence: [] },
	};
}

function newTask(manager: TaskSession, prompt: string): ResearchTaskRecord {
	return {
		id: randomUUID(),
		version: 1,
		taskId: randomUUID(),
		revision: 1,
		ownerSessionId: manager.getSessionId(),
		updatedAt: new Date().toISOString(),
		originalRequest: prompt.slice(0, 16384),
		inputHash: hash(prompt),
		inputs: [],
		facts: emptyFacts(),
		missingMaterials: [],
		toolMatches: [],
		modelFit: { selected: null, candidates: [], basis: "模型目录尚未核对，不能据模板名称认定任务适用。" },
		response: { state: "not_started", summary: "尚无本轮模型响应，原目标未验收。" },
		acceptance: { state: "not_run", goalVerified: false, checks: [] },
		status: "in_progress",
	};
}

function matchModel(task: ResearchTaskRecord, ctx: ExtensionContext, imageRequired = false): void {
	const fits = (input: readonly string[]) => input.includes("text") && (!imageRequired || input.includes("image"));
	const selected = ctx.model;
	task.modelFit = {
		selected: selected
			? {
					provider: String(selected.provider),
					id: selected.id,
					inputTypes: [...selected.input],
					inputCompatible: fits(selected.input),
				}
			: null,
		candidates: ctx.modelRegistry
			.getAvailable()
			.filter((model) => model.api !== "pi-virtual" && fits(model.input))
			.slice(0, 16)
			.map((model) => ({ provider: String(model.provider), id: model.id, inputCompatible: true })),
		basis: "仅核对已配置目录和本轮输入模态；目录可用不等于模型愿意接受或已经完成此任务，不自动切换模型。",
	};
}

/** Save the exact request independently of whether the model later records facts or declines. */
export function beginResearchTaskTurn(
	manager: SessionManager,
	prompt: string,
	ctx: ExtensionContext,
	append?: AppendTask,
	imageRequired = false,
	attachedPaths: readonly string[] = [],
	imageCount = imageRequired ? 1 : 0,
): ResearchTaskRecord {
	const previous = getResearchTask(manager);
	const task = previous ?? newTask(manager, prompt);
	// Older sessions have no task ledger. Seed it from their actual branch rather than
	// treating the latest clarification as a replacement for the original request.
	if (!previous) {
		for (const entry of manager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n");
			if (!text.trim()) continue;
			task.inputs.push({
				id: entry.id,
				text: text.slice(0, 4096),
				sha256: hash(text),
				truncated: text.length > 4096,
			});
			if (task.inputs.length === 1) task.originalRequest = text.slice(0, 16384);
		}
	}
	const input: ResearchTaskRecord["inputs"][number] = {
		id: randomUUID(),
		text: prompt.slice(0, 4096),
		sha256: hash(prompt),
		truncated: prompt.length > 4096,
		...(attachedPaths.length ? { attachedPaths: [...attachedPaths] } : {}),
		...(imageCount > 0 ? { imageCount } : {}),
	};
	if (previous || attachedPaths.length || imageCount > 0 || task.inputs.at(-1)?.sha256 !== input.sha256)
		task.inputs.push(input);
	if (task.inputs.length > 32) task.inputs.splice(1, task.inputs.length - 32);
	const retained = new Set(task.inputs.map((item) => item.id));
	for (const field of RESEARCH_TASK_FIELDS)
		if (task.facts[field].evidence.some((ref) => !retained.has(ref.inputId)))
			task.facts[field] = { state: "unreviewed", value: null, evidence: [] };
	task.inputHash = hashInputs(task.inputs);
	task.acceptance = { state: "not_run", goalVerified: false, checks: [] };
	task.response = {
		state: "not_started",
		summary: "新输入已保存；先核对实际目标、材料和工具，响应结束不等于目标完成。",
	};
	task.status = "in_progress";
	matchModel(task, ctx, imageRequired);
	return persist(manager, task, append);
}

export function finishResearchTaskTurn(
	manager: SessionManager,
	messages: readonly AgentMessage[],
	append?: AppendTask,
): ResearchTaskRecord | undefined {
	const task = getResearchTask(manager);
	if (!task) return undefined;
	const last = messages.findLast((message) => message.role === "assistant");
	if (!last || last.role !== "assistant") return task;
	const diagnosis = diagnoseResearchTurn([last], manager.getSessionId());
	const state: ResearchTaskRecord["response"]["state"] =
		diagnosis.status === "upstream_refusal"
			? "provider_refused"
			: diagnosis.status === "textual_refusal_candidate"
				? "declined_candidate"
				: last.stopReason === "aborted"
					? "cancelled"
					: last.stopReason === "error"
						? "error"
						: last.stopReason === "toolUse"
							? "error"
							: "received";
	task.response = {
		state,
		provider: String(last.provider),
		model: last.model,
		summary:
			state === "received"
				? "模型已回复；尚未独立验证原目标完成。"
				: state === "declined_candidate"
					? "回复含拒绝措辞，本轮目标未交付；不能据此确认审核原因或误拒绝。"
					: state === "provider_refused"
						? "上游响应携带明确拒绝标记；原目标未交付。"
						: last.stopReason === "toolUse"
							? "本轮结束时只有工具调用，尚无最终回复；原目标未交付。"
							: "本轮响应失败或取消，原目标未完成。",
	};
	task.status = ["declined_candidate", "provider_refused", "error", "cancelled"].includes(state)
		? "blocked"
		: task.acceptance.checks.length
			? "partial"
			: task.missingMaterials.length
				? "needs_input"
				: "unverified";
	return persist(manager, task, append);
}

const factUpdate = Type.Object(
	{
		field: Type.Union([
			Type.Literal("target"),
			Type.Literal("function"),
			Type.Literal("environment"),
			Type.Literal("dataSource"),
			Type.Literal("authorization"),
			Type.Literal("deliverable"),
			Type.Literal("acceptance"),
		]),
		state: Type.Optional(Type.Union([Type.Literal("unknown"), Type.Literal("user_stated")])),
		value: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		inputId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		quote: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	},
	{ additionalProperties: false },
);
export const researchTaskSchema = Type.Object(
	{
		action: Type.Optional(Type.Union([Type.Literal("inspect"), Type.Literal("update"), Type.Literal("check")])),
		facts: Type.Optional(Type.Array(factUpdate, { maxItems: 7 })),
		missingMaterials: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 32 })),
		toolNeeds: Type.Optional(
			Type.Array(
				Type.Object(
					{
						operation: Type.String({ minLength: 1, maxLength: 2000 }),
						tools: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 16 },
			),
		),
		newTask: Type.Optional(Type.Boolean()),
		artifactPath: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
		kind: Type.Optional(
			Type.Union([Type.Literal("file_exists"), Type.Literal("sha256"), Type.Literal("json_value")]),
		),
		criterion: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		expectedSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
		jsonPointer: Type.Optional(Type.String({ maxLength: 1024 })),
		expected: Type.Optional(
			Type.Union([Type.String({ maxLength: 2000 }), Type.Number(), Type.Boolean(), Type.Null()]),
		),
	},
	{
		additionalProperties: false,
		description:
			"inspect 默认只读。update 只保存由当前 inputs 原文支持的用户声明；unknown 省略 value/inputId/quote。check 只在当前工作区核验文件/哈希/JSON字段，不运行文件，不认证整个目标完成。",
	},
);

async function checkArtifact(
	task: ResearchTaskRecord,
	input: {
		artifactPath: string;
		kind: "file_exists" | "sha256" | "json_value";
		criterion: string;
		expectedSha256?: string;
		jsonPointer?: string;
		expected?: string | number | boolean | null;
	},
	ctx: ExtensionToolContext,
): Promise<void> {
	const root = await realpath(ctx.cwd);
	const path = resolve(ctx.cwd, input.artifactPath);
	const within = (candidate: string, base = root) => {
		const part = relative(base, candidate);
		return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
	};
	if (
		!(within(path, resolve(ctx.cwd)) || within(path)) ||
		/^(?:\\\\|\/\/)|[\x00-\x1f]/.test(input.artifactPath) ||
		/^[a-z]+:\/\//i.test(input.artifactPath) ||
		(process.platform === "win32" && input.artifactPath.slice(2).includes(":"))
	)
		throw new Error("产物检查仅接受当前工作区内的普通文件路径");
	let bytes: Buffer | undefined;
	let failure = "";
	try {
		const actualPath = await realpath(path);
		if (!within(actualPath)) throw new Error("产物真实路径超出当前工作区");
		const info = await stat(actualPath);
		if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("产物必须是 4 MiB 以内的普通文件");
		ctx.signal?.throwIfAborted();
		bytes = await readFile(actualPath, { signal: ctx.signal });
		if (bytes.length > 4 * 1024 * 1024) throw new Error("产物超过 4 MiB");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		failure = "产物文件不存在";
	}
	const sha256 = bytes ? hash(bytes) : null;
	if (bytes && input.kind === "sha256" && sha256 !== input.expectedSha256) failure = "产物哈希不符合预期";
	if (bytes && input.kind === "json_value") {
		try {
			let value: unknown = JSON.parse(bytes.toString("utf8"));
			const pointer = input.jsonPointer!;
			if (pointer !== "" && !pointer.startsWith("/")) throw new Error("JSON Pointer 必须为空或以 / 开始");
			for (const component of pointer === "" ? [] : pointer.slice(1).split("/")) {
				if (/~(?![01])/.test(component)) throw new Error("JSON Pointer 转义无效");
				const key = component.replaceAll("~1", "/").replaceAll("~0", "~");
				if (
					["__proto__", "constructor", "prototype"].includes(key) ||
					!value ||
					typeof value !== "object" ||
					!Object.hasOwn(value, key)
				)
					throw new Error("JSON 字段不存在或路径无效");
				value = (value as Record<string, unknown>)[key];
			}
			if (!Object.is(value, input.expected)) failure = "JSON 字段值不符合预期";
		} catch {
			failure = "JSON 内容或字段检查未通过";
		}
	}
	ctx.signal?.throwIfAborted();
	if (task.acceptance.checks.length >= 32) throw new Error("本任务最多保存 32 项独立产物检查");
	task.acceptance.checks.push({
		id: randomUUID(),
		taskId: task.taskId,
		inputHash: task.inputHash,
		criterion: input.criterion,
		kind: input.kind,
		status: failure ? "failed" : "passed",
		artifactPath: path,
		artifactSha256: sha256,
		verifier: "owl-artifact-check-v1",
		summary: failure || "指定文件检查通过；仅证明该产物条件，原目标仍未整体验收。",
	});
	task.acceptance.state = task.acceptance.checks.some((check) => check.status === "failed") ? "failed" : "partial";
	task.status = "partial";
}

/** No network, model invocation, shell execution or authorization changes. */
export function createResearchTaskTool(
	manager: SessionManager,
	append?: AppendTask,
	registeredToolNames?: () => readonly string[],
): ToolDefinition<typeof researchTaskSchema> {
	const owner = manager.getSessionId();
	return {
		name: RESEARCH_TASK_TOOL,
		label: "核对研究任务",
		executionMode: "sequential",
		description:
			"inspect 读取原任务、inputs 与来源；update 将用户原文支持的 target/function/environment/dataSource/authorization/deliverable/acceptance 保存为用户声明，需 inputId、quote 和 value，value 必须出现在 quote 中。未识别的说明用 state=unknown，不表示确认不存在。missingMaterials 是待补材料，toolNeeds 仅核对已注册工具，不能认定操作已支持。newTask=true 只用于用户真正换了目标，补充说明保持原 taskId。check 按 artifactPath/kind/criterion 独立核验当前工作区普通文件、SHA256 或 JSON Pointer 值；不执行文件，不把组件检查当原目标通过。",
		promptSnippet: "research_task: 保存有原文依据的任务事实、核对模型/工具目录，独立检查已有产物",
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		parameters: researchTaskSchema,
		execute: async (_id, input, signal, _update, ctx) => {
			signal?.throwIfAborted();
			ctx.signal?.throwIfAborted();
			if (manager.getSessionId() !== owner || ctx.sessionManager.getSessionId() !== owner)
				throw new Error("研究任务不属于当前会话");
			if (!Value.Check(researchTaskSchema, input)) throw new Error(`研究任务参数无效。${TEMPLATE}`);
			const previous = getResearchTask(manager);
			if (!previous) throw new Error("当前研究分支尚无用户请求，不能虚构任务");
			let task = previous;
			const action =
				input.action ??
				(input.artifactPath
					? "check"
					: input.facts || input.missingMaterials || input.toolNeeds
						? "update"
						: "inspect");
			if (action === "inspect") {
				if (Object.keys(input).some((key) => key !== "action"))
					throw new Error(`inspect 只接受 action。${TEMPLATE}`);
				return { content: [{ type: "text", text: JSON.stringify(task) }], details: { researchTask: task } };
			}
			if (action === "update") {
				if (
					input.artifactPath !== undefined ||
					input.kind !== undefined ||
					input.criterion !== undefined ||
					input.expectedSha256 !== undefined ||
					input.jsonPointer !== undefined ||
					input.expected !== undefined ||
					(!input.facts && !input.missingMaterials && !input.toolNeeds && !input.newTask)
				)
					throw new Error(`update 参数无效。${TEMPLATE}`);
				if (input.newTask) {
					const latest = task.inputs.at(-1)!;
					task = {
						...newTask(manager, latest.text),
						inputs: [latest],
						inputHash: hashInputs([latest]),
						modelFit: task.modelFit,
					};
				}
				const fields = new Set<string>();
				for (const fact of input.facts ?? []) {
					if (fields.has(fact.field)) throw new Error("同一个任务字段只能更新一次");
					fields.add(fact.field);
					let saved: ResearchTaskFact;
					if (fact.state === "unknown") {
						if (fact.value !== undefined || fact.inputId !== undefined || fact.quote !== undefined)
							throw new Error("unknown 字段必须省略 value、inputId 与 quote");
						saved = { state: "unknown", value: null, evidence: [] };
					} else {
						const source = task.inputs.find((item) => item.id === fact.inputId);
						// Providers may render NBSP as ASCII space. Recover the exact source span,
						// then save that raw quote, without rewriting the original input.
						const quoteOffset =
							source && fact.quote
								? source.text.replaceAll("\u00a0", " ").indexOf(fact.quote.replaceAll("\u00a0", " "))
								: -1;
						const exactQuote =
							quoteOffset >= 0 && fact.quote && source
								? source.text.slice(quoteOffset, quoteOffset + fact.quote.length)
								: fact.quote;
						if (
							!source ||
							!fact.value?.trim() ||
							!fact.quote?.trim() ||
							!exactQuote ||
							!(
								source.text.includes(exactQuote) ||
								source.attachedPaths?.some((path) => path.includes(exactQuote))
							) ||
							!exactQuote.includes(fact.value)
						)
							throw new Error(`用户声明必须有真实 inputId、quote 和原文中的 value。${TEMPLATE}`);
						if (
							fact.field === "authorization" &&
							(!source.text.includes(exactQuote) ||
								!/授权|许可|同意|允许|自有|我自己的|属于我|我(?:自己)?(?:写|开发|制作)的|自己(?:写|开发|制作)的|自研|\b(?:authori[sz](?:e[ds]?|ation)|consent|permissions?)\b|\b(?:I|we)\s+own\b|\bmy\s+own\b/i.test(
									exactQuote,
								))
						)
							throw new Error("授权说明不能从线上环境或任务标签推断，保持 unknown");
						saved = {
							state: "user_stated",
							value: fact.value,
							evidence: [{ inputId: source.id, quote: exactQuote }],
						};
					}
					task.facts[fact.field] = saved;
				}
				if (input.missingMaterials)
					task.missingMaterials = input.missingMaterials.map((item) => item.trim()).filter(Boolean);
				if (input.toolNeeds) {
					const registered = new Set(registeredToolNames?.() ?? ctx.tools.map((tool) => tool.name));
					task.toolMatches = input.toolNeeds.map((need) => ({
						operation: need.operation,
						requestedTools: [...new Set(need.tools)],
						registeredTools: need.tools.filter((name) => registered.has(name)),
						unavailableTools: need.tools.filter((name) => !registered.has(name)),
					}));
				}
				// Changed interpretation cannot inherit component acceptance from an older task revision.
				task.acceptance = { state: "not_run", goalVerified: false, checks: [] };
				task.status = task.missingMaterials.length ? "needs_input" : "unverified";
			} else {
				if (
					input.facts !== undefined ||
					input.missingMaterials !== undefined ||
					input.toolNeeds !== undefined ||
					input.newTask !== undefined ||
					!input.artifactPath ||
					!input.kind ||
					!input.criterion?.trim() ||
					(input.kind === "sha256" && !input.expectedSha256) ||
					(input.kind === "json_value" &&
						(input.jsonPointer === undefined || !Object.hasOwn(input, "expected"))) ||
					(input.kind !== "sha256" && input.expectedSha256 !== undefined) ||
					(input.kind !== "json_value" && (input.jsonPointer !== undefined || Object.hasOwn(input, "expected")))
				)
					throw new Error(`check 参数无效。${TEMPLATE}`);
				await checkArtifact(
					task,
					{
						artifactPath: input.artifactPath,
						kind: input.kind,
						criterion: input.criterion,
						expectedSha256: input.expectedSha256,
						jsonPointer: input.jsonPointer,
						expected: input.expected,
					},
					ctx,
				);
			}
			signal?.throwIfAborted();
			ctx.signal?.throwIfAborted();
			const saved = persist(manager, task, append);
			return {
				content: [
					{
						type: "text",
						text: `已核对当前任务记录；用户声明不等于独立事实验证，组件检查不等于原目标完成。\n${JSON.stringify(saved)}`,
					},
				],
				details: { researchTask: saved },
			};
		},
	};
}

export function researchTaskInstructions(): string {
	return [
		"任务事实与验收：本轮原请求及 inputHash 已由宿主保存。先调用 research_task update 记录明确的目标、功能、环境、数据来源、授权说明、交付物与验收条件；即使要追问或认为某步受限，也先记录真实已知与未知，不用改变用户原话。",
		"user_stated 仅表示用户确实说过：inputId 从 latestInput 或 previousTask.inputs 复制，quote 必须是该 input 的原文，value 必须是 quote 中的原词。尚未识别说明用 unknown 并省略其它字段。线上场景不证明没有授权；不要补成离线、自研、内存读取、注入或反作弊绕过。",
		"每轮先核对 latestInput 与 previousTask 的关系：同一目标的补充使用原 taskId；用户明确另开目标时用 research_task update 的 newTask=true 建立新记录，仅引用该新输入，不沿用旧事实、阻塞或验收。关系不明时只问最小澄清，不依据单个词自动换目标。原目标记录保留，不能把新目标的成功算作旧目标通过。",
		"明确功能与环境后，继续核对任务真正需要的数据来源和接口。没有来源时不能声称已经读取了线上坐标，也不能认定所有可视化都不可做；只问阻塞本目标的最小资料，不重复已经说明的功能或环境。",
		"工具或模型目录可用只说明注册/输入模态匹配，不证明它会接受本任务或操作可执行。拒绝不自动触发换模型重试，保留当前模型及原始响应；不得为了得到成功标签而虚构授权或暗换目标。",
		"已有产物可用 research_task check 检查工作区文件、哈希或 JSON 字段；检查记录绑定当前 taskId 与 inputHash，工具不运行文件或命令。结果仅认证指定产物条件，原目标是否完成仍需对应真实交付和功能验收，不能把纯数学组件或离线示例通过当作整个原任务成功。",
	].join("\n");
}
