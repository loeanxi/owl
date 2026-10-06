/**
 * 模型目录实体 —— 移植自 manager `catalog/PublishedModel` + `ModelRoute` + `DiscoveredModel`（容量面）。
 * publicId 是对外模型名；routes 是公开模型 → 平台+上游模型 的有优先级路由表；
 * discovered 是上游探测到的真实容量（withinRouteLimits 的判定依据）。
 */
import type { Platform } from "../platform.ts";

export interface PublishedModel {
	id: string;
	/** 对外唯一模型名。 */
	publicId: string;
	name: string;
	description: string | null;
	/** 上游模型版本提示（如 gpt-5.x），路由版本核对用。 */
	modelVersion: string | null;
	contextWindow: number | null;
	defaultContextWindow: number | null;
	defaultReasoningEffort: string | null;
	maxOutputTokens: number | null;
	supportsImages: boolean;
	supportsTools: boolean;
	/** 模型级支持档位（JSON 数组存储）。 */
	reasoningEfforts: string[];
	published: boolean;
	sortOrder: number;
	updatedAt: number;
}

export interface ModelRoute {
	id: string;
	modelId: string;
	platform: Platform;
	upstreamModel: string;
	priority: number;
	enabled: boolean;
	supportsImages: boolean;
	supportsTools: boolean;
	reasoningEfforts: string[];
}

/** 上游实测容量（发现/核验后的保守值；withinRouteLimits 依据）。 */
export interface DiscoveredCapacity {
	platform: Platform;
	upstreamModel: string;
	available: boolean;
	contextWindow: number | null;
	maxOutputTokens: number | null;
}
