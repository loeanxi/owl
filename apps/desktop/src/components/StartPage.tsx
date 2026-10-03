/**
 * 开始页 —— 空会话时聊天列的欢迎屏，排版照搬 DSH 的"开始"页：居中 logo +
 * 纵向排列的大圆角菜单卡（彩色图标在左、快捷键提示在右）。可用项直接打开
 * 工作台对应面板；终端 / 浏览器是占位卡（owl 暂无该宿主能力），置灰展示
 * 未来绑定，与 DSH paneCard 的 disabled 态一致。
 */
import { QUICK_ACTIONS } from "../sidebar/quick.tsx";
import { isTabKindEnabled, useSidebarConfig } from "../sidebar/config.ts";

export function StartPage({ onAction }: { onAction: (kind: string) => void }): React.JSX.Element {
	// 侧边卡片设置停用的卡片不在开始页出现（订阅配置，设置页改动即时生效）
	const cfg = useSidebarConfig();
	const actions = QUICK_ACTIONS.filter((action) => !action.disabled && isTabKindEnabled(action.kind, cfg));
	return (
		<div className="mt-[12vh] flex flex-col items-center px-6">
			<img src="/owl.svg" alt="" className="h-12 w-12 opacity-90" />
			<p className="mt-5 font-serif text-2xl text-owl-text">✳ 有什么可以帮你的？</p>
			<p className="mt-2 text-sm text-owl-faint">比 pi 更轻的 coding agent · 发消息开始</p>

			<div className="mt-8 flex w-full max-w-xl flex-col gap-2.5">
				{actions.map((action) => (
					<button
						key={action.kind}
						type="button"
						title={action.label}
						className="flex min-h-13 items-center gap-3.5 rounded-2xl border border-owl-border/70 bg-owl-panel px-5 py-3.5 text-left text-sm text-owl-text transition-colors hover:bg-owl-hover"
						onClick={() => onAction(action.kind)}
					>
						<span className="shrink-0" style={{ color: action.color }}>
							{action.icon(18)}
						</span>
						<span className="flex-1">{action.label}</span>
						{action.hint && <span className="shrink-0 text-xs text-owl-faint">{action.hint}</span>}
					</button>
				))}
			</div>
		</div>
	);
}
