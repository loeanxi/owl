import { isTabKindEnabled, useSidebarConfig } from "../sidebar/config.ts";
import { QUICK_ACTIONS } from "../sidebar/quick.tsx";
import { IconFolder } from "./icons.tsx";
import "./start-page.css";

const PRIMARY_ACTION_COPY: Record<string, { title: string; description: string }> = {
	files: { title: "浏览项目文件", description: "熟悉项目与代码" },
	changes: { title: "查看文件变动", description: "审阅每一处修改" },
	browser: { title: "打开浏览器", description: "查看页面与效果" },
};

/** 空会话欢迎页。所有入口沿用工作台配置与打开逻辑，设置停用的面板即时隐藏。 */
export function StartPage({ onAction }: { onAction: (kind: string) => void }): React.JSX.Element {
	const cfg = useSidebarConfig();
	const actions = QUICK_ACTIONS.filter((action) => !action.disabled && isTabKindEnabled(action.kind, cfg));
	const primaryActions = actions.flatMap((action) => {
		const copy = PRIMARY_ACTION_COPY[action.kind];
		return copy ? [{ ...action, ...copy }] : [];
	});
	const secondaryActions = actions.filter((action) => !PRIMARY_ACTION_COPY[action.kind]);

	return (
		<section className="owl-start-page" aria-labelledby="owl-start-heading">
			<img src="/owl.svg" alt="" className="owl-start-mark" draggable={false} />
			<p className="owl-start-eyebrow">YOUR LOCAL CODING COMPANION</p>
			<h1 id="owl-start-heading" className="owl-start-heading">让想法，在这里落地。</h1>
			<p className="owl-start-description">从一个问题、一段代码，或一个待完成的任务开始。</p>

			{primaryActions.length > 0 && (
				<div className="owl-start-primary-actions" aria-label="项目快捷入口">
					{primaryActions.map((action) => (
						<button key={action.kind} type="button" className="owl-start-card" title={action.hint ? `${action.title} · ${action.hint}` : action.title} onClick={() => onAction(action.kind)}>
							<span className="owl-start-card-icon">{action.kind === "files" ? <IconFolder className="h-[22px] w-[22px]" /> : action.icon(22)}</span>
							<span className="owl-start-card-title">{action.title}</span>
							<span className="owl-start-card-description">{action.description}</span>
						</button>
					))}
				</div>
			)}

			{secondaryActions.length > 0 && (
				<div className="owl-start-secondary-actions" aria-label="更多工作台入口">
					{secondaryActions.map((action) => (
						<button key={action.kind} type="button" className="owl-start-secondary-action" title={action.hint ? `${action.label} · ${action.hint}` : action.label} onClick={() => onAction(action.kind)}>
							<span className="owl-start-secondary-icon">{action.icon(15)}</span>
							<span>{action.kind === "terminal" ? "终端" : action.kind === "sidechat" ? "侧边对话" : action.label}</span>
						</button>
					))}
				</div>
			)}
		</section>
	);
}
