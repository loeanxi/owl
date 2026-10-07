/**
 * WorkBuddy 官方可见模型 —— 移植自 manager `ModelCatalogService.fetchWorkBuddyVisibleModels`。
 * 读 /v3/config，按默认 Agent 白名单过滤，并去掉付费复制线路。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { Account } from "owl-pool";
import { parseCredentials } from "owl-pool";

export interface WorkBuddyCatalogConfig {
	baseUrl: string;
	userAgent: string;
	origin: string;
	referer: string;
	modelsPath?: string;
	authFileRoots?: string[];
}

export interface WorkBuddyVisibleModel {
	upstreamModel: string;
	name: string;
	modelVersion: string | null;
	contextWindow: number | null;
	maxOutputTokens: number | null;
	supportsImages: boolean | null;
	supportsTools: boolean | null;
	reasoningEfforts: string[] | null;
	defaultReasoningEffort: string | null;
}

export async function fetchWorkBuddyVisibleModels(
	account: Account,
	config: WorkBuddyCatalogConfig,
): Promise<WorkBuddyVisibleModel[]> {
	const token = workBuddyToken(account, config.authFileRoots ?? []);
	const path = config.modelsPath ?? "/v3/config";
	const url =
		path.startsWith("http://") || path.startsWith("https://") ? path : `${config.baseUrl.replace(/\/$/, "")}${path}`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": config.userAgent,
			Origin: config.origin,
			Referer: config.referer,
			Accept: "application/json, text/plain, */*",
			"X-Requested-With": "XMLHttpRequest",
			"X-Product": "SaaS",
			"X-No-User-Id": "1",
			"X-No-Enterprise-Id": "1",
			"X-No-Department-Info": "1",
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(
			response.status === 401 || response.status === 403
				? `WorkBuddy 模型配置鉴权失败（HTTP ${response.status}）`
				: `WorkBuddy 模型配置请求失败（HTTP ${response.status}）`,
		);
	}
	return parseWorkBuddyVisibleModels(await response.text());
}

export function parseWorkBuddyVisibleModels(body: string): WorkBuddyVisibleModel[] {
	if (body.trim().length === 0) {
		throw new Error("WorkBuddy 模型配置响应为空");
	}
	let root: unknown;
	try {
		root = JSON.parse(body);
	} catch {
		throw new Error("WorkBuddy 模型配置返回非 JSON");
	}
	if (!isRecord(root)) {
		throw new Error("WorkBuddy 模型配置结构异常");
	}
	const code = root.code;
	if (code !== undefined && code !== null && String(code) !== "0" && String(code) !== "200") {
		throw new Error("WorkBuddy 模型配置接口返回业务错误");
	}
	const config = isRecord(root.data) ? root.data : null;
	const models = Array.isArray(config?.models) ? config.models.filter(isRecord) : [];
	const agents = Array.isArray(config?.agents) ? config.agents.filter(isRecord) : [];
	if (config === null || models.length === 0 || agents.length === 0) {
		throw new Error("WorkBuddy 模型配置缺少模型或 Agent 列表");
	}
	const available = config.availableModels;
	if (available !== undefined && available !== null && !Array.isArray(available)) {
		throw new Error("WorkBuddy 可用模型配置结构异常");
	}
	if (Array.isArray(available) && available.length === 0) {
		throw new Error("WorkBuddy 可用模型白名单为空");
	}
	const allowed = new Set<string>();
	if (Array.isArray(available)) {
		for (const value of available) {
			if (typeof value === "string") {
				allowed.add(value);
			}
		}
		if (allowed.size === 0) {
			throw new Error("WorkBuddy 可用模型白名单无有效项");
		}
	}
	const filtered = models.filter((model) => {
		const id = firstText(model, "id");
		if (id === null || id.length > 80 || id.includes(" ") || id.includes("@")) {
			return false;
		}
		return allowed.size === 0 || allowed.has(id);
	});
	const agent = selectAgent(agents);
	const declared = agent === undefined || !Array.isArray(agent.models) ? [] : agent.models;
	if (declared.length === 0) {
		throw new Error("WorkBuddy 默认 Agent 模型白名单为空");
	}
	const selected: Array<Record<string, unknown>> = [];
	const selectedIds = new Set<string>();
	for (const item of declared) {
		if (typeof item !== "string") {
			continue;
		}
		for (const model of filtered) {
			const id = firstText(model, "id");
			const name = firstText(model, "name");
			if (id !== null && (item === id || item === name) && !isCustom(model) && !selectedIds.has(id)) {
				selectedIds.add(id);
				selected.push(model);
				break;
			}
		}
	}
	if (selected.length === 0) {
		throw new Error("WorkBuddy 默认 Agent 白名单未匹配到官方模型");
	}
	const paid = paidIds(config);
	const visible: WorkBuddyVisibleModel[] = [];
	for (const model of selected) {
		const id = firstText(model, "id");
		if (id === null || paid.has(id)) {
			continue;
		}
		const reasoning = isRecord(model.reasoning) ? model.reasoning : {};
		const efforts = reportedEfforts(model);
		const fromReasoning = efforts.length === 0 ? reportedEfforts(reasoning) : efforts;
		visible.push({
			upstreamModel: id,
			name: firstText(model, "name", "displayName", "display_name") ?? id,
			modelVersion: firstText(model, "modelVersion", "version"),
			contextWindow: contextWindow(model),
			maxOutputTokens: positiveInt(model.maxOutputTokens),
			supportsImages: optionalBoolean(model.supportsImages),
			supportsTools: optionalBoolean(model.supportsToolCall),
			reasoningEfforts: fromReasoning.length === 0 ? null : fromReasoning,
			defaultReasoningEffort: firstText(reasoning, "defaultEffort", "effort"),
		});
	}
	if (visible.length === 0) {
		throw new Error("WorkBuddy 官方可见模型列表为空");
	}
	return visible;
}

export function workBuddyToken(account: Account, roots: string[]): string {
	const credentials = parseCredentials(account);
	const direct = typeof credentials.accessToken === "string" ? credentials.accessToken.trim() : "";
	if (direct.length > 0 && !direct.startsWith("$")) {
		return direct;
	}
	const file = typeof credentials.authFile === "string" ? credentials.authFile : "";
	if (file.length > 0) {
		const token = readAccessTokenFromFile(file, roots);
		if (token !== null && token.trim().length > 0) {
			return token;
		}
	}
	throw new Error("WorkBuddy 账号缺少有效访问凭据");
}

function selectAgent(agents: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
	let cli: Record<string, unknown> | undefined;
	let first: Record<string, unknown> | undefined;
	for (const agent of agents) {
		const name = firstText(agent, "name");
		if (name === null) {
			continue;
		}
		if (hasTag(agent, "default")) {
			return agent;
		}
		if (cli === undefined && name === "cli") {
			cli = agent;
		}
		if (first === undefined && Array.isArray(agent.models) && agent.models.length > 0) {
			first = agent;
		}
	}
	return cli ?? first;
}

function paidIds(config: Record<string, unknown>): Set<string> {
	const features = isRecord(config.productFeaturesConfig) ? config.productFeaturesConfig : {};
	const cap = isRecord(features.ModelRateLimitCap) ? features.ModelRateLimitCap : {};
	const lines = Array.isArray(cap.lines) ? cap.lines : [];
	const paid = new Set<string>();
	for (const line of lines) {
		if (!isRecord(line)) {
			continue;
		}
		const freeId = firstText(line, "freeId");
		const paidId = firstText(line, "paidId");
		if (freeId !== null && paidId !== null) {
			paid.add(paidId);
		}
	}
	if (paid.size === 0) {
		paid.add("hy3-x");
		paid.add("hy4-x");
	}
	return paid;
}

function isCustom(model: Record<string, unknown>): boolean {
	const id = firstText(model, "id");
	return id === null || id.startsWith("custom:") || id.startsWith("custom-local:") || hasTag(model, "custom");
}

function hasTag(node: Record<string, unknown>, expected: string): boolean {
	return Array.isArray(node.tags) && node.tags.some((tag) => tag === expected);
}

function reportedEfforts(node: Record<string, unknown>): string[] {
	const raw = node.reasoningEfforts ?? node.efforts;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function contextWindow(model: Record<string, unknown>): number | null {
	const values = [
		positiveLong(model.contextWindow),
		positiveLong(model.maxInputTokens),
		positiveLong(model.maxAllowedSize),
	].filter((value): value is number => value !== null);
	return values.length === 0 ? null : Math.min(...values);
}

function firstText(node: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = node[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return null;
}

function positiveLong(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function positiveInt(value: unknown): number | null {
	const number = positiveLong(value);
	return number === null || number > 2_147_483_647 ? null : number;
}

function optionalBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function readAccessTokenFromFile(authFile: string, authFileRoots: string[]): string | null {
	const path = normalize(isAbsolute(authFile) ? authFile : join(process.cwd(), authFile));
	const lower = path.replaceAll("\\", "/").toLowerCase();
	const allowedName = lower.endsWith("/workbuddy-desktop.info") || lower === "workbuddy-desktop.info";
	const allowedRoot = authFileRoots.some((root) => {
		const rel = relative(normalize(root), path);
		return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
	});
	if (!allowedName && !allowedRoot) {
		throw new Error("凭据文件路径不被允许。仅接受 workbuddy-desktop.info，或白名单目录内的文件");
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`读取凭据文件失败: ${error instanceof Error ? error.message : String(error)}`);
	}
	let root: unknown;
	try {
		root = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(root)) {
		return null;
	}
	const direct = root.accessToken;
	if (typeof direct === "string" && direct.trim().length > 0 && !direct.startsWith("$")) {
		return direct;
	}
	const session = root.session;
	if (
		isRecord(session) &&
		typeof session.accessToken === "string" &&
		session.accessToken.trim().length > 0 &&
		!session.accessToken.startsWith("$")
	) {
		return session.accessToken;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
