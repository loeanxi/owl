import type { ComponentProps, ReactNode } from "react";
import type { ConversationView } from "./ConversationHeader.tsx";
import { QuestionDock } from "./QuestionDock.tsx";
import "./agent-conversation.css";

export interface AgentConversationProps {
	/** Callers supply their own ConversationHeader and session controls. */
	header?: ReactNode;
	view: ConversationView;
	chat: ReactNode;
	context: ReactNode;
	trajectory: ReactNode;
	/** Session task, schedule, retry, or recording notices above the composer. */
	beforeComposer?: ReactNode;
	composer: ReactNode;
	questionDock?: Omit<ComponentProps<typeof QuestionDock>, "children">;
	className?: string;
	hidden?: boolean;
}

/** Shared Home conversation surface; session state and navigation stay with each caller. */
export function AgentConversation({
	header,
	view,
	chat,
	context,
	trajectory,
	beforeComposer,
	composer,
	questionDock,
	className,
	hidden,
}: AgentConversationProps): React.JSX.Element {
	return (
		<div className={`owl-agent-conversation${className ? ` ${className}` : ""}`} hidden={hidden}>
			{header}
			{view === "trajectory" ? trajectory : view === "context" ? context : chat}
			{beforeComposer}
			{questionDock ? <QuestionDock {...questionDock}>{composer}</QuestionDock> : composer}
		</div>
	);
}
