import { useEffect, useRef, useState } from "react";
import type { ChatEntry } from "../hooks/transcript.ts";
import { useT } from "../i18n/index.ts";
import "./response-activity.css";

export type ChatActivity = "idle" | "working" | "waiting" | "disconnected";

/** Motion follows the current turn; historical answers never keep it alive. */
export function ResponseActivity({ entries, activity }: {
	entries: ChatEntry[];
	activity: ChatActivity;
}): React.JSX.Element | null {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const element = root.current;
		if (!element || activity !== "working") return;
		let intersecting = false;
		const updateVisibility = (): void => setVisible(intersecting && !document.hidden);
		const observer = new IntersectionObserver(([entry]) => {
			intersecting = entry?.isIntersecting ?? false;
			updateVisibility();
		});
		observer.observe(element);
		document.addEventListener("visibilitychange", updateVisibility);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", updateVisibility);
		};
	}, [activity]);

	if (activity === "idle") return null;
	let phase: "pending" | "thinking" | "composing" | "executing" = "pending";
	let foundLatestContent = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.kind === "user") break;
		if (entry.kind !== "assistant") continue;
		if (entry.tools.some((tool) => tool.status === "running")) {
			phase = "executing";
			break;
		}
		if (foundLatestContent) continue;
		// Prefer event order when reasoning and answer text coexist in one message.
		const latest = entry.segments?.findLast((segment) => segment.kind !== "tool" && segment.text.trim());
		if (latest?.kind === "text" || (!latest && entry.text.trim())) {
			phase = "composing";
			foundLatestContent = true;
		} else if (latest?.kind === "thinking" || (!latest && entry.thinking.trim())) {
			phase = "thinking";
			foundLatestContent = true;
		}
	}
	const label = activity === "waiting" ? t("chat.activityWaiting")
		: activity === "disconnected" ? t("chat.activityDisconnected")
			: phase === "executing" ? t("chat.activityExecuting")
				: phase === "thinking" ? t("sidechat.thinking") : t("chat.activityGenerating");

	return (
		<div ref={root} className="owl-response-activity owl-response-indicator" data-state={activity}
			data-phase={phase} data-animating={activity === "working" && visible ? "true" : "false"}
			role="status" aria-live="polite" aria-atomic="true">
			<span className="owl-response-emblem" aria-hidden="true">
				<img src="/owl.svg" alt="" className="owl-response-symbol" draggable={false} />
			</span>
			<span className="owl-response-label">{label}</span>
			{activity === "working" && (
				<span className="owl-response-signal" aria-hidden="true"><span /><span /><span /></span>
			)}
		</div>
	);
}
