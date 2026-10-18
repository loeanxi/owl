import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	count: "附件 · {n}",
	expand: "展开全部 {n} 个附件",
	collapse: "收起",
	more: "+{n}",
	image: "图片 {n}",
	previewImage: "预览图片 {n}",
	removeImage: "移除图片 {n}",
	removeFile: "移除文件 {path}",
} as const;

const en: Record<keyof typeof zh, string> = {
	count: "Attachments: {n}",
	expand: "Show all {n} attachments",
	collapse: "Collapse",
	more: "+{n}",
	image: "Image {n}",
	previewImage: "Preview image {n}",
	removeImage: "Remove image {n}",
	removeFile: "Remove file {path}",
};

export function composerMaterialsText(key: keyof typeof zh, vars?: Record<string, string | number>): string {
	const template = (getUiLanguage() === "en" ? en : zh)[key];
	return vars ? template.replace(/\{(\w+)\}/g, (raw, name: string) => name in vars ? String(vars[name]) : raw) : template;
}

export function useComposerMaterialsText(): typeof composerMaterialsText {
	useT();
	return composerMaterialsText;
}
