import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	checking: "正在检查文件引用…",
	failed: "部分文件暂时无法访问，输入已保留",
	hint: "重新拖入文件或用 @ 选择后再发送。此检查只确认文件能否访问。",
	remove: "移除此引用",
	retry: "重新检查",
	failedCount: "{n} 个文件引用暂时无法访问",
	recheckCount: "待复核 {n} 个文件引用",
	details: "文件详情（{n}）",
	invalid: "无法确认文件路径，请重新选择",
	unconfirmed: "文件检查未获确认，请重试",
	notFile: "此引用不是可读取的文件或目录",
	missing: "文件或上级目录已不存在，请重新选择",
	denied: "无法访问此文件，请检查权限或重新选择",
};
const en: Record<keyof typeof zh, string> = {
	checking: "Checking file references…",
	failed: "Some files are unavailable; your input is preserved",
	hint: "Drop the file again or use @ to select it before sending. This check confirms accessibility only.",
	remove: "Remove reference",
	retry: "Check again",
	failedCount: "{n} file references are unavailable",
	recheckCount: "{n} file references to recheck",
	details: "File details ({n})",
	invalid: "Cannot resolve this file path; select it again",
	unconfirmed: "File check not confirmed; retry",
	notFile: "This reference is not an accessible file or directory",
	missing: "The file or its parent folder no longer exists; select it again",
	denied: "Cannot access this file; check its permissions or select it again",
};
export function attachmentPreflightText(key: keyof typeof zh): string {
	return (getUiLanguage() === "en" ? en : zh)[key];
}
export function useAttachmentPreflightCopy(): typeof zh {
	useT();
	return getUiLanguage() === "en" ? en : zh;
}
