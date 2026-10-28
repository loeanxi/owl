/**
 * Claude 的用户消息气泡规格。
 *
 * 规格来源：Claude Desktop 打包渲染层 `cc1aae219-DjR8LnUv.js` 的 `RD()`：
 *
 *   function RD(e, t, n) {
 *     return `${N_[n]} ${e ? "w-full" : "w-fit"} min-w-64 max-w-[85%] rounded-xl
 *             border bg-white dark:bg-surface-0 shadow-xs shadow-always-black/5
 *             has-[[data-turn-title]:focus-visible]:shadow-focus overflow-hidden font-sans`;
 *   }
 *
 * 配合 `c6a992d55-sXiDGMFQ.css` 里的 token：
 *
 *   .rounded-xl { border-radius: var(--radius-xl); }        --radius-xl: .75rem
 *   .min-w-64   { min-width: calc(var(--spacing) * 64); }  --spacing: .25rem → 16rem
 *   .shadow-xs  { --tw-shadow: 0 1px 2px 0 #0000000d; }    即 5% 黑
 *   .bg-surface-0 { background-color: var(--cds-surface-0); }  --cds-surface-0: --cds-gray-20
 *
 * 也就是说 Claude 的用户气泡**不是实心灰底**，而是：
 * 描边 + 表面色底 + 极轻投影 + 12px 圆角 + 最小 16rem 宽、最多 85% 宽。
 *
 * owl 原本是实心气泡（`--color-owl-bubble` 填充 + 16px 圆角 + 无描边），
 * 和 Claude 的观感差一截。这里把 Claude 的规格逐条落成 CSS 变量，
 * 由 `claude-flow-cards.css` 消费；规格本身留在 TS 里，方便断言。
 */

/** Claude 用户气泡的规格（数值逐条来自 bundle）。 */
export const CLAUDE_USER_BUBBLE = {
	/** `rounded-xl` → `--radius-xl: .75rem`。 */
	radius: "0.75rem",
	/** `min-w-64` → `--spacing: .25rem` × 64。 */
	minWidth: "16rem",
	/** `max-w-[85%]`。 */
	maxWidth: "85%",
	/** `shadow-xs` → `0 1px 2px 0 rgb(0 0 0 / 0.05)`。 */
	shadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
	/** `border` → 1px。 */
	borderWidth: "1px",
	/** `bg-white`（亮色）。 */
	backgroundLight: "#ffffff",
} as const;

/** 气泡在 Claude 模式下的 CSS 类名。 */
export const CLAUDE_USER_BUBBLE_CLASS = "owl-claude-user-bubble";
