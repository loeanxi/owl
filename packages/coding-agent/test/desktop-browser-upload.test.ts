import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authorizeBrowserUpload } from "../src/modes/desktop/browser-upload.ts";

async function workspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "owl-browser-upload-"));
}

describe("browser upload path fence", () => {
	it("accepts a file inside the workspace", async () => {
		const root = await workspace();
		const file = join(root, "inside.txt");
		await writeFile(file, "hello", "utf8");
		const resolved = await authorizeBrowserUpload([file], { workspaceRoot: root });
		expect(resolved).toEqual([await realpath(file)]);
	});

	it("rejects a file outside the workspace", async () => {
		const root = await workspace();
		const outside = join(await workspace(), "secret.txt");
		await writeFile(outside, "secret", "utf8");
		await expect(authorizeBrowserUpload([outside], { workspaceRoot: root })).rejects.toMatchObject({
			code: "FILE_NOT_AUTHORIZED",
		});
	});

	it("rejects a symlink that points outside the workspace", async () => {
		const root = await workspace();
		const outside = join(await workspace(), "secret.txt");
		await writeFile(outside, "secret", "utf8");
		const link = join(root, "link.txt");
		try {
			await symlink(outside, link);
		} catch {
			return; // 没有创建符号链接的权限（Windows 未开开发者模式）：该分支无法在此环境验证
		}
		await expect(authorizeBrowserUpload([link], { workspaceRoot: root })).rejects.toMatchObject({
			code: "FILE_NOT_AUTHORIZED",
		});
	});

	it("refuses to upload when the call carries no workspace scope", async () => {
		const root = await workspace();
		const file = join(root, "inside.txt");
		await writeFile(file, "hello", "utf8");
		await expect(authorizeBrowserUpload([file], undefined)).rejects.toMatchObject({
			code: "FILE_NOT_AUTHORIZED",
		});
	});

	it("reports a missing file as unavailable instead of authorized", async () => {
		const root = await workspace();
		await expect(authorizeBrowserUpload([join(root, "missing.txt")], { workspaceRoot: root })).rejects.toMatchObject({
			code: "FILE_UNAVAILABLE",
		});
	});

	it("rejects an empty path list", async () => {
		const root = await workspace();
		await expect(authorizeBrowserUpload(["   "], { workspaceRoot: root })).rejects.toMatchObject({
			code: "FILE_NOT_AUTHORIZED",
		});
	});
});
