/**
 * 终端 tab —— node-pty + xterm.js（懒加载 chunk，xterm 不进首屏）。
 *
 * 对应 dsh-better-sidebar 的终端页在 owl 的分工：pty 由本地桥宿主持有
 * （terminals.ts），前端只负责渲染与输入。生命周期：挂载即 term.create，
 * 卸载 / 终端退出时 kill；StrictMode 双挂载靠 disposed 标记保证不多留孤儿
 * 会话。容器尺寸变化经 ResizeObserver → fit addon → term.resize 同步行列。
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TabComponentProps } from "../registry.ts";

/** owl 深色 token（与 index.css 的 --color-owl-* 同源，xterm 需要字面量）。 */
const XTERM_THEME = {
	background: "#1a1918",
	foreground: "#e9e7e0",
	cursor: "#2f9e5a",
	cursorAccent: "#1a1918",
	selectionBackground: "#2f9e5a55",
};

type Status = "connecting" | "ready" | "exited" | "error";

export function TerminalTab({ client, cwd }: TabComponentProps): React.JSX.Element {
	const host = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<Status>("connecting");
	const [error, setError] = useState("");
	const [nonce, setNonce] = useState(0); // 重启：换代重跑整个 effect
	const [shellLabel, setShellLabel] = useState("");

	useEffect(() => {
		const el = host.current;
		if (!el) return;
		setStatus("connecting");
		setError("");
		let disposed = false;
		let termId: string | undefined;
		let alive = false;
		let lastCols = 0;
		let lastRows = 0;

		const term = new Terminal({
			fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
			fontSize: 12,
			lineHeight: 1.15,
			cursorBlink: true,
			scrollback: 4000,
			theme: XTERM_THEME,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		try {
			fit.fit();
		} catch {
			// 容器还没布局完（隐藏停靠时 0 尺寸）：展开后再由 ResizeObserver 触发
		}
		term.onData((data) => {
			if (alive && termId) void client.request({ type: "term.input", termId, data }).catch(() => {});
		});

		const offTerm = client.onTermMessage((message) => {
			if (message.termId !== termId) return;
			if (message.type === "term.data") {
				term.write(message.data);
				return;
			}
			alive = false;
			setStatus("exited");
			term.write(`\r\n\x1b[2m[进程已退出${message.exitCode ? `，代码 ${message.exitCode}` : ""} —— 点右上角重新启动]\x1b[0m\r\n`);
		});

		void (async () => {
			try {
				const response = await client.request<{ termId: string; shell: string }>({
					type: "term.create",
					cwd,
					cols: term.cols,
					rows: term.rows,
				});
				if (disposed) {
					// StrictMode 双挂载：先建的后拆，把刚开的 pty 收掉
					if (response.ok && response.result) {
						void client.request({ type: "term.kill", termId: response.result.termId }).catch(() => {});
					}
					return;
				}
				if (!response.ok || !response.result) {
					setStatus("error");
					setError(response.error ?? "未知错误");
					return;
				}
				termId = response.result.termId;
				setShellLabel(response.result.shell);
				alive = true;
				lastCols = term.cols;
				lastRows = term.rows;
				setStatus("ready");
				term.focus();
			} catch (err) {
				if (!disposed) {
					setStatus("error");
					setError(err instanceof Error ? err.message : String(err));
				}
			}
		})();

		const observer = new ResizeObserver(() => {
			try {
				fit.fit();
			} catch {
				return;
			}
			// 行列真的变了才发（fit 在展开停靠时从 0 尺寸恢复也会触发一轮）
			if (termId && alive && (term.cols !== lastCols || term.rows !== lastRows)) {
				lastCols = term.cols;
				lastRows = term.rows;
				void client.request({ type: "term.resize", termId, cols: term.cols, rows: term.rows }).catch(() => {});
			}
		});
		observer.observe(el);

		return () => {
			disposed = true;
			alive = false;
			offTerm();
			observer.disconnect();
			if (termId) void client.request({ type: "term.kill", termId }).catch(() => {});
			term.dispose();
		};
	}, [client, cwd, nonce]);

	const badge =
		status === "ready" ? (
			<span className="text-owl-faint">{shellLabel}</span>
		) : status === "connecting" ? (
			<span className="text-owl-faint">正在启动 shell…</span>
		) : status === "exited" ? (
			<button
				type="button"
				className="rounded border border-owl-border px-1.5 py-0.5 text-[10px] text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
				onClick={() => setNonce((n) => n + 1)}
			>
				重新启动
			</button>
		) : (
			<span className="truncate text-red-400" title={error}>
				启动失败：{error}
			</span>
		);

	return (
		<div className="flex h-full flex-col overflow-hidden bg-owl-rail">
			<div className="flex shrink-0 select-none items-center gap-2 border-b border-owl-border/40 px-2.5 py-1 text-[10px] text-owl-faint">
				<span className="font-mono">{cwd}</span>
				<span className="ml-auto">{badge}</span>
			</div>
			<div ref={host} className="min-h-0 flex-1 px-1.5 py-1" />
		</div>
	);
}
