/**
 * 已知思考档位的统一刻度（从弱到强）—— 移植自 manager `catalog/ReasoningEffortScale`。
 * 未知档位无法比较：策略天花板与降档收敛都只作用于刻度内的档位，刻度外原样透传。
 */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type KnownEffort = (typeof EFFORT_ORDER)[number];

export function normalizeEffort(effort: string | null | undefined): string | null {
	if (effort === null || effort === undefined) {
		return null;
	}
	const value = effort.trim().toLowerCase();
	return value.length === 0 ? null : value;
}

/** 档位在刻度中的序号（0 起）；未知返回 -1。 */
export function effortRank(effort: string | null | undefined): number {
	const value = normalizeEffort(effort);
	if (value === null) {
		return -1;
	}
	return (EFFORT_ORDER as readonly string[]).indexOf(value);
}

export function isKnownEffort(effort: string | null | undefined): boolean {
	return effortRank(effort) >= 0;
}

/**
 * 主路由的档位收敛：显式声明的档位被主路由支持则原样；compatible 模式下
 * 向刻度下方收敛到最近 supported 档；否则 null（不匹配）。
 */
export function convergeEffort(requested: string | null, supported: string[], compatible: boolean): string | null {
	if (requested === null) {
		return null;
	}
	if (supported.includes(requested)) {
		return requested;
	}
	if (!compatible) {
		return null;
	}
	const index = effortRank(requested);
	for (let lower = index - 1; lower >= 0; lower--) {
		const candidate = EFFORT_ORDER[lower];
		if (candidate !== undefined && supported.includes(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * 兜底路由的档位收敛：优先向上找更强档（保能力），没有再向下（保可用）。
 * 都没有返回 null（该兜底路由不可用）。
 */
export function nearestEffort(requested: string | null, supported: string[]): string | null {
	if (requested === null || supported.length === 0) {
		return null;
	}
	if (supported.includes(requested)) {
		return requested;
	}
	const index = effortRank(requested);
	if (index < 0) {
		return null;
	}
	for (let stronger = index + 1; stronger < EFFORT_ORDER.length; stronger++) {
		const candidate = EFFORT_ORDER[stronger];
		if (candidate !== undefined && supported.includes(candidate)) {
			return candidate;
		}
	}
	for (let weaker = index - 1; weaker >= 0; weaker--) {
		const candidate = EFFORT_ORDER[weaker];
		if (candidate !== undefined && supported.includes(candidate)) {
			return candidate;
		}
	}
	return null;
}
