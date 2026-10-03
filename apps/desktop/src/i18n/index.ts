import { useSyncExternalStore } from "react";
import { zh } from "./zh.ts";
import { en } from "./en.ts";

/** 界面语言。只影响桌面端 UI 文案；对话回复语言由模型按用户输入自行决定。 */
export type UiLanguage = "zh" | "en";

/** 字典形状以 zh.ts 为准；en.ts 必须补齐同一批 key（类型上强制）。 */
export type Dict = { [K in keyof typeof zh]: string };
export type TextKey = keyof Dict;

const DICTS: Record<UiLanguage, Dict> = { zh, en };

const PLACEHOLDER = /\{(\w+)\}/g;

/** 把 "{n} 个会话" 这类模板里的 {name} 换成变量；未提供的占位符原样保留。 */
function format(template: string, vars?: Record<string, string | number>): string {
	if (!vars) return template;
	return template.replace(PLACEHOLDER, (raw, name: string) => (name in vars ? String(vars[name]) : raw));
}

let language: UiLanguage = "zh";
const listeners = new Set<() => void>();

export function getUiLanguage(): UiLanguage {
	return language;
}

/** 切换语言并通知所有订阅组件重渲染；重复设置同一语言是空操作。 */
export function setUiLanguage(next: UiLanguage): void {
	if (next === language) return;
	language = next;
	for (const notify of listeners) notify();
}

function subscribeUiLanguage(notify: () => void): () => void {
	listeners.add(notify);
	return () => listeners.delete(notify);
}

/** 非组件代码（工具函数、事件回调里直接拼的文本）用：按当前语言取文案，不订阅重渲染。 */
export function t(key: TextKey, vars?: Record<string, string | number>): string {
	return format(DICTS[language][key] ?? key, vars);
}

/** 组件用：返回绑定当前语言的 t()，语言切换时触发所在组件重渲染。 */
export function useT(): (key: TextKey, vars?: Record<string, string | number>) => string {
	useSyncExternalStore(subscribeUiLanguage, getUiLanguage);
	return t;
}

/** settings.json 里的 uiLanguage 值是否合法（防旧值/手改值落到未知语言）。 */
export function isUiLanguage(value: unknown): value is UiLanguage {
	return value === "zh" || value === "en";
}

/** 宽松解析：非法值一律回落中文（默认语言不变）。 */
export function parseUiLanguage(value: unknown): UiLanguage {
	return isUiLanguage(value) ? value : "zh";
}
