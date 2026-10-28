/**
 * Claude 的「中断」标记。
 *
 * 规格来源：Claude Desktop 打包渲染层 `cc1aae219-DjR8LnUv.js` 的 `ID()`：
 *
 *   function ID(e, t) {
 *     return e == null ? (t === false ? "interrupted" : "streaming")
 *                      : ND.has(e) ? "finished" : "interrupted";
 *   }
 *
 * 也就是说 Claude 把一轮的状态分成三种：**streaming / finished / interrupted**，
 * 中断是独立的一态，不是「出错」的同义词 —— 已经出来的内容照常留下，
 * 只是这一轮没跑完。
 *
 * owl 的 transcript 已经把「用户主动暂停」和「provider 报错」分开了
 * （`entry.aborted` 与 `entry.error`）。这里补的是 Claude 形态的呈现：
 * 一行置灰的小字，不上红。
 */

/** 一轮的状态。 */
export type ClaudeTurnState = "streaming" | "finished" | "interrupted";

/**
 * 由「是否还在流式」与「是否被中断」推出这一轮的状态。
 *
 * @param streaming 这一轮是否还在流式输出
 * @param aborted 是否被用户中断
 */
export function claudeTurnState(streaming: boolean, aborted: boolean): ClaudeTurnState {
	if (aborted) return "interrupted";
	return streaming ? "streaming" : "finished";
}

/**
 * 中断标记。
 *
 * 形态：一行置灰的小字，前面一个中断符号。不加红、不加边框 ——
 * Claude 的中断不是错误。
 */
export function ClaudeInterruptedRow({ label }: { label: string }): React.JSX.Element {
	return (
		<div className="owl-claude-interrupted" role="status">
			<span className="owl-claude-interrupted-mark" aria-hidden="true">
				■
			</span>
			<span className="owl-claude-interrupted-text">{label}</span>
		</div>
	);
}
