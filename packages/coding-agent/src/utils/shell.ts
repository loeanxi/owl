import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// 先直接扫 PATH 条目：env 值是正确的 UTF-16。where.exe 的输出按控制台代码页
		// （中文系统是 GBK）编码，按 utf-8 解码后含 CJK 的路径（如中文用户名）会变乱码，
		// existsSync 必败——中文用户目录下的可执行文件会被误判成"不在 PATH 上"。
		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		for (const dir of (process.env[pathKey] ?? "").split(delimiter)) {
			if (!dir || dir.includes("?")) continue;
			const candidate = join(dir, executable);
			if (existsSync(candidate)) return candidate;
		}
		// 兜底：where 还能覆盖 App Paths 等注册表解析，路径不含 CJK 时依然有用
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			paths.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
		}
		// A Git install outside the standard locations (portable, custom root, scoop)
		// still puts git.exe on PATH. Derive the sibling bin\bash.exe from it, because
		// the bare bash.exe found on PATH is usually the WSL launcher, which fails with
		// "execvpe(/bin/bash) failed" when no distribution is installed.
		const gitOnPath = findExecutableOnPath("git.exe");
		const gitRoot = gitOnPath?.replace(/[\\/](?:cmd|bin|mingw64[\\/]bin)[\\/][^\\/]+$/i, "");
		if (gitRoot) {
			paths.push(`${gitRoot}\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

/**
 * Windows 目录名禁止含 '?'，所以带 '?' 的 PATH 条目不可能是真实目录——
 * 那是进程环境在某条启动链上被 ANSI 转码的残骸（如中文用户名变 '????'）。
 * 原样传给子 shell 只会留下永远搜不到命令的死条目，直接丢弃。
 */
function dropMojibakePathEntries(entries: string[]): string[] {
	if (process.platform !== "win32") return entries;
	return entries.filter((entry) => !entry.includes("?"));
}

/**
 * Windows 用户级 Python 常装在 %LOCALAPPDATA%\Programs\Python\Python3XX，而官方安装器
 * 的"加入 PATH"默认不勾——装完 `python` 就是 NOT FOUND（会话记录实测同一条命令先成功
 * 后失败）。PATH 上确实没有 python 时，把发现的安装目录前置进子 shell PATH；
 * 结果按 LOCALAPPDATA 键控缓存，每键只扫一次。
 */
let pythonPathCache: { localAppData: string; dirs: string[] } | undefined;

function discoverPythonPathDirs(): string[] {
	if (process.platform !== "win32") return [];
	if (findExecutableOnPath("python.exe") || findExecutableOnPath("python3.exe")) return [];
	const programsRoot = join(process.env.LOCALAPPDATA ?? "", "Programs", "Python");
	const dirs: string[] = [];
	try {
		const versions = readdirSync(programsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^Python3\d+$/i.test(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		for (const version of versions) {
			const dir = join(programsRoot, version);
			if (existsSync(join(dir, "python.exe"))) {
				dirs.push(dir);
				break;
			}
		}
	} catch {
		// 没有 Programs\Python 目录：未装用户级 Python
	}
	const launcher = join(programsRoot, "Launcher");
	if (existsSync(join(launcher, "py.exe"))) dirs.push(launcher);
	return dirs;
}

function getPythonPathDirs(): string[] {
	const localAppData = process.env.LOCALAPPDATA ?? "";
	if (!pythonPathCache || pythonPathCache.localAppData !== localAppData) {
		pythonPathCache = { localAppData, dirs: discoverPythonPathDirs() };
	}
	return pythonPathCache.dirs;
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = dropMojibakePathEntries(currentPath.split(delimiter).filter(Boolean));
	const hasBinDir = pathEntries.includes(binDir);
	let updatedPath = hasBinDir ? pathEntries : [binDir, ...pathEntries];
	const pythonDirs = getPythonPathDirs();
	if (pythonDirs.length > 0) updatedPath = [...pythonDirs, ...updatedPath];

	return {
		...process.env,
		[pathKey]: updatedPath.join(delimiter),
		// Windows 上 Python 默认按 ANSI 代码页（中文系统是 GBK）解码脚本与 stdio，模型内嵌
		// 中文脚本的字符串会变乱码甚至 SyntaxError（会话记录实测）。仅在用户未显式设置时
		// 注入 UTF-8 默认值，不覆盖用户自己的编码配置。
		...(process.env.PYTHONUTF8 === undefined ? { PYTHONUTF8: "1" } : {}),
		...(process.env.PYTHONIOENCODING === undefined ? { PYTHONIOENCODING: "utf-8" } : {}),
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Unicode interlinear annotation characters U+FFF9..U+FFFB (crash string-width due to a bug)
 */
export function sanitizeBinaryOutput(str: string): string {
	// All removed characters are single UTF-16 code units, so surrogate pairs are never split.
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
