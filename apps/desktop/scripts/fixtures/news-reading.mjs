import React from "react";
import { createRoot } from "react-dom/client";
import { NewsPage } from "../../src/features/news/NewsPage.tsx";
import { setUiLanguage } from "../../src/i18n/index.ts";
import "../../src/desktop-shell.css";

const calls = [];
const snapshotPolls = new Map();
const nativeSetInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
window.setInterval = (callback, interval, ...args) => {
	const id = nativeSetInterval(callback, interval, ...args);
	if (interval === 10_000 || interval === 30_000 || interval === 2_000) snapshotPolls.set(id, callback);
	return id;
};
window.clearInterval = (id) => {
	snapshotPolls.delete(id);
	nativeClearInterval(id);
};
let readDelay = 0;
let pendingFeedReads = 0;
let pendingDetailReads = 0;
let failReads = false;
const now = "2026-10-15T03:00:00.000Z";
const items = [
	{
		id: "test-article",
		sourceName: "页面验收信源",
		sourceId: "test-source",
		title: "测试资讯：公开来源可以直接阅读",
		summary: "这是一条隔离测试数据，用于检查阅读、收藏、搜索和讨论入口。不会保存到用户资讯库。",
		category: "model",
		tags: ["测试数据"],
		publishedAt: now,
		timelineAt: now,
		url: "https://example.org/test-news",
		status: "ready",
		selected: false,
		contentOrigin: "source",
		saved: false,
		read: false,
	},
];
const snapshot = {
	status: { running: false, sourceCount: 8, itemCount: 1, selectedCount: 0, reportCount: 0, lastUpdatedAt: now },
	configuration: { modelCallsEnabled: false, collectEnabled: false, models: {} },
	categories: [{ id: "model", label: "模型" }],
	models: [],
};
const board = (id, title, category) => ({
	id,
	title,
	category,
	description: "隔离页面测试数据，用于验证榜单筛选和同步状态。",
	sourceName: "测试来源",
	sourceUrl: "https://example.org/leaderboard",
	dataUrl: "https://example.org/results.json",
	metric: "测试分数",
	scoreUnit: "%",
	updatedAt: "2026-10-15",
	checkedAt: now,
	tabLabel: title,
	freshness: { state: "current", ageDays: 0, reason: null },
	stale: false,
	error: null,
	entries: Array.from({ length: 25 }, (_, index) => ({
		id: `test-${index}`,
		rank: index + 1,
		model: `测试模型 ${index === 0 ? "Alpha" : `Beta ${index}`}`,
		score: 90 - index,
		detail: "隔离 UI 测试",
		organization: "Test Lab",
	})),
});
let leaderboard = {
	boards: [
		board("livebench-overall", "LiveBench", "general"),
		board("arena-code", "Arena 编程", "coding"),
		{
			...board("artificial-analysis", "Artificial Analysis", "general"),
			updatedAt: null,
			freshness: { state: "unknown", ageDays: null, reason: "来源未提供统一更新时间" },
		},
		{
			...board("swe-bench-verified", "SWE-bench 历史参考", "coding"),
			updatedAt: "2026-02-26",
			reference: true,
			freshness: { state: "outdated", ageDays: 231, reason: "仅作历史参考" },
		},
	],
	refreshIntervalMinutes: 30,
};
let stale = false;
let fail = false;
const client = {
	onStatus(listener) {
		listener(true);
		return () => {};
	},
	async request(message) {
		calls.push(message);
		if (message.type === "open.external") return { ok: true, result: {} };
		const request = message.request;
		let result;
		switch (request.action) {
			case "snapshot":
				result = snapshot;
				break;
			case "ready":
				result = { queued: 0, refreshing: false, lastUpdatedAt: now, enabledSourceCount: 8, failedSourceCount: 0 };
				break;
			case "list": {
				if (request.query?.limit === 20 && readDelay) {
					pendingFeedReads++;
					await new Promise((resolve) => setTimeout(resolve, readDelay));
					pendingFeedReads--;
				}
				if (failReads) return { ok: false, error: "模拟资讯读取失败" };
				const filtered = items
					.filter((item) =>
						request.query?.mode === "selected" ? item.selected : request.query?.mode === "saved" ? item.saved : true,
					)
					.filter((item) => !request.query?.query || item.title.includes(request.query.query));
				result = {
					items: request.query?.limit === 1 ? filtered.slice(0, 1) : filtered,
					total: filtered.length,
					offset: 0,
					limit: 20,
				};
				break;
			}
			case "item":
				if (readDelay) {
					pendingDetailReads++;
					await new Promise((resolve) => setTimeout(resolve, readDelay));
					pendingDetailReads--;
				}
				if (failReads) return { ok: false, error: "模拟资讯读取失败" };
				result = items.find((item) => item.id === request.id);
				break;
			case "bookmark":
				result = items[0];
				result.saved = request.saved;
				break;
			case "read":
				result = items[0];
				result.read = request.read;
				break;
			case "leaderboard":
				await new Promise((resolve) => setTimeout(resolve, 80));
				if (fail) return { ok: false, error: "模拟断网：连接失败" };
				result = structuredClone(leaderboard);
				if (stale)
					for (const entry of result.boards) {
						entry.stale = true;
						entry.error = "模拟来源暂时不可用";
					}
				break;
			case "reports":
			case "sources":
				result = [];
				break;
			default:
				return { ok: false, error: `Unexpected fixture action: ${request.action}` };
		}
		return { ok: true, result: structuredClone(result) };
	},
};
window.newsHarness = {
	calls,
	setReadDelay(value) {
		readDelay = value;
	},
	setReadFailure(value) {
		failReads = value;
	},
	get pendingFeedReads() {
		return pendingFeedReads;
	},
	get pendingDetailReads() {
		return pendingDetailReads;
	},
	pollSnapshot(changed = true) {
		if (changed)
			snapshot.status.lastUpdatedAt = new Date(Date.parse(snapshot.status.lastUpdatedAt) + 1000).toISOString();
		else snapshot.status.running = !snapshot.status.running;
		for (const callback of snapshotPolls.values()) callback();
	},
	setStale(value) {
		stale = value;
	},
	setFailure(value) {
		fail = value;
	},
	setLeaderboard(value) {
		leaderboard = value;
	},
	setUiLanguage,
	setActive(active) {
		render(active);
	},
};
const root = createRoot(document.getElementById("root"));
function render(active = true) {
	root.render(React.createElement(NewsPage, { client, active, onToChat: () => {}, onOpenModelSettings: () => {} }));
}
render(new URLSearchParams(location.search).get("inactive") !== "1");
