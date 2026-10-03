/**
 * 侧边栏工作台宿主层测试：工作区围栏、目录列目、行级文件操作、
 * git porcelain/log 解析与真实仓库冒烟（对应 desktop 侧边栏的后端）。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	invalidateDirectoryCache,
	listWorkspaceDirectory,
	mkdirWorkspaceEntry,
	readWorkspaceFile,
	removeWorkspaceEntry,
	renameWorkspaceEntry,
	resolveUnderWorkspace,
	searchWorkspaceFiles,
	writeWorkspaceFile,
} from "../src/modes/desktop/sidebar-fs.ts";
import { gitDiff, gitStage, gitStatus, parseLog, parseStatusZ } from "../src/modes/desktop/sidebar-git.ts";

async function makeTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "owl-sidebar-test-"));
}

describe("resolveUnderWorkspace（工作区围栏）", () => {
	it("把相对路径 join 到 workspace 下", async () => {
		const cwd = await makeTempDir();
		try {
			const resolved = await resolveUnderWorkspace(cwd, "src/app.ts");
			expect(resolved.toLowerCase()).toBe(join(cwd, "src", "app.ts").toLowerCase());
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("拒绝绝对路径与 .. 逃逸", async () => {
		const cwd = await makeTempDir();
		try {
			await expect(resolveUnderWorkspace(cwd, "C:\\Windows\\system32")).rejects.toThrow();
			await expect(resolveUnderWorkspace(cwd, "../outside")).rejects.toThrow();
			await expect(resolveUnderWorkspace(cwd, "a/../../b")).rejects.toThrow();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("listWorkspaceDirectory", () => {
	it("目录优先排序、隐藏标记、POSIX 相对路径", async () => {
		const cwd = await makeTempDir();
		try {
			await mkdir(join(cwd, "b-dir"));
			await writeFile(join(cwd, "a.txt"), "hello");
			await writeFile(join(cwd, ".hidden"), "x");
			const listing = await listWorkspaceDirectory(cwd, "");
			expect(listing.truncated).toBe(false);
			const dirs = listing.entries.filter((entry) => entry.isDir);
			const files = listing.entries.filter((entry) => !entry.isDir);
			expect(dirs.length).toBeGreaterThan(0);
			// 目录都在文件前
			expect(listing.entries.slice(0, dirs.length).every((entry) => entry.isDir)).toBe(true);
			expect(files.map((entry) => entry.name)).toContain("a.txt");
			expect(listing.entries.find((entry) => entry.name === ".hidden")?.hidden).toBe(true);
			// wire path 是 POSIX 相对路径
			expect(listing.entries.every((entry) => !entry.path.includes("\\") && !entry.path.startsWith("/"))).toBe(true);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("缓存在写操作后失效（写完立刻列出能拿到新文件）", async () => {
		const cwd = await makeTempDir();
		try {
			await listWorkspaceDirectory(cwd, "");
			await writeWorkspaceFile(cwd, "new.txt", "content");
			const listing = await listWorkspaceDirectory(cwd, "");
			expect(listing.entries.some((entry) => entry.name === "new.txt")).toBe(true);
		} finally {
			invalidateDirectoryCache();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("读写与行级操作", () => {
	it("写读回环；二进制嗅探返回 binary", async () => {
		const cwd = await makeTempDir();
		try {
			await writeWorkspaceFile(cwd, "dir/nested.txt", "你好 owl");
			const text = await readWorkspaceFile(cwd, "dir/nested.txt");
			expect(text.kind).toBe("text");
			expect(text.content).toBe("你好 owl");

			const { writeFile: writeRaw } = await import("node:fs/promises");
			await writeRaw(join(cwd, "blob.bin"), Buffer.from([0x4f, 0x00, 0x57, 0x4c]));
			const binary = await readWorkspaceFile(cwd, "blob.bin");
			expect(binary.kind).toBe("binary");
			expect(binary.head).toBeDefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rename：单段名校验、冲突拒绝、根目录保护", async () => {
		const cwd = await makeTempDir();
		try {
			await writeWorkspaceFile(cwd, "old.txt", "x");
			await writeWorkspaceFile(cwd, "taken.txt", "y");
			await expect(renameWorkspaceEntry(cwd, "old.txt", "sub/ame")).rejects.toThrow("单段");
			await expect(renameWorkspaceEntry(cwd, "old.txt", "taken.txt")).rejects.toThrow("已存在");
			const root = await resolveUnderWorkspace(cwd, "");
			await expect(renameWorkspaceEntry(root, "", "x")).rejects.toThrow("根");
			const result = await renameWorkspaceEntry(cwd, "old.txt", "renamed.txt");
			expect(result.path).toBe("renamed.txt");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("mkdir / remove：冲突与根保护、目录递归删除", async () => {
		const cwd = await makeTempDir();
		try {
			await mkdirWorkspaceEntry(cwd, "", "folder");
			await expect(mkdirWorkspaceEntry(cwd, "", "folder")).rejects.toThrow("已存在");
			await writeWorkspaceFile(cwd, "folder/inner.txt", "x");
			// 递归删除整个目录
			await removeWorkspaceEntry(cwd, "folder");
			const listing = await listWorkspaceDirectory(cwd, "");
			expect(listing.entries.some((entry) => entry.name === "folder")).toBe(false);
			await expect(removeWorkspaceEntry(cwd, "")).rejects.toThrow("根");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("searchWorkspaceFiles：子串命中、跳过 node_modules", async () => {
		const cwd = await makeTempDir();
		try {
			await mkdir(join(cwd, "src"));
			await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
			await writeFile(join(cwd, "src", "AppConfig.ts"), "export {}");
			await writeFile(join(cwd, "node_modules", "pkg", "AppConfig.js"), "x");
			const hits = await searchWorkspaceFiles(cwd, "appconfig");
			expect(hits.length).toBe(1);
			expect(hits[0]!.path).toBe("src/AppConfig.ts");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("git porcelain / log 解析（纯函数）", () => {
	it("parseStatusZ：分支头、XY 状态、重命名旧路径", () => {
		const out = ["## main...origin/main [ahead 1]", " M src/app.ts", "R  old.ts", "new.ts", "?? notes.md", ""].join(
			"\0",
		);
		const parsed = parseStatusZ(out);
		expect(parsed.branch).toBe("main");
		expect(parsed.upstream).toBe("origin/main");
		expect(parsed.entries).toHaveLength(3);
		expect(parsed.entries[0]).toEqual({ path: "src/app.ts", x: " ", y: "M" });
		expect(parsed.entries[1]).toEqual({ path: "old.ts", x: "R", y: " ", origPath: "new.ts" });
		expect(parsed.entries[2]).toEqual({ path: "notes.md", x: "?", y: "?" });
	});

	it("parseLog：字段切分与数值时间", () => {
		const out = `${["abc123", "abc12", "feat: x", "alice", "1700000000", ""].join("\u001f")}\u001e`;
		const entries = parseLog(out);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			hash: "abc123",
			short: "abc12",
			subject: "feat: x",
			author: "alice",
			time: 1700000000,
		});
	});
});

describe("git 真实仓库冒烟", () => {
	it("status / untracked diff / stage 全链路", async () => {
		const repo = await makeTempDir();
		const plain = await makeTempDir();
		try {
			run("git", ["init", "-q"], { cwd: repo });
			await writeFile(join(repo, "hello.txt"), "line1\nline2\n");

			let status = await gitStatus(repo);
			expect(status.repo).toBe(true);
			expect(status.entries[0]?.y).toBe("?");

			// untracked 文件的 diff 由宿主合成（git diff 不显示 untracked）
			const diff = await gitDiff(repo, "hello.txt");
			expect(diff).toContain("+++ b/hello.txt");
			expect(diff).toContain("+line1");

			await gitStage(repo, ["hello.txt"]);
			status = await gitStatus(repo);
			expect(status.entries[0]).toMatchObject({ x: "A", y: " " });

			const stagedDiff = await gitDiff(repo, "hello.txt", true);
			expect(stagedDiff).toContain("+line2");

			// 非仓库目录：repo:false 而不是抛错
			expect((await gitStatus(plain)).repo).toBe(false);
		} finally {
			await rm(repo, { recursive: true, force: true });
			await rm(plain, { recursive: true, force: true });
		}
	});
});

function run(cmd: string, args: string[], options?: { cwd?: string }): string {
	return execFileSync(cmd, args, {
		encoding: "utf8",
		windowsHide: true,
		...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
	});
}
