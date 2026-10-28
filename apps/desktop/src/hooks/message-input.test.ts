import { describe, expect, it } from "vitest";
import { messageInputOf } from "./message-input.ts";
import type { ChatEntry } from "./transcript.ts";

type UserEntry = Extract<ChatEntry, { kind: "user" }>;

describe("recovering complete user input", () => {
	it("retains screenshot data and merges structured and wrapped file paths without duplicates", () => {
		const image = { mimeType: "image/png", data: "original-image-bytes" };
		const entry: UserEntry = {
			kind: "user",
			images: [image],
			attachedPaths: ["D:/owl/main.ts"],
			text: "[Attached files for this turn]\n- D:/owl/main.ts\n- D:/owl/extra.ts\n\n按截图修复\n\n[Image: image/png]",
		};
		const recovered = messageInputOf(entry);
		expect(recovered).toEqual({
			text: "按截图修复",
			images: [{ type: "image", ...image }],
			attachedPaths: ["D:/owl/main.ts", "D:/owl/extra.ts"],
		});
		expect(recovered.images?.[0]).not.toBe(image);
		expect(entry.images).toEqual([image]);
	});

	it("restores expanded skill instructions to the original short command and retains materials", () => {
		const entry: UserEntry = {
			kind: "user",
			images: [{ mimeType: "image/jpeg", data: "screenshot" }],
			text: '[Attached files for this turn]\n- D:/owl/main.ts\n\n<skill name="review" location="D:/skills/review/SKILL.md">\nInternal skill instructions\n</skill>\n\n检查截图中的问题\n\n[Image converted image/jpeg]',
		};
		expect(messageInputOf(entry)).toEqual({
			text: "/skill:review 检查截图中的问题",
			images: [{ type: "image", mimeType: "image/jpeg", data: "screenshot" }],
			attachedPaths: ["D:/owl/main.ts"],
		});
	});

	it("uses edited text while retaining the original screenshots and structured references", () => {
		const entry: UserEntry = {
			kind: "user",
			text: "原要求",
			attachedPaths: ["D:/owl/main.ts"],
			images: [{ mimeType: "image/png", data: "screenshot" }],
		};
		expect(messageInputOf(entry, "修改后的要求")).toEqual({
			text: "修改后的要求",
			attachedPaths: ["D:/owl/main.ts"],
			images: [{ type: "image", mimeType: "image/png", data: "screenshot" }],
		});
	});

	it("does not treat user-written image-like text as a transport wrapper", () => {
		expect(messageInputOf({ kind: "user", text: "请解释这行\n[Image: example]" })).toEqual({
			text: "请解释这行\n[Image: example]",
		});
		expect(messageInputOf({ kind: "user", text: "/skill:review" })).toEqual({ text: "/skill:review" });
	});
});
