import { useId } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { useT } from "../i18n/index.ts";
import { OwlMascot } from "./OwlMascot.tsx";
import { UsageOverview } from "./UsageOverview.tsx";
import "./start-page.css";

interface StartPageProps {
	client?: BridgeClient;
	profile?: string;
}

/** A keyed account boundary remounts usage when the signed-in profile changes. */
export function StartPage({ client, profile }: StartPageProps): React.JSX.Element {
	const t = useT();
	const headingId = useId();
	const heading = t("start.heading");
	const mark = heading.startsWith("owl") ? "owl" : "";
	const rest = mark ? heading.slice(mark.length) : heading;

	return <section className="owl-start-page" aria-labelledby={headingId}>
		<header className="owl-start-header">
			<OwlMascot pose="idle" inline />
			<h1 id={headingId} className="owl-start-heading">
				{mark && <span className="owl-wordmark">{mark}</span>}
				<span className="owl-start-service">{rest}</span>
			</h1>
		</header>
		{client && <div key={profile?.trim() || "pending"} className="owl-start-usage"><UsageOverview client={client} /></div>}
	</section>;
}
