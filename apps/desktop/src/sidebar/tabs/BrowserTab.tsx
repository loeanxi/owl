/**
 * 浏览器 tab —— 内嵌预览 + 外部打开兜底。
 *
 * 对应 DSH 由宿主桌面提供的浏览器视图，owl 的自制版本走 iframe：适合
 * localhost 开发服务器、文档站等可内嵌页面；主流站点多数带 X-Frame-Options
 * 拒绝内嵌（跨域下无法程序化探测），所以工具条常驻「外部打开」。URL 记在
 * tab.path 上，随分屏树按项目持久化，重开应用还原。
 */
import { useRef, useState } from "react";
import type { TabComponentProps } from "../registry.ts";
import { IconExternal, IconRefresh } from "../icons.tsx";

/** 起始页的快捷目标（开发预览是浏览器 tab 的主场景）。 */
const QUICK_URLS = ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:8080", "http://127.0.0.1:8787"];

/** 归一化输入：补协议、localhost 容错，空串返回空。 */
function normalizeUrl(raw: string): string {
	const text = raw.trim();
	if (!text) return "";
	if (/^https?:\/\//i.test(text)) return text;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?/i.test(text)) return `http://${text}`;
	return `https://${text}`;
}

function isProbablyIframable(url: string): boolean {
	return /^https?:\/\//i.test(url) && !/\/\/(github\.com|google\.com|www\.google\.com)\//i.test(url);
}

export function BrowserTab({ api, tab, store }: TabComponentProps): React.JSX.Element {
	// URL 持久化在 tab.path（store.setTabPath 落盘）；空 = 起始页
	const [url, setUrl] = useState(tab.path ?? "");
	const [draft, setDraft] = useState(tab.path ?? "");
	const [stack, setStack] = useState<string[]>(tab.path ? [tab.path] : []);
	const [cursor, setCursor] = useState(tab.path ? 0 : -1);
	const [reloadKey, setReloadKey] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	const navigate = (raw: string): void => {
		const next = normalizeUrl(raw);
		setUrl(next);
		setDraft(next);
		if (!next) {
			store.setTabPath(tab.id, undefined);
			return;
		}
		store.setTabPath(tab.id, next);
		setStack((current) => {
			const trimmed = current.slice(0, cursor + 1);
			if (trimmed[trimmed.length - 1] === next) return trimmed;
			const merged = [...trimmed, next];
			setCursor(merged.length - 1);
			return merged;
		});
		setReloadKey((key) => key + 1);
	};

	const jump = (delta: number): void => {
		const next = Math.min(Math.max(cursor + delta, 0), stack.length - 1);
		if (next === cursor) return;
		setCursor(next);
		setUrl(stack[next] ?? "");
		setDraft(stack[next] ?? "");
		store.setTabPath(tab.id, stack[next]);
		setReloadKey((key) => key + 1);
	};

	const openExternal = (): void => {
		if (url) void api.openExternal("url", url).catch(() => {});
	};

	const toolbarButton =
		"flex h-6 w-6 items-center justify-center rounded text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

	return (
		<div className="flex h-full flex-col overflow-hidden bg-owl-bg">
			{/* 工具条：后退 / 前进 / 刷新 / 地址栏 / 外部打开 */}
			<div className="flex shrink-0 select-none items-center gap-1.5 border-b border-owl-border/40 px-2 py-1.5">
				<button type="button" title="后退" className={toolbarButton} disabled={cursor <= 0} onClick={() => jump(-1)}>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-3 w-3">
						<path d="M10 3 5 8l5 5" />
					</svg>
				</button>
				<button type="button" title="前进" className={toolbarButton} disabled={cursor >= stack.length - 1} onClick={() => jump(1)}>
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-3 w-3">
						<path d="m6 3 5 5-5 5" />
					</svg>
				</button>
				<button
					type="button"
					title="刷新"
					className={toolbarButton}
					disabled={!url}
					onClick={() => setReloadKey((key) => key + 1)}
				>
					<IconRefresh size={11} />
				</button>
				<input
					value={draft}
					placeholder="输入 URL（localhost 开发服务器、可内嵌站点）"
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							navigate(draft);
							inputRef.current?.blur();
						}
					}}
					className="h-6.5 min-w-0 flex-1 rounded-md border border-owl-border/50 bg-owl-panel px-2.5 text-xs text-owl-text outline-none placeholder:text-owl-faint focus:border-owl-accent/60"
				/>
				<button type="button" title="在系统浏览器打开" className={toolbarButton} disabled={!url} onClick={openExternal}>
					<IconExternal size={11} />
				</button>
			</div>

			{/* 内容：空 URL = 起始页；否则 iframe（key 换代实现硬刷新） */}
			{!url ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
					<p className="text-sm text-owl-muted">内嵌预览</p>
					<p className="max-w-sm text-xs leading-relaxed text-owl-faint">
						适合 localhost 开发服务器和允许内嵌的站点。主流网站（GitHub、Google
						等）拒绝被嵌入，输完地址点右侧图标即可在系统浏览器打开。
					</p>
					<div className="mt-1 flex flex-wrap justify-center gap-2">
						{QUICK_URLS.map((candidate) => (
							<button
								key={candidate}
								type="button"
								className="rounded-lg border border-owl-border/60 bg-owl-panel px-3 py-1.5 font-mono text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
								onClick={() => navigate(candidate)}
							>
								{candidate}
							</button>
						))}
					</div>
				</div>
			) : (
				<div className="relative min-h-0 flex-1">
					<iframe
						key={reloadKey}
						src={url}
						title="浏览器预览"
						className="h-full w-full border-0 bg-white"
						referrerPolicy="no-referrer"
					/>
					{!isProbablyIframable(url) && (
						<div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
							<span className="pointer-events-auto flex items-center gap-2 rounded-full border border-owl-border/60 bg-owl-panel/95 px-3 py-1 text-[10px] text-owl-faint shadow">
								该站点可能禁止内嵌
								<button type="button" className="flex items-center gap-1 text-owl-accent transition-colors hover:text-owl-accent-hover" onClick={openExternal}>
									外部打开
								</button>
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
