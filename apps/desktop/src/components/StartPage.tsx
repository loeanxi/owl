import { useId, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { getUiLanguage, t, useT, type TextKey } from "../i18n/index.ts";
import { isTabKindEnabled, useSidebarConfig } from "../sidebar/config.ts";
import { QUICK_ACTIONS } from "../sidebar/quick.tsx";
import { isReservedDir, projectLabel } from "../utils/paths.ts";
import { IconChevron, IconCode, IconFolder } from "./icons.tsx";
import { useStartPageText } from "./start-page-copy.ts";
import { UsageOverview } from "./UsageOverview.tsx";
import "./start-page.css";

const GENERAL_ACTION_COPY: Record<string, TextKey> = {
	files: "start.generalFiles",
	browser: "start.generalBrowser",
	tasks: "start.generalTasks",
};

const TASK_EXAMPLES = [
	{ id: "research", titleKey: "start.exResearchTitle", promptKey: "start.exResearchPrompt" },
	{ id: "files", titleKey: "start.exFilesTitle", promptKey: "start.exFilesPrompt" },
	{ id: "coding", titleKey: "start.exCodingTitle", promptKey: "start.exCodingPrompt" },
] as const;

interface StartPageProps {
	client?: BridgeClient;
	cwd?: string;
	profile?: string;
	recentSessions?: readonly { id: string; title: string; time?: string }[];
	onResume?: (id: string) => void;
	onAction?: (kind: string) => void;
	onPrompt?: (text: string) => void;
	onOpenDeveloper?: () => void;
}

/** A keyed account boundary keeps disclosure state from leaking across profiles. */
function StartUsage({ client, profile }: { client: BridgeClient; profile?: string }): React.JSX.Element {
	const t = useT();
	const storageKey = profile?.trim() ? `owl.start.usageOpen.${encodeURIComponent(profile.trim())}` : undefined;
	const [open, setOpen] = useState(() => {
		try { return storageKey ? localStorage.getItem(storageKey) === "true" : false; } catch { return false; }
	});
	return <details className="owl-start-usage" open={open} onToggle={(event) => {
		const next = event.currentTarget.open;
		setOpen(next);
		if (storageKey) {
			try { localStorage.setItem(storageKey, String(next)); } catch { /* Disclosure still works for this visit. */ }
		}
	}}>
		<summary>{t("usage.aria")}</summary>
		{open && <UsageOverview client={client} />}
	</details>;
}

function recentTimeLabel(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return "";
	const diff = Date.now() - date.getTime();
	if (diff < 60_000) return t("sidebar.relativeNow");
	if (diff < 3_600_000) return t("sidebar.relativeMinutes", { n: Math.floor(diff / 60_000) });
	return date.toLocaleDateString(getUiLanguage() === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric" });
}

/** Examples fill the draft; recent tasks restore their original session without submitting. */
export function StartPage({ client, cwd, profile, recentSessions = [], onResume, onAction, onPrompt, onOpenDeveloper }: StartPageProps): React.JSX.Element {
	const t = useT();
	const copy = useStartPageText();
	const headingId = useId();
	const examplesHeadingId = useId();
	const recentHeadingId = useId();
	const cfg = useSidebarConfig();
	const actions = QUICK_ACTIONS.filter((action) => !action.disabled && isTabKindEnabled(action.kind, cfg));
	const filesEnabled = actions.some((action) => action.kind === "files");
	const generalActions = actions.filter((action) => GENERAL_ACTION_COPY[action.kind] && (action.kind !== "files" || !cwd));
	const secondaryActions = actions.filter((action) => !GENERAL_ACTION_COPY[action.kind]);
	const hasDeveloperTools = actions.some((action) => action.kind === "files" || action.kind === "terminal" || action.kind === "changes");
	const recent = recentSessions.slice(0, 3);
	const hasProject = Boolean(cwd && !isReservedDir(cwd));

	return <section className="owl-start-page" aria-labelledby={headingId}>
		<header className="owl-start-header">
			<img src="/owl.svg" alt="" className="owl-start-mark" draggable={false} />
			<div>
				<h1 id={headingId} className="owl-start-heading">{t("start.heading")}</h1>
				<p className="owl-start-description">{t("start.description")}</p>
			</div>
		</header>

		{cwd && <div className="owl-start-project">
			<div className="owl-start-project-info">
				<IconFolder className="h-4 w-4 shrink-0" />
				<span className="owl-start-project-label">{copy("currentProject")}</span>
				<strong className="owl-start-project-name" title={hasProject ? cwd : undefined}>{hasProject ? projectLabel(cwd) : t("composer.projectChoose")}</strong>
			</div>
			{filesEnabled && <button type="button" className="owl-start-secondary-action" disabled={!onAction} onClick={() => onAction?.("files")}>{t("start.generalFiles")}</button>}
		</div>}

		<section className="owl-start-recent" aria-labelledby={recentHeadingId}>
			<h2 id={recentHeadingId} className="owl-start-section-heading">{copy("recentTasks")}</h2>
			{recent.length > 0 ? <div className="owl-start-recent-list">
				{recent.map((session) => <button key={session.id} type="button" className="owl-start-recent-task" title={session.title} disabled={!onResume} onClick={() => onResume?.(session.id)}>
					<span className="owl-start-task-title">{session.title}</span>
					{session.time && <span className="owl-start-task-time" title={session.time}>{recentTimeLabel(session.time)}</span>}
					<IconChevron className="h-3.5 w-3.5 shrink-0" />
				</button>)}
			</div> : <p className="owl-start-recent-empty">{t("sidebar.none")}</p>}
		</section>

		<section className="owl-start-examples" aria-labelledby={examplesHeadingId}>
			<h2 id={examplesHeadingId} className="owl-start-section-heading">{t("start.examplesAria")}</h2>
			<div className="owl-start-primary-actions">
				{TASK_EXAMPLES.map((example) => <button key={example.id} type="button" className="owl-start-example" title={t(example.promptKey)} disabled={!onPrompt} onClick={() => onPrompt?.(t(example.promptKey))}>
					<span>{t(example.titleKey)}</span>
					<IconChevron className="h-3.5 w-3.5 shrink-0" />
				</button>)}
			</div>
			{onPrompt && <p className="owl-start-example-hint">{t("start.exampleHint")}</p>}
		</section>

		<div className="owl-start-tools" aria-label={t("start.toolsAria")}>
			<div className="owl-start-secondary-actions">
				{generalActions.map((action) => <button key={action.kind} type="button" className="owl-start-secondary-action" title={action.hint ? `${t(GENERAL_ACTION_COPY[action.kind]!)} · ${action.hint}` : action.label} disabled={!onAction} onClick={() => onAction?.(action.kind)}>
					<span className="owl-start-secondary-icon">{action.icon(15)}</span>
					<span>{t(GENERAL_ACTION_COPY[action.kind]!)}</span>
				</button>)}
				{hasDeveloperTools && <button type="button" className="owl-start-secondary-action owl-start-developer-action" title={t("start.developerDesc")} disabled={!onOpenDeveloper} onClick={onOpenDeveloper}>
					<IconCode className="h-4 w-4" />
					<span>{t("titlebar.openDeveloperWorkbench")}</span>
				</button>}
			</div>
			{secondaryActions.length > 0 && <details className="owl-start-more-tools">
				<summary>{t("start.moreTools")}</summary>
				<div className="owl-start-secondary-actions" aria-label={t("start.moreToolsAria")}>
					{secondaryActions.map((action) => <button key={action.kind} type="button" className="owl-start-secondary-action" title={action.hint ? `${action.label} · ${action.hint}` : action.label} disabled={!onAction} onClick={() => onAction?.(action.kind)}>
						<span className="owl-start-secondary-icon">{action.icon(15)}</span>
						<span>{action.kind === "terminal" ? t("start.terminal") : action.kind === "sidechat" ? t("start.sidechat") : action.label}</span>
					</button>)}
				</div>
			</details>}
		</div>

		{client && <StartUsage key={profile?.trim() || "pending"} client={client} profile={profile} />}
	</section>;
}
