/**
 * 上下文视图 —— 当前会话每次 LLM 请求的上下文构成与趋势，占据主对话区
 * （顶栏「对话/上下文」tab 切换，见 App.tsx 的 conversationView）。
 * 数据由插件 owl-context（settings plugins）在请求组装点现采，经桥
 * context.get（core/context-insight 注册表）供数；这里 2s 轮询保活。
 * 对照 dsh-context 的会话内视图：当前构成堆叠条、每请求趋势（压缩分界线）、
 * 事件流、声明工具的来源分组。
 */
import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ContextEventRow, ContextRequestRow, ContextToolRef } from "../bridge/protocol.ts";

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
	/** 本数据是按会话转录重建的（历史会话兜底），不是插件现采。 */
	reconstructed?: boolean;
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
			<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full" aria-hidden="true">
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
								<title>{`#${row.seq} · ${fmtTime(row.ts)}\n估算 ${fmtTokens(row.totalTokens)} tok${
									row.usage
										? `\n实测 ${fmtTokens(
												row.usage.totalTokens ||
													row.usage.input + row.usage.output + row.usage.cacheRead + row.usage.cacheWrite,
											)} tok（计费输入 ${fmtTokens(row.usage.input)} · 缓存读 ${fmtTokens(row.usage.cacheRead)}）`
										: ""
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

export function ContextView({ client, cwd, sessionId, requireSession = false, active = true }: {
	client: BridgeClient;
	cwd: string;
	sessionId?: string;
	/** Empty conversations must not fall back to another session in the same project. */
	requireSession?: boolean;
	active?: boolean;
}): React.JSX.Element {
	const [data, setData] = useState<InsightData>(EMPTY);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		setData(EMPTY);
		setError(undefined);
		if (!active || (requireSession && !sessionId)) return;
		let alive = true;
		const fetchOnce = async (): Promise<void> => {
			try {
				const response = await client.request<InsightData>({ type: "context.get", cwd, ...(sessionId ? { sessionId } : {}) });
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
	}, [client, cwd, sessionId, requireSession, active]);

	const latest = data.requests[data.requests.length - 1];
	const composition = latest ? compositionOf(latest) : undefined;
	const total = latest?.totalTokens ?? 0;
	// 双口径：实测（provider 计费，与输入栏状态一致）优先；估算（chars/4，对中文
	// 明显偏低）只做构成占比参考。实测要等响应回来才有——之前只显示估算。
	const measured = latest?.usage
		? latest.usage.totalTokens ||
			latest.usage.input + latest.usage.output + latest.usage.cacheRead + latest.usage.cacheWrite
		: undefined;
	const headline = measured ?? total;
	const percent = latest?.contextWindow ? (headline / latest.contextWindow) * 100 : undefined;
	const usage = latest?.usage;
	const toolGroups = useMemo(() => {
		const groups = new Map<string, string[]>();
		for (const tool of data.tools) {
			const names = groups.get(tool.source) ?? [];
			names.push(tool.name);
			groups.set(tool.source, names);
		}
		return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
	}, [data.tools]);

	if (!latest) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto text-center">
				<span className="text-4xl opacity-40">🫧</span>
				<p className="text-sm text-owl-faint">
					当前会话还没有上下文记录。
					<br />
					发一条消息后，这里会展示每次请求的构成与趋势。
				</p>
				{error && <p className="max-w-md text-[11px] text-red-400">{error}</p>}
			</div>
		);
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
			{error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{error}</p>}

			{/* 总览条 */}
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<span className="text-2xl font-semibold text-owl-text">
					{fmtTokens(headline)}
					<span className="ml-1 text-xs font-normal text-owl-faint">tok</span>
					<span
						className={`ml-1.5 rounded px-1 py-0.5 align-middle text-[10px] font-normal ${
							measured !== undefined ? "bg-emerald-500/15 text-emerald-400" : "bg-owl-hover text-owl-faint"
						}`}
						title={measured !== undefined ? "provider 实测计费，与输入栏状态一致" : "chars/4 估算，等响应回来后显示实测值"}
					>
						{measured !== undefined ? "实测" : "估算"}
					</span>
				</span>
				{measured !== undefined && Math.abs(measured - total) > 500 && (
					<span className="text-xs text-owl-faint" title="chars/4 估算对中文/JSON 明显偏低，构成占比仍可参考">
						估算构成 {fmtTokens(total)}
					</span>
				)}
				{latest.contextWindow && (
					<span className="text-xs text-owl-faint">
						上下文窗口 {fmtTokens(latest.contextWindow)} · 已用 {percent?.toFixed(1)}%
					</span>
				)}
				{latest.model && (
					<span className="text-xs text-owl-faint" title={`${latest.model.provider}/${latest.model.id}`}>
						{latest.model.id}
					</span>
				)}
				<span className="text-xs text-owl-faint">
					#{latest.seq} · {fmtTime(latest.ts)}
				</span>
				{data.reconstructed && (
					<span
						className="rounded bg-owl-hover px-1 py-0.5 align-middle text-[10px] text-owl-faint"
						title="本进程还没有该会话的实采数据：构成与趋势按会话转录回放估算（工具 schema 未计入），发一条消息后转为插件现采"
					>
						历史重建
					</span>
				)}
				{usage && (
					<span className="ml-auto text-xs text-owl-faint">
						计费：输入 {fmtTokens(usage.input)}（缓存读 {fmtTokens(usage.cacheRead)} · 写 {fmtTokens(usage.cacheWrite)}）· 输出 {fmtTokens(usage.output)}
					</span>
				)}
			</div>

			{/* 当前构成：堆叠条 + 图例（估算口径） */}
			<section className="mt-4">
				<div className="flex h-3.5 w-full overflow-hidden rounded-full bg-owl-hover">
					{CATEGORIES.map((category) => {
						const tokens = composition?.[category.key] ?? 0;
						if (tokens <= 0) return null;
						return (
							<div
								key={category.key}
								className="h-full"
								style={{ width: `${(tokens / total) * 100}%`, backgroundColor: category.color }}
								title={`${category.label} ${fmtTokens(tokens)}（${((tokens / total) * 100).toFixed(1)}%）`}
							/>
						);
					})}
				</div>
				<div className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4">
					{CATEGORIES.map((category) => (
						<div key={category.key} className="flex items-center gap-2 text-xs">
							<span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: category.color }} />
							<span className="text-owl-muted">{category.label}</span>
							<span className="ml-auto font-mono text-owl-text">{fmtTokens(composition?.[category.key])}</span>
						</div>
					))}
				</div>
			</section>

			{/* 趋势 + 事件 双列 */}
			<div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
				{data.requests.length > 1 && (
					<section>
						<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-owl-faint">
							趋势 · 最近 {Math.min(data.requests.length, 48)} 次请求
						</h3>
						<TrendChart requests={data.requests} events={data.events} />
					</section>
				)}
				{data.events.length > 0 && (
					<section>
						<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-owl-faint">上下文事件</h3>
						<ol className="space-y-1">
							{[...data.events]
								.reverse()
								.slice(0, 14)
								.map((event) => (
									<li key={event.ts} className="flex items-center gap-2 text-xs">
										<span className="font-mono text-owl-faint">{fmtTime(event.ts)}</span>
										<span className={event.kind === "compact" ? "text-[#e5534b]" : "text-owl-muted"}>{event.label}</span>
									</li>
								))}
						</ol>
					</section>
				)}
			</div>

			{/* 声明的工具（来源分组） */}
			{toolGroups.length > 0 && (
				<section className="mt-6">
					<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-owl-faint">声明工具 · {data.tools.length} 个</h3>
					<div className="flex flex-wrap gap-1.5">
						{toolGroups.map(([source, names]) => (
							<span
								key={source}
								className="rounded-full border border-owl-border/40 bg-owl-panel/60 px-2.5 py-1 text-[11px] text-owl-muted"
								title={names.join("\n")}
							>
								{source} · {names.length}
							</span>
						))}
					</div>
				</section>
			)}

			{/* 底部状态 */}
			<div className="mt-6 flex items-center gap-1.5 text-[10px] text-owl-faint">
				<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-owl-accent" />
				2s 轮询 · {data.requests.length} 条请求记录 · {data.sessionId ? `会话 ${data.sessionId.slice(0, 8)}` : "未关联会话"}
			</div>
		</div>
	);
}
