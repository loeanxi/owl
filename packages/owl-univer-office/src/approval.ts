import {
	getQuestionChannel,
	type QuestionOutcome,
	registerPendingQuestion,
	resolveQuestion,
} from "@owl/owl-coding-agent";

/** Desktop extensions use the bridge question channel, including automatic tool mode. */
export async function confirmOfficeAction(
	sessionId: string,
	toolCallId: string,
	title: string,
	message: string,
	signal?: AbortSignal,
	fallback?: () => Promise<boolean>,
): Promise<boolean> {
	signal?.throwIfAborted();
	const channel = getQuestionChannel();
	if (!channel?.hasConnectedClients()) {
		if (fallback) return fallback();
		throw new Error("确认或放弃 Office 草稿需要已连接的 Owl 界面。请在工作台中审阅后操作。");
	}
	const requestId = `${sessionId}:office:${toolCallId}`;
	const approve = title === "放弃 Office 草稿" ? "放弃草稿" : "确认合入";
	let aborted: (() => void) | undefined;
	try {
		const outcome = await new Promise<QuestionOutcome>((resolve) => {
			registerPendingQuestion(requestId, { sessionId, toolCallId, resolve });
			aborted = () => resolveQuestion(requestId, { cancelled: true, answers: [] });
			signal?.addEventListener("abort", aborted, { once: true });
			if (signal?.aborted) {
				aborted();
				return;
			}
			channel.broadcast({
				type: "question_request",
				requestId,
				sessionId,
				toolCallId,
				questions: [
					{
						header: "Office 审阅",
						question: `${title}\n${message}`,
						multiSelect: false,
						options: [
							{
								label: approve,
								description:
									title === "放弃 Office 草稿"
										? "放弃这份草稿，保留当前版本。"
										: "将已审阅的草稿合入当前版本。",
							},
							{ label: "暂不处理", description: "保留草稿，继续查看或修改。" },
						],
					},
				],
			});
		});
		return (
			!outcome.cancelled &&
			outcome.answers.some(
				(answer) =>
					answer.index === 0 &&
					!answer.customText?.trim() &&
					answer.selectedLabels?.length === 1 &&
					answer.selectedLabels[0] === approve,
			)
		);
	} finally {
		if (aborted) signal?.removeEventListener("abort", aborted);
		resolveQuestion(requestId, { cancelled: true, answers: [] });
	}
}
