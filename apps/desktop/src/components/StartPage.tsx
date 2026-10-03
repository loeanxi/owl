import { useT, type TextKey } from "../i18n/index.ts";
import { isTabKindEnabled, useSidebarConfig } from "../sidebar/config.ts";
import { QUICK_ACTIONS } from "../sidebar/quick.tsx";
import { IconChat, IconCode, IconFolder, IconSearch } from "./icons.tsx";
import "./start-page.css";

const GENERAL_ACTION_COPY: Record<string, TextKey> = {
	files: "start.generalFiles",
	browser: "start.generalBrowser",
	tasks: "start.generalTasks",
};

const TASK_EXAMPLES = [
	{
		id: "question",
		titleKey: "start.exQuestionTitle",
		descKey: "start.exQuestionDesc",
		promptKey: "start.exQuestionPrompt",
		icon: IconChat,
	},
	{
		id: "research",
		titleKey: "start.exResearchTitle",
		descKey: "start.exResearchDesc",
		promptKey: "start.exResearchPrompt",
		icon: IconSearch,
	},
	{
		id: "files",
		titleKey: "start.exFilesTitle",
		descKey: "start.exFilesDesc",
		promptKey: "start.exFilesPrompt",
		icon: IconFolder,
	},
	{
		id: "coding",
		titleKey: "start.exCodingTitle",
		descKey: "start.exCodingDesc",
		promptKey: "start.exCodingPrompt",
		icon: IconCode,
	},
] as const;

interface StartPageProps {
	onAction: (kind: string) => void;
	onPrompt?: (text: string) => void;
	onOpenDeveloper?: () => void;
}

/** 统一会话欢迎页：示例填入草稿，工具面板按需打开，停用的面板即时隐藏。 */
export function StartPage({ onAction, onPrompt, onOpenDeveloper }: StartPageProps): React.JSX.Element {
	const t = useT();
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
				{t("start.heading")}
			</h1>
			<p className="owl-start-description">{t("start.description")}</p>

			<div className="owl-start-primary-actions" aria-label={t("start.examplesAria")}>
				{TASK_EXAMPLES.map((example) => (
					<button
						key={example.id}
						type="button"
						className="owl-start-card"
						title={t(example.promptKey)}
						disabled={!onPrompt}
						onClick={() => onPrompt?.(t(example.promptKey))}
					>
						<span className="owl-start-card-icon">
							<example.icon className="h-[20px] w-[20px]" />
						</span>
						<span className="owl-start-card-title">{t(example.titleKey)}</span>
						<span className="owl-start-card-description">{t(example.descKey)}</span>
					</button>
				))}
			</div>
			{onPrompt && <p className="owl-start-example-hint">{t("start.exampleHint")}</p>}

			{generalActions.length > 0 && (
				<div className="owl-start-secondary-actions" aria-label={t("start.toolsAria")}>
					{generalActions.map((action) => {
						const label = GENERAL_ACTION_COPY[action.kind] ? t(GENERAL_ACTION_COPY[action.kind]) : action.label;
						return (
							<button
								key={action.kind}
								type="button"
								className="owl-start-secondary-action"
								title={action.hint ? `${label} · ${action.hint}` : label}
								onClick={() => onAction(action.kind)}
							>
								<span className="owl-start-secondary-icon">{action.icon(15)}</span>
								<span>{label}</span>
							</button>
						);
					})}
				</div>
			)}

			{hasDeveloperTools && (
				<button type="button" className="owl-start-developer-action" disabled={!onOpenDeveloper} onClick={onOpenDeveloper}>
					<IconCode className="h-4 w-4" />
					<span>{t("titlebar.openDeveloperWorkbench")}</span>
					<span className="owl-start-developer-description">{t("start.developerDesc")}</span>
				</button>
			)}

			{secondaryActions.length > 0 && (
				<details className="owl-start-more-tools">
					<summary>{t("start.moreTools")}</summary>
					<div className="owl-start-secondary-actions" aria-label={t("start.moreToolsAria")}>
						{secondaryActions.map((action) => (
							<button
								key={action.kind}
								type="button"
								className="owl-start-secondary-action"
								title={action.hint ? `${action.label} · ${action.hint}` : action.label}
								onClick={() => onAction(action.kind)}
							>
								<span className="owl-start-secondary-icon">{action.icon(15)}</span>
								<span>{action.kind === "terminal" ? t("start.terminal") : action.kind === "sidechat" ? t("start.sidechat") : action.label}</span>
							</button>
						))}
					</div>
				</details>
			)}
		</section>
	);
}
