import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellEnv } from "../src/utils/shell.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("getShellEnv python discovery", () => {
	// where.exe 本体也要能从 stub PATH 里解析（Windows 上子进程按传入 PATH 找可执行文件）
	const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

	it("prepends a per-user Python install when python is not on PATH", () => {
		const temp = mkdtempSync(join(tmpdir(), "owl-py-"));
		tempDirs.push(temp);
		const localAppData = join(temp, "LocalAppData");
		const py312 = join(localAppData, "Programs", "Python", "Python312");
		mkdirSync(join(py312), { recursive: true });
		writeFileSync(join(py312, "python.exe"), "");
		mkdirSync(join(localAppData, "Programs", "Python", "Launcher"), { recursive: true });
		writeFileSync(join(localAppData, "Programs", "Python", "Launcher", "py.exe"), "");

		vi.stubEnv("LOCALAPPDATA", localAppData);
		vi.stubEnv("PATH", `${SYSTEM32};${join(temp, "nothing")}`);

		const env = getShellEnv();
		const pathValue = env.PATH ?? env.Path ?? "";
		expect(pathValue.startsWith(py312)).toBe(true);
		expect(pathValue).toContain("Launcher");
		expect(env.PYTHONUTF8).toBe("1");
	});

	it("does not prepend anything when python already resolves on PATH", () => {
		const temp = mkdtempSync(join(tmpdir(), "owl-py-"));
		tempDirs.push(temp);
		const localAppData = join(temp, "LocalAppData");
		const py312 = join(localAppData, "Programs", "Python", "Python313");
		mkdirSync(py312, { recursive: true });
		writeFileSync(join(py312, "python.exe"), "");
		const onPathDir = join(temp, "already-on-path");
		mkdirSync(onPathDir, { recursive: true });
		writeFileSync(join(onPathDir, "python.exe"), "");

		vi.stubEnv("LOCALAPPDATA", localAppData);
		vi.stubEnv("PATH", `${SYSTEM32};${onPathDir}`);

		const env = getShellEnv();
		const pathValue = env.PATH ?? env.Path ?? "";
		expect(pathValue).not.toContain("Python313");
	});

	it("end-to-end: bash resolves python and prints Chinese via the owl env", () => {
		const env = getShellEnv();
		const version = spawnSync("bash", ["-c", "python --version"], { env, encoding: "utf-8" });
		console.log(
			"=== python --version via owl env ===",
			JSON.stringify(version.stdout),
			JSON.stringify(version.stderr.slice(0, 80)),
		);
		if (version.status !== 0) {
			// 真机没装 Python 时只要求不抛错；本机已装 3.12，正常会走通
			console.log("本机 PATH 无法解析 python（未安装？），跳过端到端");
			return;
		}
		expect(version.stdout).toContain("Python 3");
		const cn = spawnSync("bash", ["-c", "python -c \"print('「高性价比人生指南」中文正常')\""], {
			env,
			encoding: "utf-8",
		});
		console.log("=== python 中文输出 ===", JSON.stringify(cn.stdout));
		expect(cn.status).toBe(0);
		expect(cn.stdout).toContain("高性价比人生指南");
	});
});
