import { useEffect, useRef } from "react";
import MarkdownIt from "markdown-it";
import type { ChatEntry } from "../hooks/transcript.ts";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderMarkdown(text: string): string {
	return md.render(text);
}

function AssistantEntry({ entry }: { entry: Extract<ChatEntry, { kind: "assistant" }> }): React.JSX.Element {
	return (
		<div className="max-w-3xl space-y-2">
			{entry.thinking && (
				<details className="rounded-lg border border-owl-border bg-owl-sidebar/70 px-3 py-2 text-xs text-owl-faint">
					<summary className="cursor-pointer">思考过程</summary>
					<pre className="mt-2 whitespace-pre-wrap">{entry.thinking}</pre>
				</details>
			)}
			{entry.text && (
				<div
					className="space-y-2 font-serif leading-relaxed [&_code]:rounded [&_code]:bg-owl-sidebar [&_code]:px-1 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-owl-border [&_pre]:bg-owl-sidebar [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs"
					// markdown-it with html:false escapes raw HTML; tool content is data, not markup
					dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
				/>
			)}
			{entry.tools.map((tool) => (
				<div key={tool.id} className="rounded-lg border border-owl-border bg-owl-sidebar/70 p-2 text-xs">
					<div className="flex items-center gap-2">
						<span className="font-mono text-owl-accent">{tool.name}</span>
						<span className={tool.status === "running" ? "text-owl-accent" : "text-owl-faint"}>
							{tool.status === "running" ? "运行中…" : "已完成"}
						</span>
					</div>
					{tool.args && (
						<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-owl-muted">{tool.args}</pre>
					)}
				</div>
			))}
			{entry.error && <div className="text-xs text-red-400">{entry.error}</div>}
		</div>
	);
}

export function ChatStream({ entries }: { entries: ChatEntry[] }): React.JSX.Element {
	const container = useRef<HTMLElement>(null);
	// 跟随新内容滚动的开关。用户的向上滚动意图（滚轮/触控板/拖滚动条/翻页键）立即关闭，
	// 只有视口真正回到贴底位置才重新打开——流式输出期间翻历史不会被拽回底部。
	const stick = useRef(true);
	const prevEntries = useRef<ChatEntry[]>([]);

	const onWheel = (event: React.WheelEvent<HTMLElement>): void => {
		// 向上滚（deltaY<0）是明确的用户意图，先于滚动发生：直接停跟随。
		// 触控板/高精度滚轮单次位移很小，靠位移阈值判断会漏，必须在 wheel 上拦。
		if (event.deltaY < 0) stick.current = false;
	};

	const onScroll = (): void => {
		const el = container.current;
		if (!el) return;
		// 离开底部（任何手段：滚动条拖动、键盘、触摸）即停跟随；回到贴底（<4px）才恢复。
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
	};

	useEffect(() => {
		const last = entries[entries.length - 1];
		const prevLast = prevEntries.current[prevEntries.current.length - 1];
		const userJustSent = last?.kind === "user" && last !== prevLast;
		prevEntries.current = entries;
		if (!stick.current && !userJustSent) return;
		// 直接设 scrollTop：瞬时定位，不与用户滚动抢平滑动画队列。
		const el = container.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [entries]);

	return (
		<main
			ref={container}
			onWheel={onWheel}
			onScroll={onScroll}
			className="flex-1 space-y-5 overflow-y-auto px-6 py-5"
		>
			{entries.length === 0 && (
				<div className="mt-[22vh] flex flex-col items-center">
					<img src="/owl.svg" alt="" className="h-12 w-12 opacity-90" />
					<p className="mt-5 font-serif text-2xl text-owl-text">✳ 有什么可以帮你的？</p>
					<p className="mt-2 text-sm text-owl-faint">比 pi 更轻的 coding agent · 发消息开始</p>
				</div>
			)}
			{entries.map((entry, index) => {
				if (entry.kind === "user") {
					return (
						<div key={index} className="flex justify-end">
							<div className="max-w-3xl rounded-2xl bg-owl-bubble px-4 py-2.5 text-sm whitespace-pre-wrap">
								{entry.text}
							</div>
						</div>
					);
				}
				if (entry.kind === "assistant") {
					return <AssistantEntry key={index} entry={entry} />;
				}
				return (
					<div key={index} className="max-w-3xl rounded-lg border border-owl-border/60 px-3 py-1.5 font-mono text-xs text-owl-faint">
						<span className={entry.ok ? "text-emerald-600" : "text-red-500"}>{entry.toolName}</span> {entry.brief}
					</div>
				);
			})}
		</main>
	);
}
