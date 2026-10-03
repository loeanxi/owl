import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { QuestionAnswerPayload, QuestionRequest } from "../bridge/protocol.ts";
import { QuestionDialog } from "./QuestionDialog.tsx";
import "./question-dock.css";

/** Keep pending questions above the composer and within its conversation column. */
export function QuestionDock({
	requests,
	activeRequest,
	onAnswer,
	children,
}: {
	requests: readonly QuestionRequest[];
	activeRequest: QuestionRequest | undefined;
	onAnswer: (requestId: string, answers: QuestionAnswerPayload[], cancelled: boolean) => void;
	children: ReactNode;
}): React.JSX.Element {
	const dockRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const dock = dockRef.current;
		const conversation = dock?.parentElement;
		const content = conversation?.parentElement;
		const composer = dock?.querySelector<HTMLElement>(".owl-composer-surface");
		if (!dock || !conversation || !content || !composer || !activeRequest) return;
		const fixedSiblings = Array.from(conversation.children).filter((child) =>
			child !== dock && getComputedStyle(child).flexGrow === "0",
		);
		const measure = (): void => {
			// Budget from the full content area, independently of the card's own height.
			const contentHeight = content.getBoundingClientRect().height;
			const historyHeight = Math.min(160, contentHeight * 0.2);
			const fixedHeight = fixedSiblings.reduce((height, sibling) => height + sibling.getBoundingClientRect().height, 0);
			const available = Math.max(0, contentHeight - composer.getBoundingClientRect().height - fixedHeight - historyHeight);
			dock.style.setProperty("--owl-question-available-height", `${Math.floor(available)}px`);
			const minHeight = dock.getBoundingClientRect().height + fixedHeight + historyHeight;
			content.style.setProperty("--owl-question-chat-min-height", `${Math.ceil(minHeight)}px`);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		observer.observe(composer);
		observer.observe(dock);
		for (const sibling of fixedSiblings) observer.observe(sibling);
		return () => {
			observer.disconnect();
			dock.style.removeProperty("--owl-question-available-height");
			content.style.removeProperty("--owl-question-chat-min-height");
		};
	}, [activeRequest]);

	return (
		<div ref={dockRef} className="owl-composer-dock">
			{requests.length > 0 && (
				<div className="owl-question-anchor" hidden={!activeRequest}>
					{/* Keep drafts mounted while another session or queued request is active. */}
					{requests.map((request) => (
						<div key={request.requestId} className="owl-question-anchor__column" hidden={request.requestId !== activeRequest?.requestId}>
							<QuestionDialog request={request} onAnswer={(answers, cancelled) => onAnswer(request.requestId, answers, cancelled)} />
						</div>
					))}
				</div>
			)}
			{children}
		</div>
	);
}
