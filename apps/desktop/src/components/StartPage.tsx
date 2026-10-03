import { isTabKindEnabled, useSidebarConfig } from "../sidebar/config.ts";
import { QUICK_ACTIONS } from "../sidebar/quick.tsx";
import { IconChat, IconCode, IconFolder, IconSearch } from "./icons.tsx";
import "./start-page.css";

const GENERAL_ACTION_COPY: Record<string, string> = {
	files: "浏览文件",
	browser: "打开浏览器",
	tasks: "执行记录",
};

const TASK_EXAMPLES = [
	{
		id: "question",
		title: "解释一个问题",
		description: "用例子把一个概念讲清楚",
		prompt: "用一个生活中的例子解释大语言模型的上下文窗口，说明它与记忆的区别。",
		icon: IconChat,
	},
	{
		id: "research",
		title: "研究与比较",
		description: "查找资料，比较方案与依据",
		prompt: "研究本地运行 AI 助手的几种方案，比较功能、资源要求与限制，并注明资料来源和日期。",
		icon: IconSearch,
	},
	{
		id: "files",
		title: "分析文件",
		description: "从现有资料中提取重点",
		prompt: "查看当前工作目录，找出可以分析的文档或数据文件，先列出它们的用途，再建议一项值得整理的内容。",
		icon: IconFolder,
	},
	{
		id: "coding",
		title: "编程与开发",
		description: "理解项目，提出改进方案",
		prompt: "先查看当前项目的说明和结构，解释主要模块与启动方式，再指出一个可以改进的地方。先讨论方案，不修改代码。",
		icon: IconCode,
	},
];

interface StartPageProps {
	onAction: (kind: string) => void;
	onPrompt?: (text: string) => void;
	onOpenDeveloper?: () => void;
}

/** 统一会话欢迎页：示例填入草稿，工具面板按需打开，停用的面板即时隐藏。 */
export function StartPage({ onAction, onPrompt, onOpenDeveloper }: StartPageProps): React.JSX.Element {
	const cfg = useSidebarConfig();
	const actions = QUICK_ACTIONS.filter((action) => !action.disabled && isTabKindEnabled(action.kind, cfg));
	const generalActions = actions.filter((action) => GENERAL_ACTION_COPY[action.kind]);
	const secondaryActions = actions.filter((action) => !GENERAL_ACTION_COPY[action.kind]);
	const hasDeveloperTools = actions.some(
		(action) => action.kind === "files" || action.kind === "terminal" || action.kind === "changes",
	);

	return (
		<section className="owl-start-page" aria-labelledby="owl-start-heading">
			<img src="/owl.svg" alt="" className="owl-start-mark" draggable={false} />
			<p className="owl-start-eyebrow">YOUR LOCAL AI ASSISTANT</p>
			<h1 id="owl-start-heading" className="owl-start-heading">
				让想法，在这里落地。
			</h1>
			<p className="owl-start-description">提问、研究资料、整理文件，或完成一个开发任务。</p>

			<div className="owl-start-primary-actions" aria-label="任务示例">
				{TASK_EXAMPLES.map((example) => (
					<button
						key={example.id}
						type="button"
						className="owl-start-card"
						title={example.prompt}
						disabled={!onPrompt}
						onClick={() => onPrompt?.(example.prompt)}
					>
						<span className="owl-start-card-icon">
							<example.icon className="h-[20px] w-[20px]" />
						</span>
						<span className="owl-start-card-title">{example.title}</span>
						<span className="owl-start-card-description">{example.description}</span>
					</button>
				))}
			</div>
			{onPrompt && <p className="owl-start-example-hint">选择一个示例，编辑后发送。</p>}

			{generalActions.length > 0 && (
				<div className="owl-start-secondary-actions" aria-label="工具快捷入口">
					{generalActions.map((action) => (
						<button
							key={action.kind}
							type="button"
							className="owl-start-secondary-action"
							title={
								action.hint ? `${GENERAL_ACTION_COPY[action.kind]} · ${action.hint}` : GENERAL_ACTION_COPY[action.kind]
							}
							onClick={() => onAction(action.kind)}
						>
							<span className="owl-start-secondary-icon">{action.icon(15)}</span>
							<span>{GENERAL_ACTION_COPY[action.kind]}</span>
						</button>
					))}
				</div>
			)}

			{hasDeveloperTools && (
				<button type="button" className="owl-start-developer-action" disabled={!onOpenDeveloper} onClick={onOpenDeveloper}>
					<IconCode className="h-4 w-4" />
					<span>打开开发工作台</span>
					<span className="owl-start-developer-description">项目、终端与代码差异</span>
				</button>
			)}

			{secondaryActions.length > 0 && (
				<details className="owl-start-more-tools">
					<summary>更多工具</summary>
					<div className="owl-start-secondary-actions" aria-label="更多工具快捷入口">
						{secondaryActions.map((action) => (
							<button
								key={action.kind}
								type="button"
								className="owl-start-secondary-action"
								title={action.hint ? `${action.label} · ${action.hint}` : action.label}
								onClick={() => onAction(action.kind)}
							>
								<span className="owl-start-secondary-icon">{action.icon(15)}</span>
								<span>{action.kind === "terminal" ? "终端" : action.kind === "sidechat" ? "侧边对话" : action.label}</span>
							</button>
						))}
					</div>
				</details>
			)}
		</section>
	);
}
