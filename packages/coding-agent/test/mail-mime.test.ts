import { describe, expect, it } from "vitest";
import { buildMime, parseThread, summarizeThread } from "../src/core/mail/mime.ts";

describe("Gmail MIME", () => {
	it("decodes recursive multipart text and encoded subject, while retaining attachment metadata", () => {
		const thread = {
			id: "thread",
			messages: [
				{
					id: "message",
					labelIds: ["UNREAD", "STARRED"],
					internalDate: "1791032400000",
					payload: {
						mimeType: "multipart/mixed",
						headers: [{ name: "Subject", value: `=?UTF-8?B?${Buffer.from("周报确认").toString("base64")}?=` }],
						parts: [
							{
								mimeType: "multipart/alternative",
								parts: [
									{
										mimeType: "text/plain",
										body: { data: Buffer.from("项目完成 80%。").toString("base64url") },
									},
									{
										mimeType: "text/html",
										body: { data: Buffer.from("<b>重复的 HTML 正文</b>").toString("base64url") },
									},
								],
							},
							{
								mimeType: "application/pdf",
								filename: "进度.pdf",
								body: { attachmentId: "attachment", size: 1234 },
							},
						],
					},
				},
			],
		};
		const parsed = parseThread(thread, "work");
		expect(parsed.subject).toBe("周报确认");
		expect(parsed.messages[0].bodyText).toBe("项目完成 80%。");
		expect(parsed.messages[0].attachments).toEqual([
			{ id: "attachment", name: "进度.pdf", mimeType: "application/pdf", size: 1234 },
		]);
		expect(summarizeThread(thread, "work")).toMatchObject({
			unread: true,
			starred: true,
			attachmentCount: 1,
			messageCount: 1,
		});
	});

	it("returns readable plain text for HTML-only mail and excludes active/style content", () => {
		const parsed = parseThread(
			{
				id: "thread",
				messages: [
					{
						payload: {
							mimeType: "text/html",
							body: {
								data: Buffer.from(
									'<div>第一段 &amp; 文本</div><p>第二段<br>下一行</p><script>stealTokens()</script><style>hideEverything</style><img src="https://tracker.invalid/open">',
								).toString("base64url"),
							},
						},
					},
				],
			},
			"work",
		);
		expect(parsed.messages[0].bodyText).toContain("第一段 & 文本");
		expect(parsed.messages[0].bodyText).toContain("第二段");
		expect(parsed.messages[0].bodyText).not.toMatch(/<|stealTokens|hideEverything|tracker/);
	});

	it("encodes Unicode subject/body without allowing body text to introduce headers", () => {
		const subject = "这是一个需要分段编码的中文邮件主题".repeat(8);
		const raw = buildMime(
			{
				accountId: "work",
				to: '"Example, User" <user@example.com>',
				subject,
				body: "第一行\nBcc: ordinary body text",
			},
			"work@example.com",
		);
		const mime = Buffer.from(raw, "base64url").toString("utf8");
		const pieces = [...mime.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((match) =>
			Buffer.from(match[1], "base64").toString("utf8"),
		);
		expect(pieces.join("")).toBe(subject);
		expect(mime.split("\r\n\r\n")[0]).not.toContain("\r\nBcc:");
		expect(Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString("utf8")).toBe(
			"第一行\r\nBcc: ordinary body text",
		);
	});
});
