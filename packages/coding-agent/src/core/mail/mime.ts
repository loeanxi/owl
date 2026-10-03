import { parseHTML } from "linkedom";
import type { MailAttachment, MailDraft, MailMessage, MailThread, MailThreadSummary } from "./types.js";

export interface GmailPart {
	mimeType?: string;
	filename?: string;
	headers?: Array<{ name: string; value: string }>;
	body?: { data?: string; attachmentId?: string; size?: number };
	parts?: GmailPart[];
}

export interface GmailMessage {
	id?: string;
	threadId?: string;
	snippet?: string;
	internalDate?: string;
	labelIds?: string[];
	payload?: GmailPart;
}

export interface GmailThread {
	id?: string;
	messages?: GmailMessage[];
}

function decodedHeader(value: string): string {
	return value.replace(
		/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
		(_whole, charset: string, encoding: string, encoded: string) => {
			try {
				const bytes =
					encoding.toLowerCase() === "b"
						? Buffer.from(encoded, "base64")
						: Buffer.from(
								encoded
									.replace(/_/g, " ")
									.replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
										String.fromCharCode(Number.parseInt(hex, 16)),
									),
								"latin1",
							);
				return new TextDecoder(charset).decode(bytes);
			} catch {
				return encoded;
			}
		},
	);
}

function header(part: GmailPart | undefined, name: string): string {
	return decodedHeader(part?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value ?? "");
}

function decodeBody(part: GmailPart): string {
	const data = Buffer.from(part.body?.data ?? "", "base64url");
	const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(header(part, "content-type"))?.[1] ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(data);
	} catch {
		return data.toString("utf8");
	}
}

function bodyParts(part: GmailPart, plain: string[], html: string[], attachments: MailAttachment[]): void {
	if (part.filename || part.body?.attachmentId) {
		attachments.push({
			id: part.body?.attachmentId,
			name: part.filename || "附件",
			mimeType: part.mimeType || "application/octet-stream",
			size: part.body?.size ?? 0,
		});
	} else if (part.mimeType === "text/plain" && part.body?.data) {
		plain.push(decodeBody(part));
	} else if (part.mimeType === "text/html" && part.body?.data) {
		html.push(decodeBody(part));
	}
	for (const child of part.parts ?? []) bodyParts(child, plain, html, attachments);
}

export function parseThread(thread: GmailThread, accountId: string): MailThread {
	const messages: MailMessage[] = (thread.messages ?? []).map((message) => {
		const plain: string[] = [];
		const html: string[] = [];
		const attachments: MailAttachment[] = [];
		if (message.payload) bodyParts(message.payload, plain, html, attachments);
		let bodyText = plain.join("\n\n");
		if (!bodyText && html.length) {
			const { document } = parseHTML(`<html><body>${html.join("\n")}</body></html>`);
			for (const node of document.querySelectorAll("script,style,iframe,object,head")) node.remove();
			for (const node of document.querySelectorAll("br,p,div,li,tr"))
				node.appendChild(document.createTextNode("\n"));
			bodyText = document.body.textContent ?? "";
		}
		const timestamp = Number(message.internalDate);
		return {
			id: message.id ?? "",
			from: header(message.payload, "from"),
			to: header(message.payload, "to"),
			cc: header(message.payload, "cc") || undefined,
			subject: header(message.payload, "subject"),
			date:
				Number.isFinite(timestamp) && timestamp > 0
					? new Date(timestamp).toISOString()
					: header(message.payload, "date"),
			bodyText: bodyText.trim(),
			snippet: message.snippet ?? "",
			messageId: header(message.payload, "message-id") || undefined,
			references: header(message.payload, "references") || undefined,
			attachments,
		};
	});
	return { id: thread.id ?? "", accountId, subject: messages[0]?.subject ?? "（无主题）", messages };
}

export function summarizeThread(thread: GmailThread, accountId: string): MailThreadSummary {
	const parsed = parseThread(thread, accountId);
	const latest = parsed.messages.at(-1);
	return {
		id: parsed.id,
		accountId,
		subject: parsed.subject || "（无主题）",
		from: latest?.from ?? "",
		snippet: latest?.snippet ?? "",
		date: latest?.date ?? "",
		unread: (thread.messages ?? []).some((message) => message.labelIds?.includes("UNREAD")),
		starred: (thread.messages ?? []).some((message) => message.labelIds?.includes("STARRED")),
		messageCount: parsed.messages.length,
		attachmentCount: parsed.messages.reduce((count, message) => count + message.attachments.length, 0),
	};
}

export function validateDraft(draft: MailDraft): MailDraft {
	if (!draft || typeof draft.accountId !== "string" || !draft.accountId) throw new Error("请选择发件邮箱。");
	if (typeof draft.body !== "string" || draft.body.length > 5_000_000) throw new Error("邮件正文无效或超过 5 MB。");
	const fields = [draft.to, draft.cc, draft.bcc, draft.subject, draft.inReplyTo, draft.references];
	if (fields.some((value) => value !== undefined && (typeof value !== "string" || /[\r\n\0]/.test(value)))) {
		throw new Error("邮件地址或标题中不能包含换行和控制字符。");
	}
	if (typeof draft.to !== "string" || !draft.to.trim() || typeof draft.subject !== "string") {
		throw new Error("请填写有效收件人和主题。");
	}
	for (const value of [draft.to, draft.cc, draft.bcc].filter(Boolean)) {
		for (const recipient of value!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
			const address = (/<([^<>]+)>\s*$/.exec(recipient)?.[1] ?? recipient).trim();
			if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address)) throw new Error("请填写有效的邮箱地址。");
		}
	}
	for (const value of [draft.inReplyTo, draft.references].filter(Boolean)) {
		if (!/^(?:<[^<>\s]+>\s*)+$/.test(value!)) throw new Error("回复邮件标识无效。");
	}
	return {
		id: draft.id,
		accountId: draft.accountId,
		threadId: draft.threadId,
		to: draft.to.trim(),
		cc: draft.cc?.trim() || undefined,
		bcc: draft.bcc?.trim() || undefined,
		subject: draft.subject,
		body: draft.body,
		inReplyTo: draft.inReplyTo,
		references: draft.references,
	};
}

export function buildMime(draft: MailDraft, from: string): string {
	validateDraft(draft);
	if (/[\r\n\0]/.test(from)) throw new Error("发件邮箱无效。");
	const chunks: string[] = [];
	let chunk = "";
	for (const character of draft.subject) {
		if (Buffer.byteLength(chunk + character) > 42) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) chunks.push(chunk);
	const subject = chunks.map((value) => `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`).join("\r\n ");
	const headers = [`From: ${from}`, `To: ${draft.to}`, `Subject: ${subject}`];
	if (draft.cc) headers.push(`Cc: ${draft.cc}`);
	if (draft.bcc) headers.push(`Bcc: ${draft.bcc}`);
	if (draft.inReplyTo) headers.push(`In-Reply-To: ${draft.inReplyTo}`);
	if (draft.references) headers.push(`References: ${draft.references}`);
	const body =
		Buffer.from(draft.body.replace(/\r?\n/g, "\r\n"))
			.toString("base64")
			.match(/.{1,76}/g)
			?.join("\r\n") ?? "";
	return Buffer.from(
		[
			...headers,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: base64",
			"",
			body,
		].join("\r\n"),
	).toString("base64url");
}
