import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellConfig, getShellEnv } from "../src/utils/shell.ts";

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

describe.skipIf(process.platform !== "win32")("getShellEnv maven and locale", () => {
	const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

	it("appends MAVEN_HOME/bin when mvn is not on PATH", () => {
		const temp = mkdtempSync(join(tmpdir(), "owl-mvn-"));
		tempDirs.push(temp);
		const home = join(temp, "apache-maven-3.9.9");
		mkdirSync(join(home, "bin"), { recursive: true });
		writeFileSync(join(home, "bin", "mvn.cmd"), "");

		vi.stubEnv("MAVEN_HOME", home);
		vi.stubEnv("M2_HOME", undefined);
		vi.stubEnv("PATH", `${SYSTEM32};${join(temp, "nothing")}`);

		const pathValue = (getShellEnv().PATH ?? "").split(";");
		expect(pathValue[pathValue.length - 1]).toBe(join(home, "bin"));
	});

	it("leaves PATH alone when mvn already resolves or MAVEN_HOME has no mvn", () => {
		const temp = mkdtempSync(join(tmpdir(), "owl-mvn-"));
		tempDirs.push(temp);
		const home = join(temp, "maven-home");
		mkdirSync(join(home, "bin"), { recursive: true });
		const onPath = join(temp, "on-path");
		mkdirSync(onPath, { recursive: true });
		writeFileSync(join(onPath, "mvn.cmd"), "");

		vi.stubEnv("MAVEN_HOME", home);
		vi.stubEnv("M2_HOME", undefined);
		vi.stubEnv("PATH", `${SYSTEM32};${join(temp, "nothing")}`);
		expect(getShellEnv().PATH).not.toContain("maven-home");

		writeFileSync(join(home, "bin", "mvn.cmd"), "");
		vi.stubEnv("PATH", `${SYSTEM32};${onPath}`);
		expect(getShellEnv().PATH).not.toContain("maven-home");
	});

	it("sets a UTF-8 LANG only when the user has none", () => {
		vi.stubEnv("LANG", undefined);
		vi.stubEnv("LC_ALL", undefined);
		expect(getShellEnv().LANG).toBe("C.UTF-8");

		vi.stubEnv("LANG", "zh_CN.GBK");
		expect(getShellEnv().LANG).toBe("zh_CN.GBK");

		vi.stubEnv("LANG", undefined);
		vi.stubEnv("LC_ALL", "C");
		expect(getShellEnv().LANG).toBeUndefined();
	});

	it("end-to-end: Git Bash prints Chinese paths readably under the owl env", () => {
		vi.stubEnv("LANG", undefined);
		vi.stubEnv("LC_ALL", undefined);
		const temp = mkdtempSync(join(tmpdir(), "owl-中文路径-"));
		tempDirs.push(temp);
		const missing = join(temp, "no-such-dir").replace(/\\/g, "/");
		const result = spawnSync(getShellConfig().shell, ["-c", `find '${missing}' 2>&1; true`], {
			env: getShellEnv(),
			encoding: "utf-8",
		});
		expect(result.stdout).toContain("owl-中文路径-");
	});
});
