/**
 * 「八股对练」数据层：owl-bagu 目录（面试官人格 + 面试官记忆 + 每天一个对练 markdown）。
 *
 * 目录约定（与助理 owl-myself / 专家 owl-expert 同一模式，见 features/myself、features/expert）：
 *   owl-bagu/interviewer.md    面试官人格档案（首次打开时落盘；用户可改，改完下次 primer 生效）
 *   owl-bagu/memory.md         面试官对候选人的长期记忆（薄弱本，跨会话累积，primer 携带尾部）
 *   owl-bagu/YYYY-MM-DD.md     当天的对练记录（`> HH:MM 谁：内容` 引用行，复用 myself 的解析/追加）
 *
 * 题库本身仍存 bagu（localhost:8080 的 H2）；本目录只存「面试官」这一侧的人与记忆。
 */
import type { BridgeClient } from "../../bridge/client.ts";
import type { FsReadResult } from "../../bridge/protocol.ts";
import { BAGU_DIR } from "../../utils/paths.ts";
import { appendChatLine, newDayTemplate, todayKey } from "../myself/myself-data.ts";

/** 用户手动指定的数据目录（localStorage 覆盖），优先于固定目录。 */
export const BAGU_DIR_LS_KEY = "owl.bagu.dir";

export function baguWorkspaceDir(): string {
	try {
		return localStorage.getItem(BAGU_DIR_LS_KEY)?.trim() || BAGU_DIR;
	} catch {
		return BAGU_DIR;
	}
}

async function readText(client: BridgeClient, cwd: string, path: string): Promise<string | null> {
	try {
		const response = await client.request<FsReadResult>({ type: "fs.read", cwd, path });
		if (!response.ok || response.result?.kind !== "text") return null;
		return response.result.content;
	} catch {
		return null;
	}
}

async function writeText(client: BridgeClient, cwd: string, path: string, content: string): Promise<void> {
	const response = await client.request<{ path: string; size: number }>({ type: "fs.write", cwd, path, content });
	if (!response.ok) throw new Error(response.error ?? "fs.write failed");
}

/** 面试官人格档案（六段式的面试版；用户可直接改文件改面试官）。 */
const INTERVIEWER_TEMPLATE = `---
name: 老周
title: Java 后端面试官
style: 追问型 · 友好
---

# 老周 · Java 后端面试官

## 身份与记忆

十年 Java 后端研发与面试经验,面过校招也面过社招。以「老周」自称,像同事聊天一样面试,
但眼里不揉沙子:答得不深一定追问。对候选人的长期记忆存于同目录 memory.md。

## 面试规则

- 一题一题来:先听完整回答,再评分,再决定追问还是下一题
- 评分看关键词覆盖与理解深度,不看背诵流畅度
- 候选人反问你时,先给结论再给要点,像资深同事那样答,不敷衍

## 评分口径

- 结构(有没有主线):30%
- 关键点覆盖:40%
- 深度(为什么/取舍):20%
- 表达(口吻自然、不背书):10%
`;

/** 面试官记忆（薄弱本）骨架。 */
const MEMORY_TEMPLATE = `# 面试官记忆（候选人的薄弱本与偏好）

> 每行一条:反复失分的知识点、候选人的背景与进展;新的写下面。会话开场会把本文件尾部带进上下文。
`;

/**
 * 确保数据目录就绪：interviewer.md / memory.md 缺失时落盘（用户改过则不动）。
 * fs.write 会递归建父目录（见 coding-agent sidebar-fs），目录不存在也能直接写。
 * 返回两个文件的当前内容（primer 用）。
 */
export async function ensureBaguDir(client: BridgeClient, dir: string): Promise<{ interviewer: string; memory: string }> {
	let interviewer = await readText(client, dir, "interviewer.md");
	if (interviewer === null) {
		interviewer = INTERVIEWER_TEMPLATE;
		await writeText(client, dir, "interviewer.md", interviewer);
	}
	let memory = await readText(client, dir, "memory.md");
	if (memory === null) {
		memory = MEMORY_TEMPLATE;
		await writeText(client, dir, "memory.md", memory);
	}
	return { interviewer, memory };
}

/** 读取面试官记忆（目录还没建时返回空串）。 */
export async function readBaguMemory(client: BridgeClient, dir: string): Promise<string> {
	return (await readText(client, dir, "memory.md")) ?? "";
}

/** 把一条对练记录（我 / 老周 / 复盘）追加进 `YYYY-MM-DD.md`；没有当天文件就先建骨架。 */
export async function logBaguChatLine(client: BridgeClient, dir: string, who: string, text: string): Promise<void> {
	const date = todayKey();
	const base = (await readText(client, dir, `${date}.md`)) ?? newDayTemplate(date, "zh");
	await writeText(client, dir, `${date}.md`, appendChatLine(base, timeHHMM(), who, text));
}

function timeHHMM(): string {
	const at = new Date();
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Primer：新线程首轮提示词的角色铺垫（之后靠会话记忆，不重复）
// ---------------------------------------------------------------------------

/**
 * 八股对练新会话的角色铺垫：人格档案 + 记忆尾部 + 数据目录说明 + 评分格式。
 * 与 expertPrimer 同构；场景词用中文固定值（提示词不随界面语言走）。
 */
export function baguPrimer(interviewerMd: string, memory: string, scene: string, dir: string): string {
	const memoryTail = memory.trim().split(/\r?\n/).slice(-24).join("\n");
	return [
		`你是「老周」,owl「八股对练」面板里的 Java 后端面试官,正在和候选人做一对一模拟面试。`,
		`你的数据目录是 ${dir}/:interviewer.md 是你的人格档案（用户可改,改了以文件为准）,memory.md 是你对候选人的长期记忆（反复失分的点记一行进去）,YYYY-MM-DD.md 是对练记录。`,
		`本场场景：${scene}。`,
		`人格档案如下,全程保持这个人格、口吻与评分口径作答：`,
		`---`,
		interviewerMd.trim(),
		`---`,
		memoryTail ? `对这位候选人的记忆（最近几条）：\n${memoryTail}` : `记忆还是空的——第一次与这位候选人合作。`,
		`对话规则：`,
		`- 全程中文、面试官口吻,简洁直接,不堆客套话;`,
		`- 不要执行与对练无关的任务;工具只用于读写自己数据目录里的文件;`,
		`- 候选人反问你时,先给结论再给要点,控制在 150 字以内;`,
		`- 只有当候选人明确要求评分时才输出评分：第一行「分数：N」（0-100）,随后给出命中点、遗漏点和改进建议,每行一条。`,
		`---`,
		``,
	].join("\n");
}
