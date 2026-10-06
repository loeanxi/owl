/**
 * Key 级思考强度策略 —— 移植自 manager `apikey/EffortPolicy`。
 * 先按改写映射（可按模型 exact/prefix/suffix 限定）重写显式档位，
 * 再施加档位天花板；超限 downgrade（压到天花板，默认）或 deny（403）。
 * 仅作用于刻度内且客户端显式声明的档位；未指定或未知档位原样透传。
 */
import { BusinessError } from "../common/error.ts";
import { EFFORT_ORDER, effortRank, isKnownEffort, normalizeEffort } from "./reasoning-effort-scale.ts";

export const OVER_LIMIT_DOWNGRADE = "downgrade";
export const OVER_LIMIT_DENY = "deny";
export const TO_DENY = "deny";

const MATCH_ALL = "all";
const MATCH_EXACT = "exact";
const MATCH_PREFIX = "prefix";
const MATCH_SUFFIX = "suffix";
const MAX_MAPPINGS = 64;
const MAX_MODEL_LEN = 160;

export interface EffortMapping {
	from: string;
	to: string;
	matchType: string;
	model: string;
}

export interface EffortPolicySpec {
	maxEffort?: string | null;
	overLimit?: string | null;
	mappings?: EffortMapping[] | null;
}

/** 一次策略应用的结果；denied 时 effort 无意义（对齐 Java Applied）。 */
export interface EffortApplied {
	requestedEffort: string | null;
	effort: string | null;
	denied: boolean;
	denialReason: string | null;
	actions: string[];
	rule: string | null;
}

export function passthrough(requested: string | null): EffortApplied {
	return { requestedEffort: requested, effort: requested, denied: false, denialReason: null, actions: [], rule: null };
}

export interface ParsedEffortPolicy {
	maxEffort: string | null;
	overLimit: string;
	mappings: EffortMapping[];
}

/** 从 JSON 解析并校验；空内容返回 null 表示无策略。 */
export function parseEffortPolicy(json: string | null | undefined): ParsedEffortPolicy | null {
	if (json === null || json === undefined || json.trim().length === 0) {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(json) as unknown;
	} catch {
		throw invalidPolicy("思考强度策略必须是合法的 JSON 对象");
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw invalidPolicy("思考强度策略必须是合法的 JSON 对象");
	}
	return validateEffortPolicy(raw as EffortPolicySpec);
}

export function serializeEffortPolicy(policy: ParsedEffortPolicy): string {
	return JSON.stringify(policy);
}

/** 校验并返回规范化副本；字段非法抛 BusinessException。 */
export function validateEffortPolicy(spec: EffortPolicySpec): ParsedEffortPolicy {
	const ceiling = normalizeEffort(spec.maxEffort ?? null);
	if (ceiling !== null && !isKnownEffort(ceiling)) {
		throw invalidPolicy(`思考强度天花板不是已知档位: ${String(spec.maxEffort)}`);
	}
	const action =
		spec.overLimit === null || spec.overLimit === undefined || spec.overLimit.trim().length === 0
			? OVER_LIMIT_DOWNGRADE
			: spec.overLimit.trim().toLowerCase();
	if (action !== OVER_LIMIT_DOWNGRADE && action !== OVER_LIMIT_DENY) {
		throw invalidPolicy(`超限动作只能是 downgrade 或 deny: ${String(spec.overLimit)}`);
	}
	const rawMappings = spec.mappings ?? [];
	if (rawMappings.length > MAX_MAPPINGS) {
		throw invalidPolicy(`档位映射规则不能超过 ${MAX_MAPPINGS} 条`);
	}
	const normalized = rawMappings.map(validateMapping);
	const seen = new Set<string>();
	for (const mapping of normalized) {
		const identity = `${mapping.from}\u0000${mapping.matchType}\u0000${mapping.model}`;
		if (seen.has(identity)) {
			throw invalidPolicy(`重复的档位映射规则: ${mapping.from} -> ${mapping.to}`);
		}
		seen.add(identity);
	}
	return { maxEffort: ceiling, overLimit: action, mappings: normalized };
}

function validateMapping(raw: EffortMapping): EffortMapping {
	const from = normalizeEffort(raw.from ?? null);
	if (from === null || !isKnownEffort(from)) {
		throw invalidPolicy(`档位映射来源必须是已知档位: ${String(raw.from)}`);
	}
	const to = normalizeEffort(raw.to ?? null);
	if (to === null) {
		throw invalidPolicy("档位映射目标不能为空");
	}
	if (to !== TO_DENY && !isKnownEffort(to)) {
		throw invalidPolicy(`档位映射目标必须是已知档位或 deny: ${String(raw.to)}`);
	}
	const model = (raw.model ?? "").trim().toLowerCase();
	if (model.length > MAX_MODEL_LEN) {
		throw invalidPolicy("档位映射的模型限定过长");
	}
	let matchType: string;
	if (model.length === 0) {
		matchType = MATCH_ALL;
	} else {
		matchType =
			raw.matchType === null || raw.matchType === undefined || raw.matchType.trim().length === 0
				? MATCH_EXACT
				: raw.matchType.trim().toLowerCase();
		if (matchType !== MATCH_EXACT && matchType !== MATCH_PREFIX && matchType !== MATCH_SUFFIX) {
			throw invalidPolicy(`模型限定匹配类型只能是 exact、prefix 或 suffix: ${String(raw.matchType)}`);
		}
	}
	return { from, to, matchType, model };
}

/** 对显式请求档位应用策略：映射改写 → 天花板 downgrade/deny。 */
export function applyEffortPolicy(
	policy: ParsedEffortPolicy | null,
	requestedEffort: string | null,
	requestModel: string | null,
): EffortApplied {
	if (policy === null) {
		return passthrough(normalizeEffort(requestedEffort));
	}
	const requested = normalizeEffort(requestedEffort);
	if (requested === null) {
		return passthrough(null);
	}
	// 未知档位不在刻度内，无法比较/改写，原样透传
	if (!isKnownEffort(requested)) {
		return passthrough(requested);
	}
	const model = (requestModel ?? "").trim().toLowerCase();
	const actions: string[] = [];
	const rules: string[] = [];
	let effective = requested;

	const mapping = selectMapping(policy, requested, model);
	if (mapping !== null) {
		actions.push("mapping");
		rules.push(`${mapping.from}->${mapping.to}${mapping.model.length === 0 ? "" : `@${mapping.model}`}`);
		if (mapping.to === TO_DENY) {
			return {
				requestedEffort,
				effort: null,
				denied: true,
				denialReason: `思考等级 ${requested} 被该密钥的映射策略拒绝`,
				actions,
				rule: rules.join(","),
			};
		}
		effective = mapping.to;
	}

	const ceiling = policy.maxEffort;
	if (ceiling !== null && isKnownEffort(ceiling) && effortRank(effective) > effortRank(ceiling)) {
		rules.push(`max=${ceiling}`);
		if (policy.overLimit === OVER_LIMIT_DENY) {
			actions.push("ceiling_deny");
			return {
				requestedEffort,
				effort: null,
				denied: true,
				denialReason: `思考等级 ${effective} 超出该密钥的上限 ${ceiling}`,
				actions,
				rule: rules.join(","),
			};
		}
		actions.push("ceiling_downgrade");
		effective = ceiling;
	}
	if (actions.length === 0) {
		return passthrough(requested);
	}
	return { requestedEffort, effort: effective, denied: false, denialReason: null, actions, rule: rules.join(",") };
}

/** 模型限定的映射优先于全局映射（exact > prefix > suffix > all 的优先级按 Java 实现：模型限定者优先）。 */
function selectMapping(policy: ParsedEffortPolicy, requested: string, model: string): EffortMapping | null {
	let best: EffortMapping | null = null;
	let bestScore = -1;
	for (const mapping of policy.mappings) {
		if (mapping.from !== requested) {
			continue;
		}
		const score = matchScore(mapping, model);
		if (score > bestScore) {
			best = mapping;
			bestScore = score;
		}
	}
	return best;
}

function matchScore(mapping: EffortMapping, model: string): number {
	if (mapping.matchType === MATCH_ALL || mapping.model.length === 0) {
		return 1;
	}
	if (mapping.matchType === MATCH_EXACT && mapping.model === model) {
		return 4;
	}
	if (mapping.matchType === MATCH_PREFIX && model.startsWith(mapping.model)) {
		return 3;
	}
	if (mapping.matchType === MATCH_SUFFIX && model.endsWith(mapping.model)) {
		return 2;
	}
	return -1;
}

function invalidPolicy(message: string): BusinessError {
	return BusinessError.of("apikey.invalidEffortPolicy", message);
}

/** 刻度常量再导出，方便域外使用。 */
export { EFFORT_ORDER };
