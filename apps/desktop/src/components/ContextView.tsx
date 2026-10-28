/**
 * 上下文视图 —— 当前会话的上下文仪表盘，占据主对话区
 * （顶栏「对话/上下文」tab 切换，见 App.tsx 的 conversationView）。
 * 数据由插件 owl-context 在请求组装点与流式事件上现采，经桥 context.get /
 * context.detail / context.item（core/context-insight 注册表）供数；这里 2s 轮询保活。
 * 版式与交互对齐 dsh-context 的会话内 Context 标签页：上下文统计、会话信息、
 * Token / 耗时统计、当前上下文、上下文趋势、上下文浏览器、上下文事件、文件活动。
 */
import "./context/context-view.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ContextEventRow, ContextFileOp, ContextRequestRow } from "../bridge/protocol.ts";
import { EventsCard, FilesCard } from "./context/ContextActivity.tsx";
import { BrowserCard, type BrowserFocus } from "./context/ContextBrowser.tsx";
import { DonutCard, Legend, StackedBar } from "./context/ContextCharts.tsx";
import { type Granularity, type LocateTarget, TrendCard, type TrendMode } from "./context/ContextTrend.tsx";
import {
	anchorParts,
	compositionParts,
	EMPTY_INSIGHT,
	fmtCost,
	fmtDuration,
	fmtPct1,
	fmtTime,
	fmtTokens,
	type InsightData,
	measuredOf,
	promptTokensOf,
	sessionStatsOf,
	stepsByTurn,
	stepTitle,
	timingStatsOf,
} from "./context/context-model.ts";

export function ContextRequestUsage({ usage }: { usage: NonNullable<ContextRequestRow["usage"]> }): React.JSX.Element {
	const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
	return (
		<span className="ctx-usage-line">
			本次输入 {fmtTokens(totalInput)}（含缓存；未缓存 {fmtTokens(usage.input)} · 缓存读 {fmtTokens(usage.cacheRead)}{" "}
			· 缓存写 {fmtTokens(usage.cacheWrite)}）· 本次输出 {fmtTokens(usage.output)}
		</span>
	);
}

function StatsCard({ data }: { data: InsightData }): React.JSX.Element {
	const stats = useMemo(() => sessionStatsOf(data.requests), [data.requests]);
	const totals = useMemo(() => {
		let input = 0;
		let output = 0;
		for (const row of data.requests) {
			if (!row.usage) continue;
			input += promptTokensOf(row.usage);
			output += row.usage.output;
		}
		return { input, output };
	}, [data.requests]);
	const cells: Array<{ label: string; value: string; title?: string }> = [
		{ label: "轮次", value: String(stats.turns), title: "用户发起的对话轮数" },
		{ label: "步数", value: String(stats.steps), title: "模型请求次数（一轮内每次工具往返算一步）" },
		{ label: "工具调用", value: String(stats.toolCalls) },
		{ label: "回答", value: String(stats.answers), title: "含正文回复的步数" },
		{
			label: "缓存命中",
			value: stats.cacheHit !== undefined ? fmtPct1(stats.cacheHit) : "—",
			title: "缓存读 ÷ 计费输入（含缓存）",
		},
		{ label: "费用", value: fmtCost(stats.cost), title: "provider 上报的累计费用" },
	];
	return (
		<div className="ctx-card ctx-col">
			<div className="ctx-card-title">
				<span className="ctx-card-title-text">上下文统计</span>
			</div>
			<div className="ctx-stats">
				{cells.map((cell) => (
					<div key={cell.label} className="ctx-stat" title={cell.title}>
						<b>{cell.value}</b>
						<span>{cell.label}</span>
					</div>
				))}
			</div>
			<div className="ctx-io">
				<span className="ctx-io-pill" title="各步计费输入之和（未缓存 + 缓存读 + 缓存写）">
					<i className="ctx-io-in" />
					输入 {fmtTokens(totals.input)}
				</span>
				<span className="ctx-io-pill" title="各步输出之和（含思考）">
					<i className="ctx-io-out" />
					输出 {fmtTokens(totals.output)}
				</span>
			</div>
		</div>
	);
}

function SessionCard({ data, latest }: { data: InsightData; latest: ContextRequestRow }): React.JSX.Element {
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
		<div className="ctx-card ctx-col">
			<div className="ctx-card-title">
				<span className="ctx-card-title-text">会话信息</span>
				<span className={`ctx-src${data.reconstructed ? "" : " ctx-src-live"}`}>
					{data.reconstructed ? "历史重建" : "实采"}
				</span>
			</div>
			<dl className="ctx-info">
				<dt>模型</dt>
				<dd title={latest.model ? `${latest.model.provider}/${latest.model.id}` : undefined}>
					{latest.model ? `${latest.model.provider} / ${latest.model.id}` : "—"}
				</dd>
				<dt>上下文窗口</dt>
				<dd>{latest.contextWindow ? `${fmtTokens(latest.contextWindow)} tokens` : "—"}</dd>
				<dt>会话</dt>
				<dd className="ctx-mono" title={data.sessionId}>
					{data.sessionId ? data.sessionId.slice(0, 8) : "未关联会话"}
				</dd>
				<dt>最近请求</dt>
				<dd>
					#{latest.seq} · {fmtTime(latest.ts)}
				</dd>
				{latest.usage && (
					<>
						<dt>本步用量</dt>
						<dd>
							<ContextRequestUsage usage={latest.usage} />
						</dd>
					</>
				)}
				{toolGroups.length > 0 && (
					<>
						<dt>声明工具</dt>
						<dd className="ctx-tool-groups">
							{toolGroups.map(([source, names]) => (
								<span key={source} className="ctx-tool-group" title={names.join("\n")}>
									{source} · {names.length}
								</span>
							))}
						</dd>
					</>
				)}
			</dl>
			{data.reconstructed && (
				<p className="ctx-note">本进程还没有该会话的实采数据：按会话转录回放估算，没有耗时数据。</p>
			)}
		</div>
	);
}

function CurrentCard({
	row,
	pinned,
	stepsInTurn,
	hoverCat,
	onHoverCat,
}: {
	row: ContextRequestRow;
	pinned: boolean;
	stepsInTurn: number;
	hoverCat: string | null;
	onHoverCat: (key: string | null) => void;
}): React.JSX.Element {
	const measured = row.usage ? measuredOf(row.usage) : undefined;
	const headline = measured ?? row.totalTokens;
	const capacity = row.contextWindow;
	const parts = useMemo(() => anchorParts(compositionParts(row), measured), [row, measured]);
	return (
		<div className="ctx-card">
			<div className="ctx-card-title">
				<span className="ctx-card-title-text">当前上下文</span>
				<span className="ctx-card-sub">{pinned ? stepTitle(row, stepsInTurn) : "最新一步"}</span>
				{row.model && <span className="ctx-card-sub ctx-card-right">{row.model.id}</span>}
			</div>
			<div className="ctx-headline">
				<b>{fmtTokens(headline)}</b>
				{capacity ? (
					<span className="ctx-headline-cap">/ {fmtTokens(capacity)} tokens</span>
				) : (
					<span className="ctx-headline-cap">tokens</span>
				)}
				<span
					className={`ctx-tag${measured !== undefined ? " ctx-tag-live" : ""}`}
					title={
						measured !== undefined
							? "provider 返回的本步输入、输出及缓存 token 总量"
							: "chars/4 估算，响应回来后改用 provider 用量"
					}
				>
					{measured !== undefined ? "实测" : "估算"}
				</span>
				{capacity ? (
					<span className="ctx-headline-pct">
						<b>{fmtPct1(headline / capacity)}</b> 上下文已用
					</span>
				) : null}
			</div>
			<StackedBar parts={parts} capacity={capacity} height={14} hoverKey={hoverCat} onHoverKey={onHoverCat} />
			<Legend parts={parts} total={headline} hoverKey={hoverCat} onHoverKey={onHoverCat} />
			{measured !== undefined && Math.abs(measured - row.totalTokens) > 500 && (
				<p className="ctx-note">
					构成按估算比例摊到实测总量；估算原值 ≈{fmtTokens(row.totalTokens)}（中文、JSON 与分词会带来误差）。
				</p>
			)}
		</div>
	);
}

export function ContextView({
	client,
	cwd,
	sessionId,
	requireSession = false,
	active = true,
}: {
	client: BridgeClient;
	cwd: string;
	sessionId?: string;
	/** Empty conversations must not fall back to another session in the same project. */
	requireSession?: boolean;
	active?: boolean;
}): React.JSX.Element {
	const [data, setData] = useState<InsightData>(EMPTY_INSIGHT);
	const [error, setError] = useState<string | undefined>(undefined);
	const lastJson = useRef("");
	const [granularity, setGranularity] = useState<Granularity>("step");
	const [mode, setMode] = useState<TrendMode>("total");
	const [durationCurve, setDurationCurve] = useState(false);
	const [hoveredSeq, setHoveredSeq] = useState<number | null>(null);
	const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
	const [hoverCat, setHoverCat] = useState<string | null>(null);
	const [focus, setFocus] = useState<BrowserFocus | null>(null);
	const [tokenHover, setTokenHover] = useState<string | null>(null);
	const [timeHover, setTimeHover] = useState<string | null>(null);

	useEffect(() => {
		setData(EMPTY_INSIGHT);
		setError(undefined);
		lastJson.current = "";
		if (!active || (requireSession && !sessionId)) return;
		let alive = true;
		const fetchOnce = async (): Promise<void> => {
			try {
				const response = await client.request<InsightData>({
					type: "context.get",
					cwd,
					...(sessionId ? { sessionId } : {}),
				});
				if (!alive) return;
				if (response.ok && response.result) {
					const json = JSON.stringify(response.result);
					if (json !== lastJson.current) {
						lastJson.current = json;
						setData({ ...EMPTY_INSIGHT, ...response.result });
					}
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

	const locate = useCallback((target: LocateTarget) => {
		setFocus((current) => ({ ...target, nonce: (current?.nonce ?? 0) + 1 }));
	}, []);
	const focusEvent = useCallback(
		(event: ContextEventRow) =>
			locate({ seq: event.seq, cat: event.itemKey ? "inject" : "toolSchemas", key: event.itemKey }),
		[locate],
	);
	const locateFileOp = useCallback(
		(op: ContextFileOp) => {
			// 工具结果出现在调用之后的那一步请求里；还没有下一步时在「当前」里
			const next = data.requests.find((row) => row.seq > op.seq);
			locate({ seq: next?.seq, cat: "toolResult", callId: op.callId });
		},
		[data.requests, locate],
	);

	const turnSteps = useMemo(() => stepsByTurn(data.requests), [data.requests]);
	const stats = useMemo(() => sessionStatsOf(data.requests), [data.requests]);
	const timing = timingStatsOf(data.requests, data.timing, Date.now());
	const latest = data.requests[data.requests.length - 1];
	const selectedRow = selectedSeq !== null ? data.requests.find((row) => row.seq === selectedSeq) : undefined;

	if (!latest) {
		return (
			<div className="ctx-root ctx-empty-state">
				<span className="ctx-empty-icon">🫧</span>
				<p>
					当前会话还没有上下文记录。
					<br />
					发一条消息后，这里会展示每一步请求的构成、趋势、事件与文件活动。
				</p>
				{error && <p className="ctx-error">{error}</p>}
			</div>
		);
	}

	const currentRow = selectedRow ?? latest;

	return (
		<div className="ctx-root">
			{error && <p className="ctx-error ctx-error-bar">{error}</p>}

			<div className="ctx-cols ctx-head">
				<StatsCard data={data} />
				<SessionCard data={data} latest={latest} />
			</div>

			<div className="ctx-cols">
				<div className="ctx-card ctx-col">
					<div className="ctx-card-title">
						<span className="ctx-card-title-text">Token 统计</span>
						{stats.cost !== undefined && (
							<span className="ctx-card-sub ctx-card-right">费用 {fmtCost(stats.cost)}</span>
						)}
					</div>
					{stats.billedTotal > 0 ? (
						<DonutCard
							parts={stats.billed}
							center={fmtTokens(stats.billedTotal)}
							caption="总用量"
							hoverKey={tokenHover}
							onHoverKey={setTokenHover}
						/>
					) : (
						<div className="ctx-lane">
							<span className="ctx-empty">尚无 provider 上报的用量</span>
						</div>
					)}
				</div>
				<div className="ctx-card ctx-col">
					<div className="ctx-card-title">
						<span className="ctx-card-title-text">耗时统计</span>
						{timing?.tps !== undefined && (
							<span
								className="ctx-card-sub ctx-card-right"
								title="输出 token ÷ 生成耗时（思考 + 回复 + 工具参数）"
							>
								输出 {timing.tps.toFixed(1)} tok/s
							</span>
						)}
					</div>
					{timing ? (
						<DonutCard
							parts={timing.parts}
							center={fmtDuration(timing.active)}
							caption="活跃时长"
							hoverKey={timeHover}
							onHoverKey={setTimeHover}
						/>
					) : (
						<div className="ctx-lane">
							<span className="ctx-empty">
								{data.reconstructed ? "历史重建的会话没有耗时数据" : "尚无耗时数据"}
							</span>
						</div>
					)}
				</div>
			</div>

			<div className="ctx-cols ctx-cols-main">
				<div className="ctx-col ctx-stack">
					<CurrentCard
						row={currentRow}
						pinned={selectedRow !== undefined}
						stepsInTurn={turnSteps.get(currentRow.turn) ?? 1}
						hoverCat={hoverCat}
						onHoverCat={setHoverCat}
					/>
					<TrendCard
						requests={data.requests}
						events={data.events}
						granularity={granularity}
						onGranularity={setGranularity}
						mode={mode}
						onMode={setMode}
						durationCurve={durationCurve}
						onDurationCurve={setDurationCurve}
						selectedSeq={selectedSeq}
						onSelect={setSelectedSeq}
						hoveredSeq={hoveredSeq}
						onHover={setHoveredSeq}
						hoverCat={hoverCat}
						onHoverCat={setHoverCat}
						onLocate={locate}
					/>
				</div>
				<div className="ctx-col">
					<BrowserCard
						client={client}
						cwd={cwd}
						sessionId={sessionId}
						requests={data.requests}
						liveVersion={data.liveVersion}
						previewSeq={hoveredSeq}
						pinSeq={selectedSeq}
						hoverCat={hoverCat}
						onHoverCat={setHoverCat}
						focus={focus}
					/>
				</div>
			</div>

			<div className="ctx-cols">
				<EventsCard events={data.events} onFocusEvent={focusEvent} />
				<FilesCard
					files={data.files}
					cwd={cwd}
					upTo={selectedRow?.seq}
					scope={
						selectedRow
							? `截至 ${stepTitle(selectedRow, turnSteps.get(selectedRow.turn) ?? 1)}`
							: "截至最新 · 跟随趋势图的选择"
					}
					onLocate={locateFileOp}
				/>
			</div>

			<div className="ctx-footer">
				<span className="ctx-pulse" />
				2s 轮询 · {data.requests.length} 步请求记录 · 「≈」为 chars/4 估算，「实际/实测」为 provider
				上报用量；缓存命中的内容仍占上下文窗口
			</div>
		</div>
	);
}
