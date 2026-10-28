import { describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../bridge/client.ts";
import { absoluteAttachmentPath, attachmentProbeTarget, checkAttachmentPaths } from "./attachment-preflight.ts";

describe("explicit attachment paths keep their source-directory meaning", () => {
	it.each([
		["../requirements.md", "D:/project/src", "D:/project/requirements.md"],
		["../requirements.md", "/workspace/src", "/workspace/requirements.md"],
		["D:\\elsewhere\\报告 #1%20.md", "D:/project", "D:/elsewhere/报告 #1%20.md"],
		["file:///D:/elsewhere/report%20%231.md", "D:/project", "D:/elsewhere/report #1.md"],
		["\\\\server\\share\\project\\..\\file.md", "D:/project", "//server/share/file.md"],
		["../../../file.md", "\\\\server\\share\\project", "//server/share/file.md"],
		["../file.md", "//server/share/project", "//server/share/file.md"],
		["/case/README.md", "/case", "/case/README.md"],
		["D:/", "D:/project", "D:/"],
		["/", "/project", "/"],
	])("resolves %s from %s", (input, cwd, expected) => {
		expect(absoluteAttachmentPath(input, cwd)).toBe(expected);
	});

	it.each([
		"https://example.test/file",
		"javascript:alert(1)",
		"D:relative.md",
		"file:///D:/file.md#fragment",
		"\\root-relative",
		"report.md\0",
		"//server",
		"file:///D:/bad%00.md",
		"file:///D:/bad%2Fpath",
		"~/requirements.md",
	])("rejects ambiguous or non-file reference %s", (input) => {
		expect(absoluteAttachmentPath(input, "D:/project")).toBeUndefined();
	});

	it("uses the existing workspace fence locally and only the attached file's parent externally", () => {
		expect(attachmentProbeTarget("src/main.ts", "D:/project")).toEqual({
			cwd: "D:/project",
			path: "src/main.ts",
			fileUrl: "file:///D:/project/src/main.ts",
			withinWorkspace: true,
		});
		expect(attachmentProbeTarget("../outside.md", "D:/project")).toEqual({
			cwd: "D:/",
			path: "outside.md",
			fileUrl: "file:///D:/outside.md",
			withinWorkspace: false,
		});
		expect(attachmentProbeTarget("//server/share", "D:/project")).toEqual({
			cwd: "//server/share",
			path: ".",
			fileUrl: "file://server/share/.",
			withinWorkspace: false,
		});
	});
});

describe("metadata preflight", () => {
	it("checks files and directories without reading their contents or requesting a model", async () => {
		const request = vi.fn(async (payload: { path: string }) => ({
			ok: true,
			result: { isFile: payload.path !== "docs", isDirectory: payload.path === "docs" },
		}));
		const client = { request } as unknown as Pick<BridgeClient, "request">;
		expect(await checkAttachmentPaths(client, "D:/project", ["docs", "src/main.ts", "src/main.ts"])).toEqual([]);
		expect(request.mock.calls.map(([payload]) => payload)).toEqual([
			{ type: "fs.stat", cwd: "D:/project", path: "docs" },
			{ type: "fs.stat", cwd: "D:/project", path: "src/main.ts" },
		]);
	});

	it("reports missing, denied and unconfirmed references independently", async () => {
		const request = vi.fn(async (payload: { path: string }) =>
			payload.path === "missing.md"
				? { ok: false, error: "ENOENT: no such file" }
				: payload.path === "denied.md"
					? { ok: false, error: "EACCES: permission denied" }
					: { ok: true, result: undefined },
		);
		const issues = await checkAttachmentPaths({ request } as unknown as Pick<BridgeClient, "request">, "D:/project", [
			"missing.md",
			"denied.md",
			"unknown.md",
			"https://bad.test/path",
		]);
		expect(issues.map((issue) => issue.path)).toEqual([
			"missing.md",
			"denied.md",
			"unknown.md",
			"https://bad.test/path",
		]);
		expect(issues[0].reason).toContain("不存在");
		expect(issues[1].reason).toContain("无法访问");
		expect(issues[2].reason).toContain("不是可读取");
		expect(request).toHaveBeenCalledTimes(3);
	});
});
