import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveArtifactActionPath } from "./artifact-actions.ts";

test("artifact paths copy as real absolute Windows, UNC and POSIX paths", () => {
	assert.deepEqual(resolveArtifactActionPath("./reports/../报告 #1%20.md", "D:\\owl\\work\\..\\project"), {
		relative: "报告 #1%20.md",
		absolute: "D:\\owl\\project\\报告 #1%20.md",
	});
	assert.deepEqual(resolveArtifactActionPath("file://server/share/owl/report%20one.md", "//server/share/owl"), {
		relative: "report one.md",
		absolute: "\\\\server\\share\\owl\\report one.md",
	});
	assert.deepEqual(resolveArtifactActionPath("/workspace/reports/hello.md", "/workspace"), {
		relative: "reports/hello.md",
		absolute: "/workspace/reports/hello.md",
	});
});

test("artifact actions reject out-of-workspace, drive-relative and malformed paths", () => {
	for (const input of [
		"../outside.md",
		"reports/../../outside.md",
		"D:/owl-other/report.md",
		"E:/owl/report.md",
		"D:report.md",
		"https://example.com/report.md",
		"report.md\0",
		"file:///D:/outside.md",
	]) {
		assert.equal(resolveArtifactActionPath(input, "D:/owl"), undefined, input);
	}
	assert.equal(resolveArtifactActionPath("report.md", ""), undefined);
	assert.equal(resolveArtifactActionPath("report.md", "D:/owl\0"), undefined);
});
