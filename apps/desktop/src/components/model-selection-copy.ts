import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	pending: "正在确认切换为 {model}…",
	confirmed: "会话已确认选择 {model}。",
	selected: "已为新任务选择 {model}，创建会话时应用。",
	failed: "模型切换未获确认",
	details: "模型详情",
	requested: "本次选择：{model}。",
	previous: "上次确认的模型：{model}。",
	running: "已发出的请求不会重启；后续请求按已确认的模型选择执行。",
	idle: "后续请求使用已确认的模型选择，会话记录继续保留。",
	retry: "重试切换",
	invalid: "模型选择无效，请重新选择。",
	offline: "连接已断开，恢复连接后可重试。",
	unconfirmed: "服务端没有返回模型确认信息，请重试或刷新会话。",
	images: "支持图片",
	textOnly: "仅支持文本",
	capacity: "模型标注窗口 {n} tokens",
} as const;
const en: Record<keyof typeof zh, string> = {
	pending: "Confirming switch to {model}…",
	confirmed: "Session model selection confirmed: {model}.",
	selected: "Selected {model} for the next task. Applied when its session is created.",
	failed: "Model switch was not confirmed",
	details: "Model details",
	requested: "Requested model: {model}.",
	previous: "Last confirmed model: {model}.",
	running: "Requests already sent are not restarted. Subsequent requests use the confirmed model selection.",
	idle: "Subsequent requests use the confirmed model selection. Conversation history is retained.",
	retry: "Retry model switch",
	invalid: "Invalid model selection. Choose a model again.",
	offline: "Disconnected. Reconnect and retry.",
	unconfirmed: "The server returned no model confirmation. Retry or refresh the conversation.",
	images: "Supports images",
	textOnly: "Text only",
	capacity: "Listed context window: {n} tokens",
};

export function modelSelectionText(key: keyof typeof zh, vars: Record<string, string | number> = {}): string {
	return (getUiLanguage() === "en" ? en : zh)[key].replace(/\{(\w+)\}/g, (match, name: string) =>
		String(vars[name] ?? match),
	);
}

export function useModelSelectionText(): typeof modelSelectionText {
	useT();
	return modelSelectionText;
}
