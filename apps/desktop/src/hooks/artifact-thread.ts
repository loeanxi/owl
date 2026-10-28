/**
 * 产物页的页内对话：提示词组装与回复预览。
 *
 * 规格来源：Claude Desktop 的产物页（artifact page）
 *   - `caf9acda5-DZQdrmOl.js` 的产物页 composer：发送时带上
 *     `switchDocsOn: true` 与 `docArtifact: <产物>` —— **产物本身是这一轮对话的
 *     文档上下文**，追问都发生在这份产物上。
 *   - `cc874c60c-Bz93e0mK.js` 的词表：`Ask Claude` / `Ask Claude · N attachments` /
 *     `Claude's reply` / `Dismiss` / `Open in chat`；回复预览按 200 字裁剪。
 *
 * owl 的对应：产物页在**侧栏工作台**里开一条独立线程（不进主对话），
 * 每一轮都把产物重新带上 —— 文件产物走 `attachedPaths`（模型自己去读），
 * 可视化产物把 spec 内联进正文（它没有文件可读）。
 */

import type { Product } from "./products.ts";

/** 归一化项目 key（与 SidebarStore 的持久化 key 同规则）。 */
function projectKeyOf(cwd: string): string {
	return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 产物页线程的绑定键：按「项目 + 产物」存。
 *
 * 同一个产物在同一个项目里始终是同一条线程：重开应用能接着聊，
 * 换个产物就是另一条（两个产物的上下文互不串）。
 */
export function artifactThreadKey(cwd: string, productId: string): string {
	return `owl.artifactchat.${projectKeyOf(cwd)}.${productId}`;
}

/** 发给模型的一轮输入。 */
export interface ArtifactPrompt {
	/** 消息正文（含产物上下文）。 */
	message: string;
	/** 本轮附带的工作区相对路径（只有文件产物有）。 */
	attachedPaths?: string[];
}

/** 产物上下文内联进正文时的长度上限：一张大图表不该撑爆这一轮的上下文。 */
export const ARTIFACT_SPEC_LIMIT = 8000;

/** 可视化产物的 spec 正文（超长截断并标注）。 */
export function artifactSpecText(product: Product): string {
	if (product.spec === undefined) return "";
	const raw = safeJson(product.spec);
	if (raw.length <= ARTIFACT_SPEC_LIMIT) return raw;
	return `${raw.slice(0, ARTIFACT_SPEC_LIMIT)}\n… (truncated)`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "";
	}
}

/**
 * 组装一轮「关于这个产物」的提问。
 *
 * 上下文头用英文（与 owl 既有的 `[Attached files for this turn]` 同一语域，
 * 那是给模型看的，不是界面文案）。
 */
export function artifactPromptFor(product: Product, question: string): ArtifactPrompt {
	const head = ["[Artifact context]", `title: ${product.title}`, `kind: ${product.kind}`];
	if (product.path !== undefined) head.push(`path: ${product.path}`);
	if (product.kind === "file") {
		// 文件产物：把路径挂成只读附件，模型自己去读（与 /@ 引用芯片同一条路）。
		return {
			message: `${head.join("\n")}\n\nQuestion: ${question}`,
			...(product.path !== undefined ? { attachedPaths: [product.path] } : {}),
		};
	}
	const spec = artifactSpecText(product);
	const context = spec === "" ? head.join("\n") : `${head.join("\n")}\n\n${spec}`;
	return { message: `${context}\n\nQuestion: ${question}` };
}

/**
 * 从一条发出去的消息里取回「用户真正问的那句」。
 *
 * 会话里存的是带上下文的完整消息（附件头 + 产物上下文），但气泡里只该显示
 * 用户写的那一句 —— 上下文是给模型看的，不是给人看的。
 */
export function artifactQuestionFrom(message: string): string {
	let text = message;
	const attachments = /^\[Attached files for this turn\]\n(?:- [^\n]*\n)*\n/.exec(text);
	if (attachments) text = text.slice(attachments[0].length);
	const context = /^\[Artifact context\][\s\S]*?\n\nQuestion: /.exec(text);
	if (context) return text.slice(context[0].length).trim();
	return text.trim();
}

/**
 * 回复预览：把长回答压成一行短摘录。
 *
 * 逐字照抄 Claude 的裁剪（`cc874c60c-Bz93e0mK.js` 的 `s()`）：
 * 换行压成空格、去掉项目符号尾巴、超过 200 字就在最后一个空格处截断加省略号。
 */
export function trimReplyPreview(text: string, limit = 200): string {
	const flat = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join(" ")
		.replace(/^• /, "")
		.replace(/([:;,.!?]) • /g, "$1 ")
		.split(" • ")
		.join(", ");
	if (flat.length <= limit) return flat;
	const head = flat.slice(0, limit);
	const space = head.lastIndexOf(" ");
	return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** 线程里最后一条回答（用于「Claude's reply」内联回执）。 */
export function lastAssistantText(entries: readonly { kind: string; text?: string }[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.kind === "assistant") return entry.text ?? "";
	}
	return "";
}
