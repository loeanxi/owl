/**
 * 对话模型列表过滤：复用 settings.json 的 `enabledModels`（与 CLI `--models` 同格式）。
 *
 * - `undefined` / `null` → 不过滤（全部可用，兼容未配置用户）
 * - 字符串数组（可为空）→ 仅匹配项出现在对话选择器；空数组 = 对话列表为空
 *
 * 匹配：精确 `provider/id`（忽略大小写），或仅 model id；忽略 `:thinking` 后缀。
 */

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;

export type ProviderModelsLike = {
	id: string;
	name?: string;
	authSource?: string;
	models: Array<{ id: string; name?: string; contextWindow?: number; reasoning?: boolean }>;
};

/** 从 settings 原始值解析；非数组视为未配置。 */
export function parseEnabledModels(value: unknown): string[] | null {
	if (value == null) return null;
	if (!Array.isArray(value)) return null;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function modelRef(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

function normalizePattern(pattern: string): string {
	return pattern.replace(THINKING_SUFFIX, "").trim().toLowerCase();
}

/** 单条模型是否落在 allowlist 内；allowlist 为 null 时一律 true。 */
export function isModelInEnabledList(providerId: string, modelId: string, enabled: string[] | null): boolean {
	if (enabled == null) return true;
	const ref = modelRef(providerId, modelId).toLowerCase();
	const idLower = modelId.toLowerCase();
	return enabled.some((pattern) => {
		const normalized = normalizePattern(pattern);
		return normalized === ref || normalized === idLower;
	});
}

/** 供设置页勾选态：null = 全部视为已选。 */
export function isModelMarkedInUse(providerId: string, modelId: string, enabled: string[] | null): boolean {
	if (enabled == null) return true;
	return isModelInEnabledList(providerId, modelId, enabled);
}

/**
 * 勾选变更后算下一份 allowlist。
 * - 勾选后若覆盖当前全部模型 → 返回 null（清除过滤）
 * - 否则返回勾选中的 `provider/id` 列表（可为空）
 */
export function nextEnabledModelsAfterToggle(
	groups: ReadonlyArray<ProviderModelsLike>,
	current: string[] | null,
	providerId: string,
	modelId: string,
	checked: boolean,
): string[] | null {
	return nextEnabledModelsAfterBulkToggle(groups, current, [modelRef(providerId, modelId)], checked);
}

/** 批量勾选/取消（如按供应商全选）；返回规则同 `nextEnabledModelsAfterToggle`。 */
export function nextEnabledModelsAfterBulkToggle(
	groups: ReadonlyArray<ProviderModelsLike>,
	current: string[] | null,
	targets: readonly string[],
	checked: boolean,
): string[] | null {
	const allRefs = groups.flatMap((group) => group.models.map((model) => modelRef(group.id, model.id)));
	const base = current == null ? allRefs : allRefs.filter((ref) => isModelInEnabledList(...splitRef(ref), current));
	const isTarget = (ref: string) => targets.some((target) => refsEqual(ref, target));
	const next = checked
		? uniqueRefs([...base.filter((ref) => !isTarget(ref)), ...targets])
		: base.filter((ref) => !isTarget(ref));
	if (next.length === allRefs.length && allRefs.every((ref) => next.some((entry) => refsEqual(entry, ref)))) {
		return null;
	}
	return next;
}

/** 对话选择器用：null 不过滤；数组则只保留命中模型（空供应商组去掉）。 */
export function filterProvidersByEnabledModels<T extends ProviderModelsLike>(
	providers: readonly T[],
	enabled: string[] | null,
): T[] {
	if (enabled == null) return [...providers];
	return providers
		.map((group) => ({
			...group,
			models: group.models.filter((model) => isModelInEnabledList(group.id, model.id, enabled)),
		}))
		.filter((group) => group.models.length > 0) as T[];
}

function splitRef(ref: string): [string, string] {
	const slash = ref.indexOf("/");
	if (slash <= 0) return ["", ref];
	return [ref.slice(0, slash), ref.slice(slash + 1)];
}

function refsEqual(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function uniqueRefs(refs: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const ref of refs) {
		const key = ref.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}
