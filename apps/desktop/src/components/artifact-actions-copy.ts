import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	group: "成果操作",
	open: "打开文件",
	reveal: "打开所在文件夹",
	copy: "复制绝对路径",
	opening: "正在打开…",
	revealing: "正在定位…",
	copying: "正在复制…",
	opened: "已请求打开文件。",
	revealed: "已请求在文件管理器中定位文件。",
	copied: "绝对路径已复制。",
	retry: "重试",
	failed: "操作失败",
	invalidPath: "无法在当前项目中定位此文件，请检查文件路径。",
	missingWorkspace: "尚未关联项目目录，无法定位或复制绝对路径。",
	missingConnection: "连接不可用，请恢复连接后重试。",
	missingOpen: "当前页面无法打开文件。",
	notFile: "此路径不是文件，请检查文件是否已被移动或删除。",
	clipboardUnavailable: "剪贴板不可用，请检查系统权限后重试。",
} as const;

const en: Record<keyof typeof zh, string> = {
	group: "Artifact actions",
	open: "Open file",
	reveal: "Open containing folder",
	copy: "Copy absolute path",
	opening: "Opening…",
	revealing: "Locating…",
	copying: "Copying…",
	opened: "Requested to open the file.",
	revealed: "Requested to locate the file in the file manager.",
	copied: "Absolute path copied.",
	retry: "Retry",
	failed: "Action failed",
	invalidPath: "This file cannot be located in the current project. Check the file path.",
	missingWorkspace: "No project directory is available to locate the file or copy its absolute path.",
	missingConnection: "Connection unavailable. Reconnect and retry.",
	missingOpen: "Files cannot be opened from this page.",
	notFile: "This path is not a file. Check whether it was moved or deleted.",
	clipboardUnavailable: "Clipboard unavailable. Check system permissions and retry.",
};

export const artifactActionText = (key: keyof typeof zh): string => (getUiLanguage() === "en" ? en : zh)[key];

export function useArtifactActionText(): typeof artifactActionText {
	useT();
	return artifactActionText;
}
