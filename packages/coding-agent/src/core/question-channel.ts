/**
 * 「向用户提问」桥通道注册表。
 *
 * ask_user_question 以普通插件形式加载（settings plugins 里的 owl-ask-user），
 * 但问卷的 WebSocket 往返只有桌面桥有：桥启动时把 broadcast / 连接探针注入
 * 这里（setQuestionChannel），插件侧用 getQuestionChannel 取用。非桌面模式
 * （print/-p）通道缺位，插件据此把工具从模型工具列表里摘掉。
 * 挂起的提问也登记在这份注册表里：桥收到 question.response 时 resolve，
 * 会话卸载 / 桥关闭时统一按取消处理，不吊死工具协程。
 *
 * 单例语义：桥与插件运行在同一进程，经 @owl/owl-coding-agent 别名拿到的是
 * 同一份 dist 模块实例，这里就是两边共享的接缝。
 */

import type { DesktopServerMessage, QuestionAnswerPayload } from "../modes/desktop/protocol.ts";

/** 桥注入的提问通道：向所有已连接的桌面 UI 广播 + 连接探针。 */
export interface QuestionChannel {
	broadcast: (message: DesktopServerMessage) => void;
	/** 没有任何桌面 UI 连着时提问必然无人应答，插件应在出发前就报错。 */
	hasConnectedClients: () => boolean;
}

/** 桥端挂起的一次提问；question.response / abort / 会话卸载都会落到 resolve。 */
export interface PendingQuestion {
	sessionId: string;
	toolCallId: string;
	resolve: (outcome: QuestionOutcome) => void;
}

export type QuestionOutcome = { cancelled: boolean; answers: QuestionAnswerPayload[] };

let channel: QuestionChannel | undefined;
const pending = new Map<string, PendingQuestion>();

/** 桥启动时注入通道；close 时传 undefined 摘除。 */
export function setQuestionChannel(next: QuestionChannel | undefined): void {
	channel = next;
}

export function getQuestionChannel(): QuestionChannel | undefined {
	return channel;
}

/** 插件在 broadcast 前登记挂起提问，让桥的应答/清理能找到 resolver。 */
export function registerPendingQuestion(requestId: string, entry: PendingQuestion): void {
	pending.set(requestId, entry);
}

/** 桥收到 question.response 时调用；返回 false 表示请求已不存在（已取消/已清理）。 */
export function resolveQuestion(requestId: string, outcome: QuestionOutcome): boolean {
	const entry = pending.get(requestId);
	if (!entry) return false;
	pending.delete(requestId);
	entry.resolve(outcome);
	return true;
}

/** 某会话的挂起提问全部按取消处理（会话删除/卸载时调用）。 */
export function cancelPendingQuestionsForSession(sessionId: string): void {
	for (const [requestId, entry] of pending) {
		if (entry.sessionId !== sessionId) continue;
		pending.delete(requestId);
		entry.resolve({ cancelled: true, answers: [] });
	}
}

/** 桥关闭：所有挂起提问按取消处理。 */
export function cancelAllPendingQuestions(): void {
	for (const entry of pending.values()) entry.resolve({ cancelled: true, answers: [] });
	pending.clear();
}
