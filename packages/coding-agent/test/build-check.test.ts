import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type BuildInfo, createBuildInfo, readBuildInfo, writeBuildInfo } from "../src/core/build-info.ts";
import { BuildChecker } from "../src/modes/desktop/build-check.ts";
import type { BuildIssue } from "../src/modes/desktop/protocol.ts";

// 合成一个最小 monorepo：桥 dist、UI dist、一个插件 dist 各带 build-info.json，
// 再改源码 / 换产物，看 build.hello 报出的差异。

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, repoPath: string, content: string): void {
	const full = join(root, repoPath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

function makeRepo() {
	const root = mkdtempSync(join(tmpdir(), "owl-build-check-"));
	roots.push(root);
	write(root, "packages/coding-agent/package.json", "{}");
	write(root, "packages/coding-agent/src/modes/desktop/protocol.ts", "export type A = 1;\n");
	write(root, "packages/coding-agent/src/main.ts", "console.log(1);\n");
	write(root, "apps/desktop/src/App.tsx", "export {};\n");
	write(root, "packages/owl-image/src/index.ts", "export {};\n");

	const bridgeDist = join(root, "packages/coding-agent/dist");
	const bridge = createBuildInfo({
		component: "bridge",
		repoRoot: root,
		inputs: ["packages/coding-agent/src/modes/desktop/protocol.ts", "packages/coding-agent/src/main.ts"],
		protocol: true,
	});
	writeBuildInfo(bridgeDist, bridge);
	const uiRoot = join(root, "apps/desktop/dist");
	const ui = createBuildInfo({
		component: "ui",
		repoRoot: root,
		inputs: ["apps/desktop/src/App.tsx"],
		protocol: true,
	});
	writeBuildInfo(uiRoot, ui);
	const pluginDir = join(root, "packages/owl-image");
	writeBuildInfo(
		join(pluginDir, "dist"),
		createBuildInfo({ component: "plugin:owl-image", repoRoot: root, inputs: ["packages/owl-image/src/index.ts"] }),
	);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);

	const checker = (plugins: string[] = [pluginDir]) =>
		new BuildChecker({
			moduleUrl: pathToFileURL(join(bridgeDist, "modes/desktop/serve.js")).href,
			uiRoot,
			agentDir,
			plugins: async () => plugins,
			onDiagnostic: () => {},
		});
	return { root, bridge, ui, bridgeDist, uiRoot, agentDir, checker };
}

const kinds = (issues: BuildIssue[]) => issues.map((issue) => issue.kind);

describe("BuildChecker", () => {
	it("reports nothing when UI, bridge and plugins all match their sources", async () => {
		const repo = makeRepo();
		const result = await repo.checker().hello({ buildId: repo.ui.buildId, protocolHash: repo.ui.protocolHash });
		expect(result.issues).toEqual([]);
		expect(result.bridge).toMatchObject({
			mode: "dist",
			buildId: repo.bridge.buildId,
			protocolHash: repo.bridge.protocolHash,
		});
	});

	it("detects edited sources for the bridge, the UI and plugins", async () => {
		const repo = makeRepo();
		const checker = repo.checker();
		write(repo.root, "packages/coding-agent/src/main.ts", "console.log(2);\n");
		write(repo.root, "apps/desktop/src/App.tsx", "export const x = 1;\n");
		write(repo.root, "packages/owl-image/src/index.ts", "export const y = 1;\n");
		const result = await checker.hello({ buildId: repo.ui.buildId, protocolHash: repo.ui.protocolHash });
		expect(result.issues).toContainEqual({
			kind: "bridge-source-newer",
			files: ["packages/coding-agent/src/main.ts"],
			count: 1,
		});
		expect(result.issues).toContainEqual({ kind: "ui-source-newer", files: ["apps/desktop/src/App.tsx"], count: 1 });
		expect(result.issues).toContainEqual({
			kind: "plugin-source-newer",
			plugin: "owl-image",
			files: ["packages/owl-image/src/index.ts"],
			count: 1,
		});
	});

	it("ignores CRLF-only differences", async () => {
		const repo = makeRepo();
		write(repo.root, "packages/coding-agent/src/main.ts", "console.log(1);\r\n");
		const result = await repo.checker([]).hello({ buildId: repo.ui.buildId, protocolHash: repo.ui.protocolHash });
		expect(result.issues).toEqual([]);
	});

	it("tells a stale window and a stale bridge process apart from stale sources", async () => {
		const repo = makeRepo();
		const checker = repo.checker([]);
		// 桥 dist 在进程启动后被重建
		const rebuilt: BuildInfo = { ...(readBuildInfo(repo.bridgeDist) as BuildInfo), buildId: "rebuilt" };
		writeBuildInfo(repo.bridgeDist, rebuilt);
		const result = await checker.hello({ buildId: "an-older-ui-bundle", protocolHash: repo.ui.protocolHash });
		expect(kinds(result.issues).sort()).toEqual(["bridge-restart", "ui-reload"]);
	});

	it("flags a protocol mismatch and skips UI checks for the dev server", async () => {
		const repo = makeRepo();
		const checker = repo.checker([]);
		const mismatch = await checker.hello({ buildId: repo.ui.buildId, protocolHash: "0000000000000000" });
		expect(mismatch.issues).toEqual([
			{ kind: "protocol-mismatch", uiProtocol: "0000000000000000", bridgeProtocol: repo.bridge.protocolHash },
		]);
		const dev = await checker.hello({ buildId: "dev" });
		expect(dev.issues).toEqual([]);
	});

	it("reports an unstamped bridge dist and corrupt state backups found at startup", async () => {
		const repo = makeRepo();
		rmSync(join(repo.bridgeDist, "build-info.json"));
		writeFileSync(join(repo.agentDir, "memory.json.corrupt"), "{bad");
		const result = await repo.checker([]).hello({ buildId: repo.ui.buildId, protocolHash: repo.ui.protocolHash });
		expect(result.bridge.mode).toBe("unstamped");
		expect(kinds(result.issues)).toEqual(["bridge-unstamped", "corrupt-files"]);
	});
});
