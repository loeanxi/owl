// ---------------------------------------------------------------------------
// 「我的 Token 生涯」看板（career.get）—— 跨 Agent 本地会话记录的 token 用量汇总，
// 数据面见 ./career-stats.ts：owl 复用 usage-stats 全量口径，Claude Code / Codex
// 走 ~/.claude、~/.codex 的增量扫描；Gemini 本地记录无用量、Cursor 待手动导入，只报状态。
// ---------------------------------------------------------------------------

/** 单数据源的用量分桶（cost 只有 owl 实测，其余来源本地记录不含费用，恒为 0）。 */
export interface CareerBucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 推理 token（output 的子集，部分来源不上报）。 */
	reasoning: number;
	totalTokens: number;
}

export interface CareerAgentTotals extends CareerBucket {
	cost: number;
}

/** 数据源接入状态：ok=已接入；nodata=有本地数据但不含用量；detected=检测到产品数据但存储为私有格式待解析；pending=待手动导入；unavailable=未检测到。 */
export type CareerSourceStatus = "ok" | "nodata" | "detected" | "pending" | "unavailable";

export interface CareerAgentUsage {
	id: string;
	name: string;
	status: CareerSourceStatus;
	/** 状态补充说明（无用量 / 待导入的原因），前端直接展示。 */
	note?: string;
	/** 本机数据根目录（展示用，~ 缩写）。 */
	root?: string;
	/** 已计入的会话文件数（删除不回吐口径）。 */
	sessions: number;
	/** 最早 / 最近一次有记录的时间（ISO 或 YYYY-MM-DD，前端按需展示）。 */
	firstAt?: string;
	lastAt?: string;
	totals: CareerAgentTotals;
	/** 升序、本机时区、只含有用量的天。 */
	byDay: { date: string; totalTokens: number }[];
	/** 模型用量降序（key 为各来源原始模型名；owl 为 provider/model）。 */
	byModel: { key: string; totalTokens: number }[];
}

export interface CareerGetRequest {
	type: "career.get";
	id: string;
}

export interface CareerGetResult {
	/** 本次统计的生成时间（ISO），前端据此显示快照时间。 */
	generatedAt: string;
	/** 固定顺序 owl/claude/codex/gemini/cursor，含未接入数据源的占位。 */
	agents: CareerAgentUsage[];
}
