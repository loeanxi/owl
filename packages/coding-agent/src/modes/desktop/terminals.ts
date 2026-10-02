/**
 * 桥侧终端管理器 —— node-pty 会话表（一个终端 tab = 一个会话）。
 *
 * 对应 dsh-better-sidebar 把终端交还宿主的分工：owl 的宿主就是本地桥进程，
 * 这里直接持有 pty。会话按创建它的 WebSocket 归属（serve.ts 记账），连接断开
 * 时兜底回收；进程自己退出时从表里摘除并回调。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn as ptySpawn, type IPty } from "node-pty";

interface ShellSpec {
	file: string;
	args: string[];
	label: string;
}

/** 按平台挑默认 shell：Windows 用 PowerShell（ConPTY），*nix 用登录 shell。 */
function pickShell(): ShellSpec {
	if (process.platform === "win32") {
		return { file: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" };
	}
	const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
	return { file: shell, args: process.platform === "darwin" ? ["-l"] : [], label: shell.split("/").pop() ?? shell };
}

export class TerminalManager {
	private terms = new Map<string, IPty>();

	create(
		cwd: string,
		cols: number,
		rows: number,
		hooks: { onData: (termId: string, data: string) => void; onExit: (termId: string, exitCode: number | undefined) => void },
	): { termId: string; shell: string } {
		const shell = pickShell();
		const termId = `term-${randomUUID()}`;
		const pty = ptySpawn(shell.file, shell.args, {
			name: "xterm-256color",
			cols: Math.min(Math.max(Math.floor(cols) || 80, 2), 500),
			rows: Math.min(Math.max(Math.floor(rows) || 24, 2), 300),
			cwd: existsSync(cwd) ? cwd : undefined,
			env: process.env as Record<string, string>,
		});
		this.terms.set(termId, pty);
		pty.onData((data) => hooks.onData(termId, data));
		pty.onExit(({ exitCode }) => {
			if (this.terms.get(termId) === pty) this.terms.delete(termId);
			hooks.onExit(termId, exitCode);
		});
		return { termId, shell: shell.label };
	}

	write(termId: string, data: string): void {
		this.terms.get(termId)?.write(data);
	}

	resize(termId: string, cols: number, rows: number): void {
		try {
			this.terms.get(termId)?.resize(Math.min(Math.max(Math.floor(cols) || 80, 2), 500), Math.min(Math.max(Math.floor(rows) || 24, 2), 300));
		} catch {
			// 行列非法或进程正在退出：忽略，下一轮 resize 会再校
		}
	}

	kill(termId: string): void {
		const pty = this.terms.get(termId);
		if (!pty) return;
		this.terms.delete(termId);
		try {
			pty.kill();
		} catch {
			// 进程已退出：表里摘除即可
		}
	}

	/** 服务关闭时全量回收（不留孤儿 shell）。 */
	killAll(): void {
		for (const termId of [...this.terms.keys()]) this.kill(termId);
	}

	get size(): number {
		return this.terms.size;
	}
}
