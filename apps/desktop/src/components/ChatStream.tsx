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
				<details className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-500">
					<summary className="cursor-pointer">思考过程</summary>
					<pre className="mt-2 whitespace-pre-wrap">{entry.thinking}</pre>
				</details>
			)}
			{entry.text && (
				<div
					className="space-y-2 [&_code]:rounded [&_code]:bg-neutral-800 [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-neutral-900 [&_pre]:p-3 [&_pre]:text-xs"
					// markdown-it with html:false escapes raw HTML; tool content is data, not markup
					dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
				/>
			)}
			{entry.tools.map((tool) => (
				<div key={tool.id} className="rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs">
					<div className="flex items-center gap-2">
						<span className="font-mono text-amber-400">{tool.name}</span>
						<span className={tool.status === "running" ? "text-sky-400" : "text-neutral-600"}>
							{tool.status === "running" ? "运行中…" : "已完成"}
						</span>
					</div>
					{tool.args && (
						<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-neutral-400">{tool.args}</pre>
					)}
				</div>
			))}
			{entry.error && <div className="text-xs text-red-400">{entry.error}</div>}
		</div>
	);
}

export function ChatStream({ entries }: { entries: ChatEntry[] }): React.JSX.Element {
	const bottom = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bottom.current?.scrollIntoView({ behavior: "smooth" });
	}, [entries]);
	return (
		<main className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
			{entries.length === 0 && (
				<div className="mt-24 text-center text-neutral-600">
					<p className="text-lg">pire</p>
					<p className="mt-1 text-sm">比 pi 更轻的 coding agent · 发消息开始</p>
				</div>
			)}
			{entries.map((entry, index) => {
				if (entry.kind === "user") {
					return (
						<div key={index} className="flex justify-end">
							<div className="max-w-3xl rounded-lg bg-sky-900/40 px-4 py-2 whitespace-pre-wrap">
								{entry.text}
							</div>
						</div>
					);
				}
				if (entry.kind === "assistant") {
					return <AssistantEntry key={index} entry={entry} />;
				}
				return (
					<div key={index} className="max-w-3xl rounded border border-neutral-800/60 px-3 py-1.5 font-mono text-xs text-neutral-500">
						<span className={entry.ok ? "text-emerald-600" : "text-red-500"}>{entry.toolName}</span> {entry.brief}
					</div>
				);
			})}
			<div ref={bottom} />
		</main>
	);
}
