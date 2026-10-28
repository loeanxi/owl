/**
 * Claude 的思考呈现规则。
 *
 * 规格来源：Claude Desktop 打包渲染层（ion-dist/assets/v1/c05b96c7f-DklIyA-P.js）
 * 的 thinking 分支与 xh() / nm() / tm() / im()：
 *
 *   xh(e) = {
 *     summary:          Zg(e)                 = summaries 数组的最后一条
 *     firstContentLine: ss(e.thinking ?? "")  = 原始思考文字的第一行
 *     words:            summary ?? firstContentLine
 *   }
 *
 * 也就是说 Claude Desktop **从不显示原始思考文字**：
 *   - 正文显示的是 provider 给的 summaries（Anthropic API 的官方推理摘要）；
 *   - 原始 thinking 文本只被用来取第一行，当作没有摘要时的标题；
 *   - 标题优先用 summary，没有 summary 才退回第一行。
 *
 * 形态标记（同一段代码里）：
 *   cellSuppressed  只有一段摘要 / 思考是纯 ASCII / 思考为空且无摘要 → 整块不显示
 *   opensInPlace    有 words 且未被抑制 → 就地展开在正文流里
 *   trimFirstRawLine 标题就是第一行 → 去掉原始文本的首行自述（"Let me think…"）
 *   duration        title ?? start/stop 时间戳差 → "Thought for 12s"
 */

/** 一个思考区块的呈现形态。 */
export type ClaudeThinkingShape = {
	/** 显示形态。 */
	kind: "hidden" | "in-place";
	/** 标题（Claude 的 words：摘要优先，其次第一行）。 */
	label?: string;
	/** 显示的正文：就是 summaries 本身。 */
	summaries?: string[];
	/** 是否该把原始思考的首行去掉（标题就是首行时）。 */
	trimFirstRawLine?: boolean;
};

/** 跑动中无标题的兜底（bundle 的 "Thinking"）。 */
export const CLAUDE_THINKING_RUNNING = "Thinking";
/** 收口后无标题的兜底（bundle 的 "Thought about it"）。 */
export const CLAUDE_THINKING_DONE = "Thought about it";

function isBlank(text: string): boolean {
	return text.trim() === "";
}

/**
 * 去掉原始思考的首行（Claude 的 Fb() + trimFirstRawLine）：
 * 标题就是首行时，展开面板从第二行内容开始，不重复标题。
 */
export function trimThinkingFirstRawLine(text: string): string {
	const lines = text.split("\n");
	let index = 0;
	while (index < lines.length && lines[index]!.trim() === "") index += 1;
	const rest = lines
		.slice(index + 1)
		.join("\n")
		.replace(/^\s*\n+/, "");
	return rest.trim() === "" ? text : rest;
}

/** 原始思考文字的第一行有内容的行（Claude 的 ss() + is()）。 */
export function firstContentLine(text: string): string | undefined {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line !== "") return line;
	}
	return undefined;
}

/**
 * 判断一个思考块该以什么形态呈现。
 *
 * @param text 原始思考文字（只用来取第一行做标题，不会被显示）
 * @param summaries provider 给的摘要列表
 * @param fallbackLabel 没有摘要也没有第一行时的兜底标题
 */
export function claudeThinkingShape(
	text: string,
	summaries: readonly string[] | undefined,
	fallbackLabel: string,
): ClaudeThinkingShape {
	// nm(e)：非空摘要。
	const usable = (summaries ?? []).filter((summary) => !isBlank(summary));
	// Zg(e)：取最后一条摘要（Claude 用最新一条，不是第一条）。
	const summary = usable.length > 0 ? usable[usable.length - 1]!.trim() : undefined;
	const line = firstContentLine(text);
	// words = summary ?? firstContentLine
	const words = summary ?? line;

	// im(e)：redacted，或（无任何 ASCII 且空白且无摘要）→ 没有信息量。
	// Claude 的 `!am(t) && X(t).trim() === "" && nm(e).length === 0`：am 是
	// 「含 ASCII」，空白文字必然不含 ASCII，所以这条实际就是「空白且无摘要」。
	// 非空白的纯中文思考**不**隐藏 —— 之前误写成「非空白纯 ASCII 即隐藏」，
	// 把没有摘要的中文思考全藏掉了。
	if (isBlank(text) && usable.length === 0) return { kind: "hidden" };
	// 只有一段摘要：Claude 认为不值得占屏，整块收起来。
	if (usable.length === 1 && isBlank(text)) return { kind: "hidden" };
	// 有摘要但只有一条、同时还有原始文字：标题就是那条摘要，正文是原始思考的第一行。
	if (usable.length === 1) {
		return {
			kind: "in-place",
			label: words ?? fallbackLabel,
			summaries: usable,
			trimFirstRawLine: line !== undefined && line === words,
		};
	}
	if (usable.length > 1) {
		return {
			kind: "in-place",
			label: words ?? fallbackLabel,
			summaries: usable,
			trimFirstRawLine: line !== undefined && line === words,
		};
	}
	// 只有原始文字：没有摘要就不显示正文，标题取第一行。
	// 单行思考在 Claude 里整块隐藏（`ie()`：一句 "Let me think…" 没有可展开的内容）。
	// 这条在 owl 上代价太大（2026-10-28）：模型大量给出只有一句话的思考，全藏之后
	// 整轮只剩工具组头，读起来像内容凭空消失。改为保留那一行——它本来就只是一行，
	// 不展开也不占额外高度。
	if (words === undefined) return { kind: "hidden" };
	return {
		kind: "in-place",
		label: words,
		summaries: undefined,
		trimFirstRawLine: true,
	};
}

/**
 * 时长格式化：对齐 Claude 的 “Thought for {seconds}s / Xm Ys / Xh Ym”。
 */
export function formatThoughtDuration(ms: number): string | undefined {
	const seconds = Math.round(ms / 1000);
	if (seconds <= 0) return undefined;
	if (seconds < 60) return `Thought for ${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest > 0 ? `Thought for ${minutes}m ${rest}s` : `Thought for ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes > 0 ? `Thought for ${hours}h ${restMinutes}m` : `Thought for ${hours}h`;
}
