/** 会话正在输出时，桌面端再发来的消息排进跟进队列，而不是被拒绝。 */
export function streamingBehaviorForPrompt(
	isStreaming: boolean,
	requested?: "steer" | "followUp",
): "steer" | "followUp" | undefined {
	if (!isStreaming) return undefined;
	return requested ?? "followUp";
}
