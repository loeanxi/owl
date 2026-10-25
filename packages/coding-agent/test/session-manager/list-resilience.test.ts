import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

function writeSession(dir: string, file: string, id: string, messages: number): string {
	const path = join(dir, file);
	const lines = [JSON.stringify({ type: "session", id, cwd: "D:/tmp", timestamp: "2026-10-20T00:00:00.000Z" })];
	for (let i = 0; i < messages; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: `m${i}`, timestamp: 1790000000000 + i },
				timestamp: new Date(1790000000000 + i).toISOString(),
			}),
		);
	}
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** Windows 独占锁：FileShare.None 让其它进程的读取立刻失败（模拟杀毒/索引器短暂占用会话文件）。 */
function holdExclusiveLock(path: string, seconds: number) {
	const escaped = path.replace(/\\/g, "\\\\").replace(/'/g, "''");
	const child = spawn(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			`$f=[System.IO.File]::Open('${escaped}','Open','Read','None'); Start-Sleep -Seconds ${seconds}; $f.Close()`,
		],
		{ stdio: "ignore" },
	);
	return child;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

describe("session list resilience", () => {
	it(
		"keeps a session in listAll while its file is briefly unreadable (falls back to the last good parse)",
		{ timeout: 20000 },
		async () => {
			if (process.platform !== "win32") return;
			const dir = join(tmpdir(), `owl-list-resilience-${Date.now()}`);
			mkdirSync(dir, { recursive: true });
			try {
				const target = writeSession(
					dir,
					"2026-10-20T00-00-00-000Z_a0000001-0001-0001-0001-000000000001.jsonl",
					"a0000001-0001-0001-0001-000000000001",
					3,
				);
				writeSession(
					dir,
					"2026-10-20T00-00-00-000Z_a0000002-0002-0002-0002-000000000002.jsonl",
					"a0000002-0002-0002-0002-000000000002",
					1,
				);

				const first = await SessionManager.listAll(dir);
				expect(first.map((row) => row.id)).toContain("a0000001-0001-0001-0001-000000000001");

				const locker = holdExclusiveLock(target, 8);
				try {
					const locked = await waitFor(() => {
						try {
							readFileSync(target, "utf8");
							return false;
						} catch {
							return true;
						}
					}, 4000);
					if (!locked) return; // 锁未生效（环境差异）：跳过断言

					const second = await SessionManager.listAll(dir);
					// 读取瞬时失败时不能把会话从列表里丢掉：侧栏会整行消失一帧（闪屏）。
					expect(second.map((row) => row.id)).toContain("a0000001-0001-0001-0001-000000000001");
				} finally {
					locker.kill();
					await waitFor(() => {
						try {
							readFileSync(target, "utf8");
							return true;
						} catch {
							return false;
						}
					}, 5000);
				}
			} finally {
				// 锁释放前目录可能仍被占用：重试删除，失败不掩盖测试结论。
				for (let attempt = 0; attempt < 10; attempt++) {
					try {
						rmSync(dir, { recursive: true, force: true });
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 200));
					}
				}
			}
		},
	);
});
