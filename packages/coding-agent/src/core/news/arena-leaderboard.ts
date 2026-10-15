import { DOMParser } from "linkedom";
import type { NewsLeaderboardEntry } from "./types.ts";

export const ARENA_CODE_URL = "https://arena.ai/leaderboard/code/webdev";
const ARENA_READER_URL = `https://r.jina.ai/${ARENA_CODE_URL}`;

export interface ArenaLeaderboardResult {
	entries: NewsLeaderboardEntry[];
	updatedAt: string;
	dataUrl: string;
	transport: "direct" | "jina-reader";
}

type GetArenaText = (url: string, headers?: Record<string, string>) => Promise<string>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Read the public page's JSON literals only; never execute Next.js or other upstream scripts. */
export function parseArenaLeaderboard(html: string): Omit<ArenaLeaderboardResult, "dataUrl" | "transport"> {
	const document = new DOMParser().parseFromString(html, "text/html");
	const chunks: string[] = [];
	for (const script of document.querySelectorAll("script")) {
		const match = script.textContent?.trim().match(/^self\.__next_f\.push\((\[[\s\S]*\])\);?$/);
		if (!match) continue;
		try {
			const chunk: unknown = JSON.parse(match[1]!);
			if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string") chunks.push(chunk[1]);
		} catch {
			// The public transport must remain data, even if upstream adds a script with a similar name.
		}
	}
	let leaderboard: Record<string, unknown> | undefined;
	for (const line of chunks.join("").split("\n")) {
		const match = line.match(/^[\da-f]+:(\[[\s\S]*)$/);
		if (!match) continue;
		try {
			const frame: unknown = JSON.parse(match[1]!);
			const candidate = Array.isArray(frame) ? record(record(frame[3])?.leaderboard) : undefined;
			if (
				candidate?.arenaSlug === "code" &&
				candidate.leaderboardSlug === "overall" &&
				typeof candidate.id === "string" &&
				candidate.id.includes("/webdev-overall-")
			) {
				leaderboard = candidate;
				break;
			}
		} catch {
			// Flight also contains module references and strings that are not leaderboard JSON records.
		}
	}
	if (!leaderboard || !Array.isArray(leaderboard.entries)) throw new Error("Arena 网页开发榜单格式已变化");
	const date = nonemptyString(leaderboard.voteCutoffISOString);
	const renderedDate = [...document.querySelectorAll("time[datetime]")].map((time) => time.getAttribute("datetime"));
	if (!date || !/^\d{4}-\d{2}-\d{2}T/.test(date) || !Number.isFinite(Date.parse(date)) || !renderedDate.includes(date))
		throw new Error("Arena 未提供可核验的榜单日期");
	const entries: NewsLeaderboardEntry[] = [];
	const seen = new Set<string>();
	for (const value of leaderboard.entries) {
		const item = record(value);
		const id = nonemptyString(item?.modelKey);
		const model = nonemptyString(item?.modelDisplayName);
		const score = finiteNumber(item?.rating);
		const rank = finiteNumber(item?.rank);
		const votes = finiteNumber(item?.votes);
		const lower = finiteNumber(item?.ratingLower);
		const upper = finiteNumber(item?.ratingUpper);
		if (
			!item ||
			!id ||
			!model ||
			score === undefined ||
			score < 0 ||
			rank === undefined ||
			!Number.isSafeInteger(rank) ||
			rank < 1 ||
			votes === undefined ||
			!Number.isSafeInteger(votes) ||
			votes < 0 ||
			lower === undefined ||
			upper === undefined ||
			lower > score ||
			upper < score ||
			seen.has(id)
		)
			throw new Error("Arena 返回了不完整或重复的模型结果");
		seen.add(id);
		let url: string | undefined;
		try {
			const candidate = new URL(String(item.modelUrl));
			if (/^https?:$/.test(candidate.protocol) && !candidate.username && !candidate.password)
				url = candidate.toString();
		} catch {
			// A model without a usable official link remains rankable.
		}
		entries.push({
			id,
			rank,
			model,
			organization: nonemptyString(item.modelOrganization),
			score: Number(score.toFixed(2)),
			url,
			detail: [
				`${votes.toLocaleString("en-US")} 票`,
				`分数区间 ${Math.round(lower)}–${Math.round(upper)}`,
				item.releaseType === "pre_release" ? "初步结果" : null,
			]
				.filter(Boolean)
				.join(" · "),
		});
	}
	if (!entries.length || leaderboard.totalModels !== entries.length) throw new Error("Arena 模型结果不完整");
	return { entries: entries.sort((a, b) => a.rank - b.rank), updatedAt: date };
}

/** The keyless reader is a fallback transport for the same official snapshot, not a second ranking source. */
export async function fetchArenaLeaderboard(getText: GetArenaText): Promise<ArenaLeaderboardResult> {
	try {
		const data = parseArenaLeaderboard(await getText(ARENA_CODE_URL));
		return { ...data, dataUrl: ARENA_CODE_URL, transport: "direct" };
	} catch {
		const html = await getText(ARENA_READER_URL, { "X-Return-Format": "html" });
		return { ...parseArenaLeaderboard(html), dataUrl: ARENA_READER_URL, transport: "jina-reader" };
	}
}
