/**
 * Trae 可见模型目录 —— 移植自 manager `TraeModelCatalogClient`。
 * 会话换 JWT 后，合并 SOLO 可见名单和各 function 的可调用配置。
 */
import type { Account } from "owl-pool";
import { parseCredentials } from "owl-pool";
import { TraeChatClient, type TraeChatConfig } from "../gateway/trae-client.ts";

const REMOTE_PATH = "/api/remote/v1/models?functions=solo_agent_remote,solo_work_remote,solo_design_remote";
const DETAIL_PATH = "/api/ide/v1/get_detail_param";
const DETAIL_FUNCTIONS = ["solo_work_remote", "solo_work_lite", "solo_agent_lite", "solo_design_lite"];

export interface TraeCatalogModel {
	upstreamModel: string;
	name: string;
	contextWindow: number | null;
	maxOutputTokens: number | null;
	upstreamMultimodal: boolean | null;
	modes: string[];
}

export async function fetchTraeCatalog(
	account: Account,
	config: TraeChatConfig,
	remoteBaseUrl = "https://solo.trae.cn",
): Promise<TraeCatalogModel[]> {
	const credentials = parseCredentials(account);
	const session = typeof credentials.session === "string" ? credentials.session.trim() : "";
	if (session.length === 0) {
		throw new Error("Trae 账号缺少 session");
	}
	const client = new TraeChatClient({ config });
	let jwt: string;
	try {
		jwt = await client.exchangeToken(session);
	} catch {
		throw new Error("Trae 会话认证失败");
	}
	const remote = await getJson(
		`${remoteBaseUrl.replace(/\/$/, "")}${REMOTE_PATH}`,
		{
			Authorization: `Cloud-IDE-JWT ${jwt}`,
			"x-trae-client-type": "web",
			"x-trae-user-timezone": "Asia/Shanghai",
			"x-preferenced-language": "zh-cn",
			Referer: "https://solo.trae.cn/",
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		},
		"Trae 可见模型目录",
	);
	const details = new Map<string, Record<string, unknown>>();
	for (const functionName of DETAIL_FUNCTIONS) {
		const body = JSON.stringify({
			function: functionName,
			config_names: null,
			need_prompt: false,
			current_config_info: null,
			poly_prompt: true,
			mode_type: null,
			agent_type: null,
		});
		const detail = await postJson(
			`${config.chatBaseUrl.replace(/\/$/, "")}${DETAIL_PATH}`,
			body,
			{
				...client.agentHeaders(account, credentials, jwt),
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			`Trae 可调用模型目录（${functionName}）`,
		);
		details.set(functionName, detail);
	}
	return mergeTraeCatalog(remote, details);
}

export function mergeTraeCatalog(
	remote: Record<string, unknown>,
	details: Map<string, Record<string, unknown>>,
): TraeCatalogModel[] {
	const data = recordOf(remote.data);
	const groups = Array.isArray(data?.list) ? data.list : [];
	if (groups.length === 0 || Number(remote.code) !== 0) {
		throw new Error("Trae 可见模型目录为空或结构异常");
	}
	const byId = new Map<string, Wire>();
	const byName = new Map<string, Wire>();
	for (const [functionName, detail] of details) {
		const configs = Array.isArray(detail.config_info_list) ? detail.config_info_list : [];
		if (configs.length === 0) {
			throw new Error(`Trae 可调用模型目录为空或结构异常（${functionName}）`);
		}
		for (const config of configs) {
			if (!isRecord(config)) {
				continue;
			}
			const id = text(config.config_name);
			if (id === null) {
				continue;
			}
			const display = text(recordOf(config.display_config)?.display_name);
			const modelDetail = Array.isArray(config.model_detail_list) ? config.model_detail_list[0] : undefined;
			const detailRecord = isRecord(modelDetail) ? modelDetail : {};
			const wire: Wire = {
				id,
				functionName,
				contextWindow: positiveLong(detailRecord.prompt_max_tokens),
				maxOutputTokens: positiveInt(detailRecord.max_tokens),
			};
			byId.set(key(id), wire);
			if (display !== null) {
				byName.set(key(display), wire);
			}
		}
	}
	if (byId.size === 0) {
		throw new Error("Trae 可调用模型目录没有有效模型");
	}
	const found = new Map<string, Mutable>();
	for (const group of groups) {
		if (!isRecord(group)) {
			continue;
		}
		const mode = modeOf(text(group.function));
		if (mode === null || !Array.isArray(group.models)) {
			continue;
		}
		for (const candidate of group.models) {
			if (!isRecord(candidate)) {
				continue;
			}
			if (candidate.is_preset === false || candidate.status === false || candidate.selectable === false) {
				continue;
			}
			const visibleId = text(candidate.name);
			const display = text(candidate.display_name);
			if (visibleId === null || visibleId.length > 256 || visibleId.includes("/")) {
				continue;
			}
			const wire = byId.get(key(visibleId)) ?? (display === null ? undefined : byName.get(key(display)));
			if (wire === undefined) {
				continue;
			}
			const multimodal = typeof candidate.multimodal === "boolean" ? candidate.multimodal : null;
			const reported = positiveLong(recordOf(candidate.context_window_tokens)?.dev);
			const contextWindow = reported ?? wire.contextWindow;
			const preferred = mode === wireMode(wire.functionName);
			let model = found.get(key(wire.id));
			if (model === undefined) {
				model = {
					id: wire.id,
					name: display ?? visibleId,
					contextWindow,
					maxOutputTokens: wire.maxOutputTokens,
					upstreamMultimodal: multimodal,
					preferred,
					modes: new Set<string>(),
				};
				found.set(key(wire.id), model);
			} else if (preferred && !model.preferred) {
				model.name = display ?? visibleId;
				model.contextWindow = contextWindow;
				model.upstreamMultimodal = multimodal;
				model.preferred = true;
			}
			model.modes.add(mode);
		}
	}
	if (found.size === 0) {
		throw new Error("Trae 可见目录与可调用目录没有匹配模型");
	}
	return [...found.values()].map((model) => ({
		upstreamModel: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxOutputTokens,
		upstreamMultimodal: model.upstreamMultimodal,
		modes: ["Work", "Code", "Design"].filter((mode) => model.modes.has(mode)),
	}));
}

interface Wire {
	id: string;
	functionName: string;
	contextWindow: number | null;
	maxOutputTokens: number | null;
}

interface Mutable {
	id: string;
	name: string;
	contextWindow: number | null;
	maxOutputTokens: number | null;
	upstreamMultimodal: boolean | null;
	preferred: boolean;
	modes: Set<string>;
}

async function getJson(url: string, headers: Record<string, string>, label: string): Promise<Record<string, unknown>> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) {
		throw new Error(`${label}请求失败（HTTP ${response.status}）`);
	}
	return readJson(await response.text(), label);
}

async function postJson(
	url: string,
	body: string,
	headers: Record<string, string>,
	label: string,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) {
		throw new Error(`${label}请求失败（HTTP ${response.status}）`);
	}
	return readJson(await response.text(), label);
}

function readJson(textValue: string, label: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(textValue);
		if (isRecord(parsed)) {
			return parsed;
		}
	} catch {
		// 响应体可能含凭据，错误里不带回原文
	}
	throw new Error(`${label}响应结构异常`);
}

function modeOf(functionName: string | null): string | null {
	if (functionName === "solo_agent_remote") {
		return "Code";
	}
	if (functionName === "solo_work_remote") {
		return "Work";
	}
	if (functionName === "solo_design_remote") {
		return "Design";
	}
	return null;
}

function wireMode(functionName: string): string | null {
	if (functionName.startsWith("solo_work_")) {
		return "Work";
	}
	if (functionName.startsWith("solo_agent_")) {
		return "Code";
	}
	if (functionName.startsWith("solo_design_")) {
		return "Design";
	}
	return null;
}

function key(value: string): string {
	return value.trim().toLowerCase();
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveLong(value: unknown): number | null {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : null;
}

function positiveInt(value: unknown): number | null {
	const number = positiveLong(value);
	return number === null || number > 2_147_483_647 ? null : number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
