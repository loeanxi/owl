/**
 * 轨迹视图的数据契约 —— 会话转录（ChatEntry[]）到轨迹台账的中间模型。
 *
 * 架构移植自 DeepSeek Harness 的 packages/client/ui-trajectory（BSD-3 前身
 * 为 dsh-client-ui-trajectory）：视图是纯投影层，既不读也不改 Chat 的会话
 * 快照。这里按 owl 自己的转录模型重新落地同样的分层：
 *
 *   ChatEntry[]（hooks/transcript）
 *     → trajectory-layout   折叠成 轮次 → 分组（消息/步骤） → 单元格
 *     → trajectory-timeline 把单元格投影成三车道时间轴（输入/模型/工具）
 *     → TrajectoryView      工具栏统计 + 时间轴 + 事件台账
 */

/** 单元格类别；时间轴车道由它决定（输入=用户，模型=助手消息，工具=工具调用）。 */
export type TrajectoryCellKind = "user" | "message" | "tool" | "subtool";

/** 单条回复/请求的 token 用量（与 transcript 的 MessageUsage 同构）。 */
export interface TrajectoryUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 台账里的一行：一条用户输入、一段助手回复，或一次工具调用。 */
export interface TrajectoryCell {
	/** 轮次内单调递增的 1-based 序号（时间轴 span 与台账行共用）。 */
	index: number;
	kind: TrajectoryCellKind;
	/** 台账行 DOM 锚点（跳转/高亮用）。 */
	recordId: string;
	/** 行首标签：用户/助手，或工具名（grep、read…）。 */
	title: string;
	/** 工具行的人话摘要（动词 + 关键参数），替代裸 JSON 上屏。 */
	summary?: string;
	/** 单行预览正文：用户/助手文本，或工具参数 JSON。 */
	preview?: string;
	/** 结果单行预览（工具行）：`→ Found 10 matches…`。 */
	resultPreview?: string;
	/** 展开详情：参数 JSON（已美化）。 */
	inputDetail?: string;
	/** 展开详情：输出全文。 */
	outputDetail?: string;
	/** 展开详情：思考全文（助手行）。 */
	thinkingDetail?: string;
	isError?: boolean;
	/** 用户主动暂停导致的取消：区别于失败。 */
	cancelled?: boolean;
	/** 调用尚未结束（pending/running）：耗时留空，不虚构时长。 */
	streaming?: boolean;
	/** 自身耗时（秒）；进行中或时间戳缺失时为 null。 */
	timeSeconds: number | null;
	/** epoch ms 开始时刻；旧会话缺时间戳时为 null。 */
	startedAt: number | null;
	/** 结束时刻（epoch ms）；时间轴 span 与轮次墙钟用。 */
	endedAt: number | null;
	usage?: TrajectoryUsage;
	/** 产生本段回复的模型 id（助手行）。 */
	model?: string;
}

/** 一轮里的一个 Message / Step 分组。 */
export interface TrajectoryGroupModel {
	/** 「消息」或「步骤 N」。 */
	title: string;
	/** 墙钟跨度 + 工具直方图，如 `2.3s bash×6 read×2`。 */
	description?: string;
	cells: readonly TrajectoryCell[];
}

/** 一轮对话：从一条已落盘的用户消息到下一条之前。 */
export interface TrajectoryTurnModel {
	turn: number;
	groups: readonly TrajectoryGroupModel[];
	startedAt: number | null;
	endedAt: number | null;
}

/** 顶栏统计：时长 / 轮次 / 调用。 */
export interface TrajectoryStats {
	/** 首个活动开始到末个活动结束的墙钟跨度；时间戳缺失时为 null。 */
	durationMs: number | null;
	turns: number;
	/** 工具调用总数（含子调用）。 */
	calls: number;
	/** 助手回复段数（= LLM 请求数）。 */
	steps: number;
	tokens: TrajectoryUsage;
}

/** 轨迹视图的完整快照：layout 折叠的产物，视图组件只读它。 */
export interface TrajectorySnapshot {
	turns: readonly TrajectoryTurnModel[];
	stats: TrajectoryStats;
}
