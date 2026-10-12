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
import {
	gitCommit,
	gitCommitDetail,
	gitCommitDiff,
	gitDiff,
	gitDiscard,
	gitHistory,
	gitPush,
	gitStage,
	gitStatus,
	parseGitHubRemote,
	parseHistory,
	parseLog,
	parseNameStatusZ,
	parseNumstatZ,
	parseRefs,
	parseStatusZ,
	rebaseStatusEntriesToCwd,
} from "../src/modes/desktop/sidebar-git.ts";
import { buildChecksQuery, rollupState } from "../src/modes/desktop/sidebar-github.ts";
import { affectsGitState, createGitStateWatcher } from "../src/modes/desktop/sidebar-watch.ts";

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

describe("rebaseStatusEntriesToCwd（workspace 在仓库子目录内的重定基）", () => {
	it("cwd 之下剥离前缀，cwd 之外丢弃，目录自身映射为 .，cwd 外旧路径保留原值", () => {
		const parsed = {
			branch: "main",
			upstream: "origin/main",
			entries: [
				{ path: "sub/a.txt", x: " ", y: "M" },
				{ path: "sub/", x: "?", y: "?" },
				{ path: "elsewhere/b.txt", x: " ", y: "M" },
				{ path: "sub/new.ts", x: "R", y: " ", origPath: "sub/old.ts" },
				{ path: "sub/moved-in.ts", x: "R", y: " ", origPath: "outside/old.ts" },
			],
		};
		const result = rebaseStatusEntriesToCwd("sub", parsed);
		expect(result.entries).toEqual([
			{ path: "a.txt", x: " ", y: "M" },
			{ path: ".", x: "?", y: "?" },
			{ path: "new.ts", x: "R", y: " ", origPath: "old.ts" },
			{ path: "moved-in.ts", x: "R", y: " ", origPath: "outside/old.ts" },
		]);
		expect(result.branch).toBe("main");
		expect(result.upstream).toBe("origin/main");
	});

	it("prefix 为空或越界时原样返回", () => {
		const parsed = { entries: [{ path: "a.txt", x: "?", y: "?" }] };
		expect(rebaseStatusEntriesToCwd("", parsed)).toBe(parsed);
		expect(rebaseStatusEntriesToCwd("../up", parsed)).toBe(parsed);
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

	it("workspace 开在仓库子目录：条目重定基为 cwd 相对，仓库外部改动不显示", async () => {
		const repo = await makeTempDir();
		try {
			run("git", ["init", "-q"], { cwd: repo });
			run("git", ["config", "user.email", "t@owl.local"], { cwd: repo });
			run("git", ["config", "user.name", "owl"], { cwd: repo });
			await writeFile(join(repo, "root.txt"), "r1\n");
			run("git", ["add", "."], { cwd: repo });
			run("git", ["commit", "-q", "-m", "init"], { cwd: repo });

			const sub = join(repo, "sub");
			await mkdir(sub);
			await writeFile(join(sub, "new.txt"), "n1\n");
			await writeFile(join(repo, "root.txt"), "r2\n");

			// 只显示 cwd 之下的条目，且路径已剥离仓库根前缀
			const status = await gitStatus(sub);
			expect(status.repo).toBe(true);
			expect(status.entries.map((entry) => entry.path)).toEqual(["new.txt"]);

			// diff / discard / stage 都按 cwd 相对 pathspec 工作
			const diff = await gitDiff(sub, "new.txt");
			expect(diff).toContain("+n1");
			await gitDiscard(sub, "new.txt");
			expect((await gitStatus(sub)).entries).toHaveLength(0);

			await writeFile(join(sub, "new.txt"), "n1\n");
			await mkdir(join(sub, "newdir"), { recursive: true });
			await writeFile(join(sub, "newdir", "deep.txt"), "d1\n");
			// -uall：整目录未跟踪展开成单文件条目，不再折叠成 `?? dir/`
			const expanded = await gitStatus(sub);
			expect(expanded.entries.map((entry) => entry.path).sort()).toEqual(["new.txt", "newdir/deep.txt"]);
			await rm(join(sub, "newdir"), { recursive: true, force: true });

			await gitStage(sub, ["new.txt"]);
			const staged = await gitStatus(sub);
			expect(staged.entries[0]).toMatchObject({ path: "new.txt", x: "A", y: " " });
			const stagedDiff = await gitDiff(sub, "new.txt", true);
			expect(stagedDiff).toContain("+n1");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});

describe("git 子仓库聚合（workspace 根不是仓库）", () => {
	it("发现子仓库、聚合 status、按仓库路由 stage/diff/commit/discard", async () => {
		const ws = await makeTempDir();
		const repoA = join(ws, "pkg-a");
		const repoB = join(ws, "group", "pkg-b");
		const repoC = join(ws, "deep", "nest", "pkg-c");
		const fake = join(ws, "node_modules", "fake-repo");
		try {
			for (const dir of [repoA, repoB, repoC, fake]) {
				await mkdir(dir, { recursive: true });
				run("git", ["init", "-q"], { cwd: dir });
			}
			await writeFile(join(repoA, "a.txt"), "a1\na2\n");
			await writeFile(join(repoB, "b.txt"), "b1\n");
			await writeFile(join(repoC, "c.txt"), "c1\n");
			await writeFile(join(fake, "z.txt"), "z");

			// 聚合 status：深度 1/2/3 的仓库都命中，node_modules 里的跳过
			const status = await gitStatus(ws);
			expect(status.repo).toBe(true);
			expect(status.entries.map((entry) => entry.path).sort()).toEqual([
				"deep/nest/pkg-c/c.txt",
				"group/pkg-b/b.txt",
				"pkg-a/a.txt",
			]);
			expect(status.repos?.map((repo) => repo.root).sort()).toEqual(["deep/nest/pkg-c", "group/pkg-b", "pkg-a"]);
			// 多仓库：不标榜单一分支
			expect(status.branch).toBeUndefined();

			// stage：workspace 相对路径路由到所属仓库
			await gitStage(ws, ["pkg-a/a.txt"]);
			const staged = await gitStatus(ws);
			expect(staged.entries.find((entry) => entry.path === "pkg-a/a.txt")).toMatchObject({ x: "A", y: " " });

			// staged diff：按路径路由后取到 pkg-a 的内容
			const diff = await gitDiff(ws, "pkg-a/a.txt", true);
			expect(diff).toContain("+a1");

			// commit：只提交有暂存条目的仓库（pkg-a），其余仓库不受影响
			run("git", ["config", "user.email", "t@owl.local"], { cwd: repoA });
			run("git", ["config", "user.name", "owl"], { cwd: repoA });
			await gitCommit(ws, "feat: a");
			expect(run("git", ["log", "--pretty=%s"], { cwd: repoA }).trim()).toBe("feat: a");
			const after = await gitStatus(ws);
			expect(after.entries.map((entry) => entry.path).sort()).toEqual([
				"deep/nest/pkg-c/c.txt",
				"group/pkg-b/b.txt",
			]);

			// discard untracked：删除文件后该仓库变干净
			await gitDiscard(ws, "group/pkg-b/b.txt");
			const clean = await gitStatus(ws);
			expect(clean.entries.map((entry) => entry.path)).toEqual(["deep/nest/pkg-c/c.txt"]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("限定仓库提交：只提交所选仓库，其余仓库的暂存保持不动", async () => {
		const ws = await makeTempDir();
		const repoA = join(ws, "pkg-a");
		const repoB = join(ws, "pkg-b");
		try {
			for (const dir of [repoA, repoB]) {
				await mkdir(dir, { recursive: true });
				run("git", ["init", "-q"], { cwd: dir });
				run("git", ["config", "user.email", "t@owl.local"], { cwd: dir });
				run("git", ["config", "user.name", "owl"], { cwd: dir });
			}
			await writeFile(join(repoA, "a.txt"), "a1\n");
			await writeFile(join(repoB, "b.txt"), "b1\n");
			await gitStage(ws, ["pkg-a/a.txt", "pkg-b/b.txt"]);

			// 不带 repo：两个有暂存的仓库都提交
			await gitCommit(ws, "feat: all");
			expect(run("git", ["log", "--pretty=%s"], { cwd: repoA }).trim()).toBe("feat: all");
			expect(run("git", ["log", "--pretty=%s"], { cwd: repoB }).trim()).toBe("feat: all");

			// 带 repo：只提交指定仓库
			await writeFile(join(repoA, "a2.txt"), "a2\n");
			await writeFile(join(repoB, "b2.txt"), "b2\n");
			await gitStage(ws, ["pkg-a/a2.txt", "pkg-b/b2.txt"]);
			await gitCommit(ws, "feat: b only", "pkg-b");
			// git log 最新提交在第一行
			expect(run("git", ["log", "--pretty=%s"], { cwd: repoB }).split("\n")[0]?.trim()).toBe("feat: b only");
			const status = await gitStatus(ws);
			// pkg-a 的 a2.txt 仍是暂存态（A）未被波及
			expect(status.entries.find((entry) => entry.path === "pkg-a/a2.txt")).toMatchObject({ x: "A", y: " " });

			// 未识别的仓库名拒绝
			await expect(gitCommit(ws, "feat: x", "nope")).rejects.toThrow("不是已识别的子仓库");
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("ignored：整个被忽略的目录折叠成一条，路径归一到 workspace 相对", async () => {
		const ws = await makeTempDir();
		const repo = join(ws, "app");
		try {
			await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
			await mkdir(join(repo, "src"), { recursive: true });
			run("git", ["init", "-q"], { cwd: repo });
			await writeFile(join(repo, ".gitignore"), "node_modules/\n*.log\n");
			await writeFile(join(repo, "node_modules", "pkg", "index.js"), "x");
			await writeFile(join(repo, "src", "debug.log"), "x");
			await writeFile(join(repo, "src", "main.ts"), "x");

			const aggregated = await gitStatus(ws);
			expect(aggregated.ignored?.sort()).toEqual(["app/node_modules", "app/src/debug.log"]);
			expect(aggregated.entries.map((entry) => entry.path)).not.toContain("app/src/debug.log");

			const inRepo = await gitStatus(join(repo, "src"));
			expect(inRepo.ignored).toEqual(["debug.log"]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("workspace 根是仓库且嵌套独立仓库：外层与嵌套仓库一起聚合，路径路由到最深的仓库", async () => {
		const ws = await makeTempDir();
		try {
			const init = (dir: string, branch: string): void => {
				run("git", ["init", "-q", "-b", branch], { cwd: dir });
				run("git", ["config", "user.email", "t@owl.local"], { cwd: dir });
				run("git", ["config", "user.name", "Owl Test"], { cwd: dir });
				run("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
			};
			init(ws, "master");
			await writeFile(join(ws, "root.txt"), "root\n");
			run("git", ["add", "-A"], { cwd: ws });
			run("git", ["commit", "-q", "-m", "outer: init"], { cwd: ws });
			const inner = join(ws, "xmart-web");
			await mkdir(inner);
			init(inner, "dev-agent");
			await writeFile(join(inner, "app.ts"), "a\n");
			run("git", ["add", "-A"], { cwd: inner });
			run("git", ["commit", "-q", "-m", "inner: init"], { cwd: inner });

			await writeFile(join(ws, "root.txt"), "root\nchanged\n");
			await writeFile(join(inner, "app.ts"), "a\nb\n");
			const status = await gitStatus(ws);
			expect(status.repos).toEqual([
				{ root: ".", branch: "master" },
				{ root: "xmart-web", branch: "dev-agent" },
			]);
			// 外层仓库把嵌套仓库报成 `?? xmart-web/`，不应出现
			expect(status.entries.map((entry) => entry.path).sort()).toEqual(["root.txt", "xmart-web/app.ts"]);

			expect(await gitDiff(ws, "xmart-web/app.ts")).toContain("+b");
			await gitStage(ws, ["xmart-web/app.ts", "root.txt"]);
			await gitCommit(ws, "inner: change", "xmart-web");
			expect(run("git", ["log", "-1", "--format=%s"], { cwd: inner }).trim()).toBe("inner: change");
			// 外层的暂存保持不动，再单独提交外层
			await gitCommit(ws, "outer: change", ".");
			expect(run("git", ["log", "-1", "--format=%s"], { cwd: ws }).trim()).toBe("outer: change");

			expect((await gitHistory(ws)).branch).toBe("master");
			const innerHistory = await gitHistory(ws, { repo: "xmart-web" });
			expect(innerHistory.branch).toBe("dev-agent");
			expect(innerHistory.entries.map((entry) => entry.subject)).toEqual(["inner: change", "inner: init"]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("单仓库没有嵌套仓库时保持单仓库模式", async () => {
		const ws = await makeTempDir();
		try {
			run("git", ["init", "-q"], { cwd: ws });
			await mkdir(join(ws, "src"));
			await writeFile(join(ws, "src", "a.ts"), "a");
			const status = await gitStatus(ws);
			expect(status.repos).toBeUndefined();
			expect(status.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("单个损坏的 .git 候选不拖垮聚合", async () => {
		const ws = await makeTempDir();
		try {
			const good = join(ws, "good");
			await mkdir(good);
			run("git", ["init", "-q"], { cwd: good });
			await mkdir(join(ws, "broken", ".git"), { recursive: true });
			await writeFile(join(good, "g.txt"), "g");
			const status = await gitStatus(ws);
			expect(status.repo).toBe(true);
			expect(status.entries.map((entry) => entry.path)).toEqual(["good/g.txt"]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});
});

describe("git 状态 watcher", () => {
	it("affectsGitState：工作区文件与 .git 的 index/HEAD/refs 算，objects、锁文件、node_modules 内部不算", () => {
		expect(affectsGitState("src/deep/new.ts")).toBe(true);
		expect(affectsGitState("pkg-a\\.git\\index")).toBe(true);
		expect(affectsGitState(".git/HEAD")).toBe(true);
		expect(affectsGitState(".git/refs/heads/main")).toBe(true);
		expect(affectsGitState(".git/refs/heads/main.lock")).toBe(false);
		expect(affectsGitState(".git/index.lock")).toBe(false);
		expect(affectsGitState(".git/objects/ab/cdef")).toBe(false);
		expect(affectsGitState(".git/logs/HEAD")).toBe(false);
		expect(affectsGitState("node_modules")).toBe(true);
		expect(affectsGitState("node_modules/pkg/index.js")).toBe(false);
	});

	it.runIf(process.platform === "win32" || process.platform === "darwin")(
		"外部 stage 与未展开目录里的新文件都会推送，自己跑 status 不会",
		async () => {
			const repo = await makeTempDir();
			let pushes = 0;
			const watcher = createGitStateWatcher(
				repo,
				() => {
					pushes += 1;
				},
				() => {},
			);
			const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 700));
			try {
				run("git", ["init", "-q"], { cwd: repo });
				await mkdir(join(repo, "a", "b"), { recursive: true });
				await writeFile(join(repo, "a", "b", "deep.txt"), "x");
				await settle();
				expect(pushes).toBeGreaterThan(0);

				pushes = 0;
				await gitStatus(repo);
				await gitStatus(repo);
				await settle();
				expect(pushes).toBe(0);

				run("git", ["add", "."], { cwd: repo });
				await settle();
				expect(pushes).toBeGreaterThan(0);
			} finally {
				watcher.close();
				await rm(repo, { recursive: true, force: true });
			}
		},
	);
});

describe("提交历史解析（纯函数）", () => {
	const remotes = new Set(["origin", "upstream"]);

	it("parseRefs：HEAD 指向、本地/远程分支、标签，跳过远程 HEAD", () => {
		expect(parseRefs("HEAD -> main, origin/main, origin/HEAD, tag: v1.0, feature/x", remotes)).toEqual([
			{ kind: "head", name: "main" },
			{ kind: "remote", name: "origin/main" },
			{ kind: "tag", name: "v1.0" },
			{ kind: "local", name: "feature/x" },
		]);
		expect(parseRefs("HEAD", remotes)).toEqual([{ kind: "head", name: "HEAD" }]);
		expect(parseRefs("", remotes)).toEqual([]);
	});

	it("parseHistory：字段切分、父提交、合并提交、记录间换行", () => {
		const record = (fields: string[]) => `${fields.join("\u001f")}\u001e`;
		const out = [
			record(["a".repeat(40), "aaaaaaa", "Merge x", "Alice", "a@x", "1700000100", "b1 c1", "HEAD -> main"]),
			`\n${record(["b".repeat(40), "bbbbbbb", "feat: y", "Bob", "b@x", "1700000000", "", ""])}`,
			"\n",
		].join("");
		const entries = parseHistory(out, remotes);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			short: "aaaaaaa",
			subject: "Merge x",
			email: "a@x",
			time: 1700000100,
			parents: ["b1", "c1"],
			refs: [{ kind: "head", name: "main" }],
		});
		expect(entries[1]).toMatchObject({ hash: "b".repeat(40), author: "Bob", parents: [], refs: [] });
	});

	it("parseNameStatusZ / parseNumstatZ：重命名两段路径、二进制计数缺省", () => {
		const nameStatus = ["M", "src/a.ts", "R087", "old.ts", "new.ts", "A", "img.png", ""].join("\0");
		expect(parseNameStatusZ(nameStatus)).toEqual([
			{ status: "M", path: "src/a.ts" },
			{ status: "R", path: "new.ts", origPath: "old.ts" },
			{ status: "A", path: "img.png" },
		]);
		const numstat = ["3\t1\tsrc/a.ts", "2\t2\t", "old.ts", "new.ts", "-\t-\timg.png", ""].join("\0");
		const stats = parseNumstatZ(numstat);
		expect(stats.get("src/a.ts")).toEqual({ additions: 3, deletions: 1 });
		expect(stats.get("new.ts")).toEqual({ additions: 2, deletions: 2 });
		expect(stats.get("img.png")).toEqual({});
	});

	it("parseGitHubRemote：https / 带凭据 https / scp / ssh，非 GitHub 返回 undefined", () => {
		const expected = { owner: "loeanxi", repo: "owl" };
		expect(parseGitHubRemote("https://github.com/loeanxi/owl.git")).toEqual(expected);
		expect(parseGitHubRemote("https://user@github.com/loeanxi/owl/")).toEqual(expected);
		expect(parseGitHubRemote("git@github.com:loeanxi/owl.git")).toEqual(expected);
		expect(parseGitHubRemote("ssh://git@github.com/loeanxi/owl")).toEqual(expected);
		expect(parseGitHubRemote("https://gitlab.com/loeanxi/owl.git")).toBeUndefined();
		expect(parseGitHubRemote(undefined)).toBeUndefined();
	});

	it("CI 查询：每个提交一个别名字段，rollup 状态折成三态", () => {
		const query = buildChecksQuery(["a".repeat(40), "b".repeat(40)]);
		expect(query).toContain(`c0: object(oid: "${"a".repeat(40)}")`);
		expect(query).toContain(`c1: object(oid: "${"b".repeat(40)}")`);
		expect(query).toContain("repository(owner: $owner, name: $name)");
		expect(rollupState("SUCCESS")).toBe("success");
		expect(rollupState("ERROR")).toBe("failure");
		expect(rollupState("EXPECTED")).toBe("pending");
		expect(rollupState(null)).toBeUndefined();
	});
});

describe("提交历史真实仓库", () => {
	it("发布 → 未推送标记 → 推送；分页、详情、提交 diff、GitHub 链接", async () => {
		const repo = await makeTempDir();
		const remote = await makeTempDir();
		try {
			run("git", ["init", "-q", "--bare"], { cwd: remote });
			run("git", ["init", "-q", "-b", "main"], { cwd: repo });
			run("git", ["config", "user.email", "t@owl.local"], { cwd: repo });
			run("git", ["config", "user.name", "Owl Test"], { cwd: repo });
			run("git", ["config", "commit.gpgsign", "false"], { cwd: repo });

			// 还没有提交：空列表，不抛错
			expect((await gitHistory(repo)).entries).toEqual([]);

			await writeFile(join(repo, "old.txt"), "one\ntwo\nthree\n");
			run("git", ["add", "-A"], { cwd: repo });
			run("git", ["commit", "-q", "-m", "feat: first"], { cwd: repo });
			run("git", ["remote", "add", "origin", remote], { cwd: repo });
			run("git", ["remote", "add", "gh", "https://github.com/acme/widget.git"], { cwd: repo });

			let history = await gitHistory(repo);
			expect(history).toMatchObject({ branch: "main", ahead: 0, behind: 0, canPublish: true, hasMore: false });
			expect(history.upstream).toBeUndefined();
			expect(history.githubUrl).toBe("https://github.com/acme/widget");

			await gitPush(repo);
			history = await gitHistory(repo);
			expect(history).toMatchObject({ upstream: "origin/main", canPublish: false, ahead: 0 });
			expect(history.entries[0]?.refs).toContainEqual({ kind: "remote", name: "origin/main" });

			run("git", ["mv", "old.txt", "renamed.txt"], { cwd: repo });
			await writeFile(join(repo, "renamed.txt"), "one\ntwo\nthree\nfour\n");
			await writeFile(join(repo, "added.txt"), "x\n");
			run("git", ["add", "-A"], { cwd: repo });
			run("git", ["commit", "-q", "-m", "refactor: rename\n\nlonger body"], { cwd: repo });

			history = await gitHistory(repo);
			expect(history.ahead).toBe(1);
			expect(history.entries.map((entry) => [entry.subject, entry.unpushed === true])).toEqual([
				["refactor: rename", true],
				["feat: first", false],
			]);
			expect(history.entries[0]?.refs[0]).toEqual({ kind: "head", name: "main" });

			const page = await gitHistory(repo, { count: 1 });
			expect(page.entries).toHaveLength(1);
			expect(page.hasMore).toBe(true);
			const next = await gitHistory(repo, { count: 1, skip: 1 });
			expect(next.entries[0]?.subject).toBe("feat: first");
			expect(next.hasMore).toBe(false);

			const head = history.entries[0]!;
			const detail = await gitCommitDetail(repo, head.hash);
			expect(detail).toMatchObject({ subject: "refactor: rename", body: "longer body", author: "Owl Test" });
			expect(detail.files).toContainEqual({ status: "A", path: "added.txt", additions: 1, deletions: 0 });
			expect(detail.files).toContainEqual(
				expect.objectContaining({ status: "R", path: "renamed.txt", origPath: "old.txt", additions: 1 }),
			);
			expect(detail.additions).toBe(2);

			const diff = await gitCommitDiff(repo, head.hash, ["old.txt", "renamed.txt"]);
			expect(diff).toMatch(/^diff --git/);
			expect(diff).toContain("rename to renamed.txt");
			expect(diff).toContain("+four");

			await writeFile(join(repo, "added.txt"), "x\ny\n");
			const worktreeDiff = await gitCommitDiff(repo, head.hash, ["added.txt"], "worktree");
			expect(worktreeDiff).toContain("+y");

			await expect(gitCommitDetail(repo, "not-a-hash")).rejects.toMatchObject({ code: "bad-request" });

			await gitPush(repo);
			history = await gitHistory(repo);
			expect(history.ahead).toBe(0);
			expect(history.entries.some((entry) => entry.unpushed === true)).toBe(false);
		} finally {
			await rm(repo, { recursive: true, force: true });
			await rm(remote, { recursive: true, force: true });
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
