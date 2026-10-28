/**
 * 回答的赞/跌反馈。
 *
 * 规格来源：Claude Desktop 的回答操作栏
 *   - `c4a9ee384-ZZIKqgNM.js`：`case "feedback"` 渲染**两个**按钮
 *     （`Re.PositiveFeedbackAction` / `Re.NegativeFeedbackAction`，图标是
 *     ThumbsUp / ThumbsDown），带 `pressed` 态表示当前选了哪个；
 *     点同一个再点一次就是取消。`savedFeedback` 是一个值（`"up"` / `"down"`），
 *     所以赞和跌**互斥**。
 *   - `shared-104-Cqo2-vQh.js`：文案 `Good response` / `Bad response`。
 *   - `ca2ef848d-CWUk7Rll.js`：操作栏顺序
 *     `assistant: ["copy","readAloud","feedback","retry","branch"]`
 *     —— feedback 排在 copy 之后、retry 之前。
 *   - `c368fdb57-TPOrFKUt.js`：踩之后的表单 —— 标签「Tell us more (optional)」、
 *     4 行文本框、placeholder「What's working well or could be improved?」、
 *     Cancel / Submit，提交后 toast「Thanks for the feedback」。
 *
 * owl 的落点与 Claude 的一处**必要差异**：Claude 把评分提交给 Anthropic
 * （用来改进模型），owl 没有那个后端。所以评分记在本地（按会话存），
 * 而用户写的理由走 owl 既有的反馈通道 —— 交给模型本人看。
 */

/** 评分：赞 / 跌。互斥 —— 同时只有一个。 */
export type AnswerRating = "up" | "down";

/** 一条回答的反馈记录。 */
export interface AnswerFeedbackRecord {
	rating: AnswerRating;
	/** 用户补的理由（点踩时可填，可留空）。 */
	reason?: string;
}

/** 评分按会话存一份（一条回答一条）。 */
export function feedbackStoreKey(sessionId: string): string {
	return `owl.feedback.${sessionId}`;
}

/** 读一份会话的全部评分。存坏了就当没有。 */
export function loadFeedback(sessionId: string): Record<string, AnswerFeedbackRecord> {
	try {
		const raw = localStorage.getItem(feedbackStoreKey(sessionId));
		if (raw === null) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const result: Record<string, AnswerFeedbackRecord> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value === null || typeof value !== "object") continue;
			const record = value as { rating?: unknown; reason?: unknown };
			if (record.rating !== "up" && record.rating !== "down") continue;
			result[key] = {
				rating: record.rating,
				...(typeof record.reason === "string" && record.reason !== "" ? { reason: record.reason } : {}),
			};
		}
		return result;
	} catch {
		return {};
	}
}

/** 写回一份会话的全部评分。写不进去（配额满等）就放弃，不能拖垮阅读。 */
export function saveFeedback(sessionId: string, records: Record<string, AnswerFeedbackRecord>): void {
	try {
		localStorage.setItem(feedbackStoreKey(sessionId), JSON.stringify(records));
	} catch {
		// 配额满等场景：评分丢就丢
	}
}

/**
 * 评分切换：点同一个取消，点另一个换过去。
 *
 * 返回新的评分（`undefined` = 取消）。
 */
export function toggleRating(current: AnswerRating | undefined, rating: AnswerRating): AnswerRating | undefined {
	return current === rating ? undefined : rating;
}

/**
 * 反馈正文：交给模型看的那段话。
 *
 * 与 owl 既有的改动评论反馈（`formatDiffFeedback`）同一路数 —— 一句说明
 * 加用户的原话，模型知道这是对它上一条回答的意见。
 */
export function formatAnswerFeedback(rating: AnswerRating, reason: string, english: boolean): string {
	const trimmed = reason.trim();
	if (trimmed === "") return "";
	const heading = english
		? rating === "down"
			? "The previous answer did not help. Here is why:"
			: "The previous answer helped. Here is what worked:"
		: rating === "down"
			? "上一条回答没帮上忙，原因是："
			: "上一条回答帮上忙，做得对的地方是：";
	return `${heading}\n${trimmed}`;
}
