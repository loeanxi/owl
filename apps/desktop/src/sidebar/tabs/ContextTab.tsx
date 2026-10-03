/**
 * 上下文卡片 —— 当前会话每次 LLM 请求的上下文构成与趋势。
 * 数据由插件 owl-context（settings plugins）在请求组装点现采，经桥
 * context.get（core/context-insight 注册表）供数；这里 2s 轮询保活。
 * 对照 dsh-context 的会话内视图裁剪出四块：当前构成堆叠条、每请求
 * 趋势（压缩分界线）、事件流、声明工具的来源分组。
 */
import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ContextEventRow, ContextRequestRow, ContextToolRef } from "../../bridge/protocol.ts";
import type { TabComponentProps } from "../registry.ts";
import { IconLoader } from "../icons.tsx";

const CATEGORIES = [
	{ key: "system", label: "系统提示", color: "#4d9fd8" },
	{ key: "inject", label: "注入内容", color: "#c77dff" },
	{ key: "user", label: "用户", color: "#e0a33e" },
	{ key: "assistant", label: "回复", color: "#41c463" },
	{ key: "toolResult", label: "工具结果", color: "#f0883e" },
	{ key: "toolSchemas", label: "工具 Schema", color: "#5cc8d7" },
	{ key: "other", label: "其他", color: "#8b949e" },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]["key"];
type Composition = Record<CategoryKey, number>;

interface InsightData {
	sessionId?: string;
	requests: ContextRequestRow[];
	events: ContextEventRow[];
	tools: ContextToolRef[];
}

const EMPTY: InsightData = { requests: [], events: [], tools: [] };

function fmtTokens(n: number | undefined): string {
	if (n === undefined) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

function fmtTime(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function compositionOf(row: ContextRequestRow): Composition {
	return {
		system: row.composition.system ?? 0,
		inject: row.composition.inject ?? 0,
		user: row.composition.user ?? 0,
		assistant: row.composition.assistant ?? 0,
		toolResult: row.composition.toolResult ?? 0,
		toolSchemas: row.composition.toolSchemas ?? 0,
		other: row.composition.other ?? 0,
	};
}

/** 构成堆叠条 + 图例。 */
function CompositionBar({ row }: { row: ContextRequestRow }): React.JSX.Element {
	const composition = compositionOf(row);
	const total = row.totalTokens || Object.values(composition).reduce((sum, value) => sum + value, 0);
	const segments = CATEGORIES.map((category) => ({ ...category, tokens: composition[category.key] })).filter(
		(segment) => segment.tokens > 0,
	);
	return (
		<div className="space-y-2">
			<div className="flex h-3 w-full overflow-hidden rounded-full bg-owl-hover">
				{segments.map((segment) => (
					<div
						key={segment.key}
						className="h-full"
						style={{ width: `${(segment.tokens / total) * 100}%`, backgroundColor: segment.color }}
						title={`${segment.label} ${fmtTokens(segment.tokens)}（${((segment.tokens / total) * 100).toFixed(1)}%）`}
					/>
				))}
			</div>
			<div className="grid grid-cols-2 gap-x-3 gap-y-1">
				{CATEGORIES.map((category) => (
					<div key={category.key} className="flex items-center gap-1.5 text-[11px]">
						<span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: category.color }} />
						<span className="text-owl-muted">{category.label}</span>
						<span className="ml-auto font-mono text-owl-text">{fmtTokens(composition[category.key])}</span>
					</div>
				))}
			</div>
		</div>
	);
}

/** 每请求趋势：堆叠柱 + 压缩分界线。宽度自适应（viewBox 拉伸，只用矩形）。 */
function TrendChart({ requests, events }: { requests: ContextRequestRow[]; events: ContextEventRow[] }): React.JSX.Element {
	const W = 600;
	const H = 110;
	const trend = useMemo(() => requests.slice(-48), [requests]);
	const compacts = useMemo(() => events.filter((event) => event.kind === "compact"), [events]);
	const max = Math.max(...trend.map((row) => row.totalTokens), 1);
	const barW = W / Math.max(trend.length, 1);
	return (
		<div>
			<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-24 w-full" aria-hidden="true">
				{trend.map((row, index) => {
					const composition = compositionOf(row);
					let y = H;
					const x = index * barW;
					const width = Math.max(barW - (barW > 4 ? 1 : 0.2), 0.5);
					return (
						<g key={row.seq}>
							{CATEGORIES.map((category) => {
								const height = (composition[category.key] / max) * H;
								if (height <= 0) return null;
								y -= height;
								return <rect key={category.key} x={x} y={y} width={width} height={height} fill={category.color} />;
							})}
							<rect x={x} y={0} width={width} height={H} fill="transparent" className="cursor-help">
								<title>{`#${row.seq} · ${fmtTime(row.ts)}\n总计 ${fmtTokens(row.totalTokens)} tok${
									row.usage ? `\n计费输入 ${fmtTokens(row.usage.input)}（缓存读 ${fmtTokens(row.usage.cacheRead)}）` : ""
								}`}</title>
							</rect>
						</g>
					);
				})}
				{compacts.map((event) => {
					const index = trend.findIndex((row) => row.ts >= event.ts);
					if (index < 0) return null;
					return (
						<line
							key={event.ts}
							x1={index * barW + barW / 2}
							x2={index * barW + barW / 2}
							y1={0}
							y2={H}
							stroke="#e5534b"
							strokeWidth={1.4}
							strokeDasharray="4 3"
						/>
					);
				})}
			</svg>
			{compacts.length > 0 && (
				<p className="mt-1 text-[10px] text-owl-faint">
					<span className="mr-1 inline-block h-2 w-3 border-t-2 border-dashed border-[#e5534b] align-middle" />
					压缩分界（{compacts.length} 次）
				</p>
			)}
		</div>
	);
}

export function ContextTab({ client, cwd }: TabComponentProps): React.JSX.Element {
	const [data, setData] = useState<InsightData>(EMPTY);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		let alive = true;
		const fetchOnce = async (): Promise<void> => {
			try {
				const response = await client.request<InsightData>({ type: "context.get", cwd });
				if (!alive) return;
				if (response.ok && response.result) {
					setData(response.result);
					setError(undefined);
				} else {
					setError(response.error ?? "context.get 失败");
				}
			} catch (err) {
				if (alive) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void fetchOnce();
		const timer = setInterval(() => void fetchOnce(), 2000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [client, cwd]);

	const latest = data.requests[data.requests.length - 1];
	const usage = latest?.usage;
	const percent = latest?.contextWindow ? (latest.totalTokens / latest.contextWindow) * 100 : undefined;
	const toolGroups = useMemo(() => {
		const groups = new Map<string, string[]>();
		for (const tool of data.tools) {
			const names = groups.get(tool.source) ?? [];
			names.push(tool.name);
			groups.set(tool.source, names);
		}
		return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
	}, [data.tools]);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* 状态头 */}
			<div className="flex shrink-0 items-center gap-2 border-b border-owl-border/40 px-3 py-2 text-xs">
				<span className="font-medium text-owl-text">上下文</span>
				{latest ? (
					<span className="text-owl-faint">
						{fmtTokens(latest.totalTokens)} tok
						{latest.contextWindow ? ` / ${fmtTokens(latest.contextWindow)}（${percent?.toFixed(1)}%）` : ""}
					</span>
				) : (
					<span className="text-owl-faint">暂无请求</span>
				)}
				{latest?.model && (
					<span className="ml-auto max-w-40 truncate text-owl-faint" title={`${latest.model.provider}/${latest.model.id}`}>
						{latest.model.id}
					</span>
				)}
			</div>

			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
				{error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">{error}</p>}

				{!latest ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-center">
						<span className="text-2xl opacity-50">🫧</span>
						<p className="text-xs text-owl-faint">
							当前会话还没有上下文记录。
							<br />
							发一条消息后，这里会展示请求的构成与趋势。
						</p>
					</div>
				) : (
					<>
						{/* 当前构成 */}
						<section>
							<h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-owl-faint">
								当前构成 · #{latest.seq} · {fmtTime(latest.ts)}
							</h3>
							<CompositionBar row={latest} />
							{usage && (
								<p className="mt-2 text-[11px] text-owl-faint">
									计费：输入 {fmtTokens(usage.input)}（缓存读 {fmtTokens(usage.cacheRead)} · 写 {fmtTokens(usage.cacheWrite)}）· 输出{" "}
									{fmtTokens(usage.output)}
								</p>
							)}
						</section>

						{/* 趋势 */}
						{data.requests.length > 1 && (
							<section>
								<h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-owl-faint">
									趋势 · 最近 {Math.min(data.requests.length, 48)} 次请求
								</h3>
								<TrendChart requests={data.requests} events={data.events} />
							</section>
						)}

						{/* 事件 */}
						{data.events.length > 0 && (
							<section>
								<h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-owl-faint">上下文事件</h3>
								<ol className="space-y-1">
									{[...data.events]
										.reverse()
										.slice(0, 12)
										.map((event) => (
											<li key={event.ts} className="flex items-center gap-2 text-[11px]">
												<span className="font-mono text-owl-faint">{fmtTime(event.ts)}</span>
												<span className={event.kind === "compact" ? "text-[#e5534b]" : "text-owl-muted"}>{event.label}</span>
											</li>
										))}
								</ol>
							</section>
						)}

						{/* 声明的工具（来源分组） */}
						{toolGroups.length > 0 && (
							<section>
								<h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-owl-faint">
									声明工具 · {data.tools.length} 个
								</h3>
								<div className="flex flex-wrap gap-1.5">
									{toolGroups.map(([source, names]) => (
										<span
											key={source}
											className="rounded-full border border-owl-border/40 bg-owl-panel/60 px-2 py-0.5 text-[11px] text-owl-muted"
											title={names.join("\n")}
										>
											{source} · {names.length}
										</span>
									))}
								</div>
							</section>
						)}
					</>
				)}
			</div>

			{latest && (
				<div className="flex shrink-0 items-center gap-1.5 border-t border-owl-border/40 px-3 py-1.5 text-[10px] text-owl-faint">
					<IconLoader size={10} className="text-owl-faint" />
					2s 轮询 · {data.requests.length} 条请求记录
				</div>
			)}
		</div>
	);
}
