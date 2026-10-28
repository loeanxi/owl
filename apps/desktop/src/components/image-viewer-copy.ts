import { useCallback } from "react";
import { getUiLanguage, useT } from "../i18n/index.ts";

const zh = {
	title: "图片预览",
	close: "关闭预览",
	previous: "上一张",
	next: "下一张",
	zoomIn: "放大",
	zoomOut: "缩小",
	fit: "适应窗口",
	actual: "原始尺寸",
	loading: "正在加载图片…",
	failed: "图片加载失败",
	retry: "重试",
	help: "滚轮缩放 · 拖动查看 · 双击切换原图 · Esc 关闭",
	compactHelp: "滚轮缩放 · 拖动查看 · Esc 关闭",
	galleryHelp: "← → 切换图片",
} as const;

const en: Record<keyof typeof zh, string> = {
	title: "Image preview",
	close: "Close preview",
	previous: "Previous image",
	next: "Next image",
	zoomIn: "Zoom in",
	zoomOut: "Zoom out",
	fit: "Fit to window",
	actual: "Original size",
	loading: "Loading image…",
	failed: "Image could not be loaded",
	retry: "Retry",
	help: "Scroll to zoom · Drag to pan · Double-click for original size · Esc to close",
	compactHelp: "Scroll to zoom · Drag to pan · Esc to close",
	galleryHelp: "← → Browse images",
};

export function useImageViewerText(): (key: keyof typeof zh) => string {
	useT(); // 订阅语言切换
	const language = getUiLanguage();
	// 返回稳定的引用：把它放进 useLayoutEffect 的依赖里时，每次渲染换新函数会
	// 让 effect 反复重跑，配合 setState 就是无限更新（Maximum update depth）。
	return useCallback((key: keyof typeof zh) => (language === "en" ? en : zh)[key], [language]);
}
