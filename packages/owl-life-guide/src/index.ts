/**
 * owl「高性价比人生指南」检索插件（life_guide_search 工具）。
 *
 * 给 agent 一个专门的书内检索入口：全书 34 章 665 条建议按关键词（子串 AND）、
 * 章号、证据等级（A/B/C/争议）过滤，或按 key（"章.条"）取单条全文。数据走
 * jsDelivr 抓取 + agent 数据目录磁盘缓存（与桌面端指南面板同源、各自缓存），
 * 离线时用缓存；结果文本头部带快照日期，模型可向用户转述新鲜度。上游：
 * eternity4719/HowToLiveBetter，正文 CC BY 4.0。
 */

import type { ExtensionAPI } from "@owl/owl-coding-agent";
import { type Static, Type } from "typebox";
import {
	formatNoMatches,
	formatOverview,
	formatSearchResults,
	formatSingleTip,
	type GradeFilter,
	searchGuide,
} from "./guide-search.ts";
import { ensureGuideSnapshot, GUIDE_CHAPTERS, type GuideSnapshot } from "./guide-source.ts";

// Match pi-ai's StringEnum without loading its compat barrel during registration.
function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 8;

const ParamsSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"关键词。空格分词、词与词 AND；中文按子串匹配，用短词（「电动车」「安全带」「酒驾」）而非长句。也可带标签词（如「收益大」）或章名（如「买房」）。",
		}),
	),
	chapter: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: GUIDE_CHAPTERS.length,
			description: `限定章号 1-${GUIDE_CHAPTERS.length}。只想要某一章时用。`,
		}),
	),
	grade: Type.Optional(
		StringEnum(["A", "B", "C", "disputed"], {
			description: "证据等级过滤：A（最硬）/ B / C；disputed 只看上游标记为争议的条目。",
		}),
	),
	key: Type.Optional(
		Type.String({
			description: '条目键 "章.条"（如 "1.6"）。给出时忽略其余参数，返回该条全文（含成本/收益/来源/备注）。',
		}),
	),
	full: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"true 时每条附成本/收益/来源/备注全文（来源可能很长）；false 只给标题+标签+说人话，适合先扫一遍。",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_LIMIT,
			default: DEFAULT_LIMIT,
			description: `最多返回多少条（1-${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}）。`,
		}),
	),
	refresh: Type.Optional(
		Type.Boolean({
			default: false,
			description: "true 强制从上游重新拉取（默认用本地缓存，缓存可能落后于上游）。",
		}),
	),
});

type Params = Static<typeof ParamsSchema>;

interface ResultDetails {
	matched: number;
	shown: number;
	snapshot: { savedAt?: string; complete: boolean };
}

const FETCH_FAILED_MESSAGE =
	"错误：「高性价比人生指南」本地没有缓存，且从上游（jsDelivr CDN）拉取失败——大概率是当前网络不可用。请把这个情况告诉用户，不要编造指南内容。";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "life_guide_search",
		label: "人生指南检索",
		description:
			"检索内置《高性价比人生指南》（HowToLiveBetter）：34 章 665 条经过证据分级（A/B/C）的生活建议，覆盖意外伤害、疾病筛查、省钱、法律红线、租房买房、育儿养老等。" +
			"凡用户问到「该不该做某事 / 怎么避免某风险 / 某做法划不划算」这类生活决策，先在这里查有没有对应条目，引用条目 key（如 1.6）、证据等级和说人话摘要作答；" +
			"未命中再退回普通回答。无参数调用返回全书章目录概览。",
		promptSnippet: "life_guide_search: 检索《高性价比人生指南》665 条证据分级建议（关键词/章节/等级/单条全文）",
		promptGuidelines: [
			"生活建议类问题先查这个工具再回答；引用条目时带上 key 和证据等级。",
			"回答里注明数据是本地快照（工具结果头部有日期），可能落后于上游。",
			"上游标记「争议」的条目要如实转述争议点，不要洗成定论。",
		],
		parameters: ParamsSchema,
		execute: async (_toolCallId, rawParams, signal, onUpdate) => {
			const params = rawParams as Params;
			const snapshot: GuideSnapshot = await ensureGuideSnapshot({
				refresh: params.refresh === true,
				signal,
				onProgress: (done, total) => {
					onUpdate?.({
						content: [{ type: "text", text: `正在拉取《高性价比人生指南》 ${done}/${total} 章…` }],
						details: { matched: 0, shown: 0, snapshot: { complete: false } },
					});
				},
			});
			if (snapshot.chapters.length === 0) {
				return {
					content: [{ type: "text", text: FETCH_FAILED_MESSAGE }],
					details: { matched: 0, shown: 0, snapshot: { complete: false } },
					isError: true,
				};
			}

			const details: ResultDetails = {
				matched: 0,
				shown: 0,
				snapshot: { ...(snapshot.savedAt ? { savedAt: snapshot.savedAt } : {}), complete: snapshot.complete },
			};

			// key 精确取单条：忽略 query/grade/chapter。
			if (params.key) {
				const [chapterNo, tipNo] = params.key.split(".").map((part) => Number(part));
				const chapter = snapshot.chapters.find((c) => c.no === chapterNo);
				const tip = chapter?.tips.find((t) => t.no === tipNo);
				if (!chapter || !tip) {
					return {
						content: [
							{
								type: "text",
								text: `错误：没有 key 为「${params.key}」的条目。key 形如 "章.条"，可先检索拿到条目的 key。`,
							},
						],
						details,
						isError: true,
					};
				}
				const hit = { chapter, tip, score: 0 };
				return {
					content: [{ type: "text", text: formatSingleTip(hit, details.snapshot) }],
					details: { ...details, matched: 1, shown: 1 },
				};
			}

			const query = {
				query: params.query ?? "",
				...(params.chapter !== undefined ? { chapter: params.chapter } : {}),
				...(params.grade !== undefined ? { grade: params.grade as GradeFilter } : {}),
				limit: params.limit ?? DEFAULT_LIMIT,
			};
			// 全空参数 = 概览模式：章目录 + 等级分布 + 用法。
			if (!query.query && !query.chapter && !query.grade) {
				return {
					content: [{ type: "text", text: formatOverview(snapshot.chapters, details.snapshot) }],
					details,
				};
			}

			const { hits, matched } = searchGuide(snapshot.chapters, query);
			if (hits.length === 0) {
				return { content: [{ type: "text", text: formatNoMatches(query) }], details };
			}
			const shown = Math.min(hits.length, query.limit);
			return {
				content: [
					{
						type: "text",
						text: formatSearchResults(
							snapshot.chapters,
							hits,
							matched,
							details.snapshot,
							query.limit,
							params.full === true,
						),
					},
				],
				details: { ...details, matched, shown },
			};
		},
	});
}
