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
		if (!dock || !conversation || !content || !activeRequest) return;
		const measure = (): void => {
			// A tall bottom workbench must leave room to read and answer the card.
			content.style.setProperty("--owl-question-chat-min-height", `${Math.ceil(dock.getBoundingClientRect().height) + 250}px`);
			const available = Math.max(0, dock.getBoundingClientRect().top - conversation.getBoundingClientRect().top - 10);
			dock.style.setProperty("--owl-question-available-height", `${Math.floor(available)}px`);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(conversation);
		observer.observe(dock);
		return () => {
			observer.disconnect();
			dock.style.removeProperty("--owl-question-available-height");
			content.style.removeProperty("--owl-question-chat-min-height");
		};
	}, [activeRequest]);

	return (
		<div ref={dockRef} className="owl-composer-dock">
			{requests.length > 0 && (
				<div className="owl-question-anchor">
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
