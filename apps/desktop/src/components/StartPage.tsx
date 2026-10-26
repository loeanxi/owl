import { useId } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { StartRecentSession } from "../hooks/use-start-recent-sessions.ts";
import { useT, type TextKey } from "../i18n/index.ts";
import { OwlMascot } from "./OwlMascot.tsx";
import { UsageOverview } from "./UsageOverview.tsx";
import "./start-page.css";

interface StartPageProps {
	client?: BridgeClient;
	profile?: string;
	/** 点击示例后把提示词填进输入框（App 侧已接 setDraftRequest，此前未渲染）。 */
	onPromptExample?: (text: string) => void;
	recentSessions?: readonly StartRecentSession[];
	onResumeSession?: (id: string) => void;
}

/** 示例卡：文案都在 i18n（start.ex*），点击把完整提示词落进输入框，用户可编辑后发送。 */
const EXAMPLES: readonly { title: TextKey; desc: TextKey; prompt: TextKey }[] = [
	{ title: "start.exQuestionTitle", desc: "start.exQuestionDesc", prompt: "start.exQuestionPrompt" },
	{ title: "start.exResearchTitle", desc: "start.exResearchDesc", prompt: "start.exResearchPrompt" },
	{ title: "start.exFilesTitle", desc: "start.exFilesDesc", prompt: "start.exFilesPrompt" },
	{ title: "start.exCodingTitle", desc: "start.exCodingDesc", prompt: "start.exCodingPrompt" },
];

function relativeTime(time: string | undefined, t: (key: TextKey, vars?: Record<string, string | number>) => string): string {
	const stamp = Date.parse(time ?? "");
	if (!Number.isFinite(stamp)) return "";
	const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000));
	if (minutes < 1) return t("chat.justNow");
	if (minutes < 60) return t("chat.minutesAgo", { n: minutes });
	const hours = Math.round(minutes / 60);
	if (hours < 24) return t("chat.hoursAgo", { n: hours });
	return t("chat.daysAgo", { n: Math.round(hours / 24) });
}

/** A keyed account boundary remounts usage when the signed-in profile changes. */
export function StartPage({ client, profile, onPromptExample, recentSessions, onResumeSession }: StartPageProps): React.JSX.Element {
	const t = useT();
	const headingId = useId();
	const heading = t("start.heading");
	const mark = heading.startsWith("owl") ? "owl" : "";
	const rest = mark ? heading.slice(mark.length) : heading;
	const examples = onPromptExample ? EXAMPLES : [];
	const recents = onResumeSession ? [...(recentSessions ?? [])] : [];

	return <section className="owl-start-page" aria-labelledby={headingId}>
		<header className="owl-start-header">
			<OwlMascot pose="idle" inline />
			<h1 id={headingId} className="owl-start-heading">
				{mark && <span className="owl-wordmark">{mark}</span>}
				<span className="owl-start-service">{rest}</span>
			</h1>
		</header>
		{client && <div key={profile?.trim() || "pending"} className="owl-start-usage"><UsageOverview client={client} /></div>}
		{examples.length > 0 && <section className="owl-start-examples" aria-label={t("start.examplesAria")}>
			<p className="owl-start-section-title">{t("start.examplesAria")}<span className="owl-start-section-hint">{t("start.exampleHint")}</span></p>
			<div className="owl-start-example-grid">
				{examples.map((example) => <button
					key={example.prompt}
					type="button"
					className="owl-start-example"
					onClick={() => onPromptExample?.(t(example.prompt))}
				>
					<strong>{t(example.title)}</strong>
					<span>{t(example.desc)}</span>
				</button>)}
			</div>
		</section>}
		{recents.length > 0 && <section className="owl-start-recents" aria-label={t("start.recentTitle")}>
			<p className="owl-start-section-title">{t("start.recentTitle")}</p>
			<ul>
				{recents.map((session) => {
					const when = relativeTime(session.time, t);
					return <li key={session.id}>
						<button type="button" className="owl-start-recent" onClick={() => onResumeSession?.(session.id)}>
							<span className="owl-start-recent-title" title={session.title}>{session.title}</span>
							{when !== "" && <span className="owl-start-recent-time">{when}</span>}
						</button>
					</li>;
				})}
			</ul>
		</section>}
	</section>;
}
