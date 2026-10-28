/**
 * 上下文趋势：每次模型请求一根堆叠柱（或每轮一根），全量 / 增量两种读法，
 * 压缩 ✂ 标记、轮次条、耗时曲线；柱下是所选步骤的详情与简报。
 * 结构与交互对齐 dsh-context 的 Context Trend 卡片。
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContextBriefItem, ContextCategory, ContextEventRow, ContextRequestRow } from "../../bridge/protocol.ts";
import { StackedBar } from "./ContextCharts.tsx";
import {
	barsOf,
	CATS,
	cacheHitOf,
	compositionParts,
	fmtDuration,
	fmtPct,
	fmtPct1,
	fmtSigned,
	fmtTime,
	fmtTokens,
	promptTokensOf,
	stepsByTurn,
	type TrendBar,
} from "./context-model.ts";

const PLOT = 112;
const PAD_TOP = 18;
const BAR_W = 14;
const GAP = 2;
const SLOT = BAR_W + GAP;
const TURN_FILLS = [
	"color-mix(in srgb, var(--color-owl-faint) 22%, transparent)",
	"color-mix(in srgb, var(--color-owl-faint) 12%, transparent)",
];

export type Granularity = "step" | "turn";
export type TrendMode = "total" | "delta";

/** 浏览器定位请求：seq 缺省 = 当前（下一次请求）。 */
export interface LocateTarget {
	seq?: number;
	cat: ContextCategory;
	key?: string;
	callId?: string;
}

function deltaOf(bar: TrendBar, prev: TrendBar | undefined): Record<ContextCategory, number> {
	const out = {} as Record<ContextCategory, number>;
	for (const cat of CATS) out[cat.key] = (bar.row.composition[cat.key] ?? 0) - (prev?.row.composition[cat.key] ?? 0);
	return out;
}

function Toggle<T extends string>({
	value,
	options,
	onChange,
	title,
}: {
	value: T;
	options: Array<{ key: T; label: string }>;
	onChange: (value: T) => void;
	title?: string;
}): React.JSX.Element {
	return (
		<div className="ctx-gran" title={title}>
			{options.map((option) => (
				<button
					key={option.key}
					type="button"
					className={`ctx-gran-btn${value === option.key ? " ctx-gran-on" : ""}`}
					onClick={() => onChange(option.key)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export { Toggle };

export function TrendCard({
	requests,
	events,
	granularity,
	onGranularity,
	mode,
	onMode,
	durationCurve,
	onDurationCurve,
	selectedSeq,
	onSelect,
	hoveredSeq,
	onHover,
	hoverCat,
	onHoverCat,
	onLocate,
}: {
	requests: ContextRequestRow[];
	events: ContextEventRow[];
	granularity: Granularity;
	onGranularity: (value: Granularity) => void;
	mode: TrendMode;
	onMode: (value: TrendMode) => void;
	durationCurve: boolean;
	onDurationCurve: (value: boolean) => void;
	selectedSeq: number | null;
	onSelect: (seq: number | null) => void;
	hoveredSeq: number | null;
	onHover: (seq: number | null) => void;
	hoverCat: string | null;
	onHoverCat: (key: string | null) => void;
	onLocate: (target: LocateTarget) => void;
}): React.JSX.Element {
	const bars = useMemo(() => barsOf(requests, granularity), [requests, granularity]);
	const steps = useMemo(() => stepsByTurn(requests), [requests]);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const pinnedToEnd = useRef(true);
	const [hoverTurn, setHoverTurn] = useState<number | null>(null);

	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (scroller && pinnedToEnd.current) scroller.scrollLeft = scroller.scrollWidth;
	}, [bars.length, granularity]);

	const indexOfSeq = (seq: number | null): number =>
		seq === null ? -1 : bars.findIndex((bar) => bar.row.seq === seq);
	const hoveredIndex = indexOfSeq(hoveredSeq);
	const pinnedIndex = indexOfSeq(selectedSeq);
	const activeIndex = hoveredIndex >= 0 ? hoveredIndex : pinnedIndex >= 0 ? pinnedIndex : bars.length - 1;
	const active = bars[activeIndex];
	const activeTurn = hoverTurn ?? (hoveredIndex >= 0 ? bars[hoveredIndex]!.row.turn : null);

	const deltas = useMemo(() => bars.map((bar, index) => deltaOf(bar, bars[index - 1])), [bars]);
	const scale = useMemo(() => {
		if (mode === "total") return { max: Math.max(...bars.map((bar) => bar.row.totalTokens), 1), up: 0, down: 0 };
		let up = 0;
		let down = 0;
		for (const delta of deltas) {
			let plus = 0;
			let minus = 0;
			for (const value of Object.values(delta)) value > 0 ? (plus += value) : (minus -= value);
			up = Math.max(up, plus);
			down = Math.max(down, minus);
		}
		return { max: Math.max(up + down, 1), up, down };
	}, [bars, deltas, mode]);
	const zeroFromTop = mode === "delta" ? (PLOT * scale.up) / scale.max : PLOT;
	const maxDuration = Math.max(...bars.map((bar) => bar.duration ?? 0), 0);
	const showDuration = durationCurve && maxDuration > 0;

	const markers = useMemo(() => {
		const map = new Map<number, ContextEventRow[]>();
		for (const event of events) {
			if (event.kind !== "compact" || event.seq === undefined) continue;
			const index =
				granularity === "step"
					? bars.findIndex((bar) => bar.row.seq === event.seq)
					: bars.findIndex((bar) => bar.row.turn === event.turn);
			if (index < 0) continue;
			map.set(index, [...(map.get(index) ?? []), event]);
		}
		return map;
	}, [events, bars, granularity]);

	const turnGroups = useMemo(() => {
		const groups: Array<{ turn: number; count: number }> = [];
		for (const bar of bars) {
			const last = groups[groups.length - 1];
			if (last && last.turn === bar.row.turn) last.count += 1;
			else groups.push({ turn: bar.row.turn, count: 1 });
		}
		return groups;
	}, [bars]);

	const axisLabels =
		mode === "total"
			? [1, 0.75, 0.5, 0.25, 0].map((frac) => ({
					top: PAD_TOP + PLOT * (1 - frac),
					text: fmtTokens(scale.max * frac),
				}))
			: [
					{ top: PAD_TOP, text: scale.up > 0 ? `+${fmtTokens(scale.up)}` : "" },
					{ top: PAD_TOP + zeroFromTop, text: "0" },
					{ top: PAD_TOP + PLOT, text: scale.down > 0 ? `−${fmtTokens(scale.down)}` : "" },
				];

	const tipBar = hoveredIndex >= 0 ? bars[hoveredIndex] : undefined;
	let tipLeft = 0;
	if (tipBar && scrollRef.current && wrapRef.current) {
		const raw = hoveredIndex * SLOT + 2 - scrollRef.current.scrollLeft;
		tipLeft = Math.max(0, Math.min(raw, wrapRef.current.clientWidth - 220));
	}

	return (
		<div className="ctx-card">
			<div className="ctx-card-title">
				<span className="ctx-card-title-text">上下文趋势</span>
				<span className="ctx-gran ctx-trend-mods">
					<button
						type="button"
						className={`ctx-gran-btn${durationCurve ? " ctx-gran-on" : ""}`}
						title="在柱子上叠加每步的模型耗时曲线（右侧坐标轴）；轮次粒度下为一轮各步之和"
						onClick={() => onDurationCurve(!durationCurve)}
					>
						耗时
					</button>
				</span>
				<div className="ctx-trend-ctl">
					<Toggle
						value={granularity}
						options={[
							{ key: "step", label: "步骤" },
							{ key: "turn", label: "轮次" },
						]}
						onChange={onGranularity}
					/>
					<Toggle
						value={mode}
						options={[
							{ key: "total", label: "全量" },
							{ key: "delta", label: "增量" },
						]}
						onChange={onMode}
						title="全量：累计构成；增量：相对上一条请求的变化量"
					/>
				</div>
			</div>

			{bars.length === 0 ? (
				<div className="ctx-trend-empty">发起一轮对话后，这里会展示每次模型请求的上下文构成</div>
			) : (
				<>
					<div className="ctx-chartrow">
						<div className="ctx-axis">
							{axisLabels.map((label, index) => (
								<span key={index} style={{ top: label.top - 6 }}>
									{label.text}
								</span>
							))}
						</div>
						<div className="ctx-chart-wrap" ref={wrapRef} onMouseLeave={() => onHover(null)}>
							<div
								className="ctx-chart-scroll"
								ref={scrollRef}
								onScroll={(event) => {
									const target = event.currentTarget;
									pinnedToEnd.current = target.scrollLeft + target.clientWidth >= target.scrollWidth - 4;
								}}
							>
								<div
									className={`ctx-chart${activeTurn !== null ? " ctx-chart-dim" : ""}`}
									data-catdim={hoverCat ?? undefined}
								>
									{(mode === "total" ? [0.25, 0.5, 0.75, 1] : [0, 1]).map((frac) => (
										<div key={frac} className="ctx-grid" style={{ top: PAD_TOP + PLOT * (1 - frac) }} />
									))}
									<div className="ctx-grid ctx-grid-zero" style={{ top: PAD_TOP + zeroFromTop }} />
									{bars.map((bar, index) => {
										const cls = [
											"ctx-bar",
											index === hoveredIndex ? "ctx-bar-hovered" : "",
											index === pinnedIndex ? "ctx-bar-selected" : "",
											activeTurn !== null && bar.row.turn === activeTurn ? "ctx-bar-in-turn" : "",
										]
											.filter(Boolean)
											.join(" ");
										const marker = markers.get(index);
										return (
											<div
												key={bar.row.seq}
												className={cls}
												onMouseEnter={() => onHover(bar.row.seq)}
												onClick={() => onSelect(selectedSeq === bar.row.seq ? null : bar.row.seq)}
											>
												{mode === "total" ? (
													<div className="ctx-bar-stack">
														{CATS.map((cat) => {
															const value = bar.row.composition[cat.key] ?? 0;
															if (value <= 0) return null;
															return (
																<div
																	key={cat.key}
																	className="ctx-cat-seg"
																	data-cat={cat.key}
																	style={{ height: (value / scale.max) * PLOT, background: cat.color }}
																/>
															);
														})}
													</div>
												) : (
													<>
														<div className="ctx-bar-up" style={{ bottom: PLOT - zeroFromTop }}>
															{CATS.map((cat) => {
																const value = deltas[index]![cat.key];
																if (value <= 0) return null;
																return (
																	<div
																		key={cat.key}
																		className="ctx-cat-seg"
																		data-cat={cat.key}
																		style={{
																			height: (value / scale.max) * PLOT,
																			background: cat.color,
																		}}
																	/>
																);
															})}
														</div>
														<div className="ctx-bar-down" style={{ top: zeroFromTop }}>
															{CATS.map((cat) => {
																const value = deltas[index]![cat.key];
																if (value >= 0) return null;
																return (
																	<div
																		key={cat.key}
																		className="ctx-cat-seg"
																		data-cat={cat.key}
																		style={{
																			height: (-value / scale.max) * PLOT,
																			background: cat.color,
																		}}
																	/>
																);
															})}
														</div>
													</>
												)}
												{marker && (
													<span
														className="ctx-bar-marker"
														title={marker.map((event) => event.label).join("\n")}
													>
														✂
													</span>
												)}
												{granularity === "step" && (index + 1) % 5 === 0 && !marker && (
													<span className="ctx-step-flag">
														<span className="ctx-step-flag-label">{index + 1}</span>
													</span>
												)}
											</div>
										);
									})}
									{showDuration && (
										<svg
											className="ctx-duration"
											width={bars.length * SLOT}
											height={PLOT}
											style={{ top: PAD_TOP }}
											aria-hidden="true"
										>
											<polyline
												points={bars
													.map((bar, index) =>
														bar.duration === undefined
															? null
															: `${index * SLOT + BAR_W / 2},${PLOT - (bar.duration / maxDuration) * PLOT}`,
													)
													.filter(Boolean)
													.join(" ")}
											/>
										</svg>
									)}
								</div>
								<div className="ctx-turns">
									{turnGroups.map((group, index) => (
										<div
											key={`${group.turn}-${index}`}
											className={`ctx-turn${activeTurn === group.turn ? " ctx-turn-on" : ""}`}
											style={{ width: group.count * SLOT - GAP, background: TURN_FILLS[index % 2] }}
											title={`第 ${group.turn} 轮 · 共 ${steps.get(group.turn) ?? group.count} 步`}
											onMouseEnter={() => setHoverTurn(group.turn)}
											onMouseLeave={() => setHoverTurn(null)}
											onClick={() => {
												const last = [...requests].reverse().find((row) => row.turn === group.turn);
												onGranularity("turn");
												if (last) onSelect(last.seq);
											}}
										>
											{group.count * SLOT >= 12 ? group.turn : ""}
										</div>
									))}
								</div>
							</div>
							{tipBar && (
								<div className="ctx-chart-tip" style={{ transform: `translateX(${tipLeft}px)` }}>
									<span>
										{granularity === "turn"
											? `第 ${tipBar.row.turn} 轮 · 共 ${tipBar.stepCount} 步`
											: `第 ${tipBar.row.turn} 轮 · 第 ${tipBar.row.step} 步 (共 ${steps.get(tipBar.row.turn) ?? tipBar.row.step} 步)`}
									</span>
									<span>
										{mode === "delta"
											? `Δ ${fmtSigned(tipBar.row.totalTokens - (bars[hoveredIndex - 1]?.row.totalTokens ?? 0))}`
											: `合计 ≈ ${fmtTokens(tipBar.row.totalTokens)}`}
										{tipBar.duration !== undefined ? ` · 耗时 ${fmtDuration(tipBar.duration)}` : ""}
									</span>
								</div>
							)}
						</div>
						{showDuration && (
							<div className="ctx-axis ctx-axis-r">
								{[1, 0.75, 0.5, 0.25, 0].map((frac) => (
									<span key={frac} style={{ top: PAD_TOP + PLOT * (1 - frac) - 6 }}>
										{frac === 0 ? "0" : fmtDuration(maxDuration * frac)}
									</span>
								))}
							</div>
						)}
					</div>
					{active && (
						<RequestDetail
							bar={active}
							prev={mode === "delta" ? bars[activeIndex - 1] : undefined}
							mode={mode}
							granularity={granularity}
							stepsInTurn={steps.get(active.row.turn) ?? active.row.step}
							nextSeq={requests[requests.findIndex((row) => row.seq === active.row.seq) + 1]?.seq}
							marker={markers.get(activeIndex)}
							hoverCat={hoverCat}
							onHoverCat={onHoverCat}
							onLocate={onLocate}
						/>
					)}
				</>
			)}
		</div>
	);
}

function BriefChips({ items }: { items: ContextBriefItem[] }): React.JSX.Element {
	const shown = items.slice(0, 2);
	return (
		<>
			{shown.map((item, index) => (
				<span key={index} className={`ctx-brief-chip${shown.length === 1 ? " ctx-brief-chip-grow" : ""}`}>
					{item.error && <i className="ctx-err-dot" />}
					{item.chip && <span className="ctx-brief-chip-tag">{item.chip}</span>}
					<span className="ctx-brief-chip-text">{item.text}</span>
				</span>
			))}
			{items.length > shown.length && <span className="ctx-brief-more">+{items.length - shown.length}</span>}
		</>
	);
}

function RequestDetail({
	bar,
	prev,
	mode,
	granularity,
	stepsInTurn,
	nextSeq,
	marker,
	hoverCat,
	onHoverCat,
	onLocate,
}: {
	bar: TrendBar;
	prev?: TrendBar;
	mode: TrendMode;
	granularity: Granularity;
	stepsInTurn: number;
	nextSeq?: number;
	marker?: ContextEventRow[];
	hoverCat: string | null;
	onHoverCat: (key: string | null) => void;
	onLocate: (target: LocateTarget) => void;
}): React.JSX.Element {
	const row = bar.row;
	const usage = row.usage;
	const total = Math.max(row.totalTokens, 1);
	const deltas = mode === "delta" ? deltaOf(bar, prev) : undefined;
	const maxAbs = deltas ? Math.max(...Object.values(deltas).map(Math.abs), 1) : total;
	const brief = row.brief;
	const cacheHit = usage ? cacheHitOf(usage) : undefined;
	return (
		<div className="ctx-detail">
			<div className="ctx-detail-head">
				<b>
					{granularity === "turn" && bar.stepCount > 1
						? `第 ${row.turn} 轮 · 共 ${bar.stepCount} 步`
						: `第 ${row.turn} 轮 · 第 ${row.step} 步 (共 ${stepsInTurn} 步)`}
				</b>
				{granularity === "turn" && bar.stepCount > 1 && <span className="ctx-detail-tag">末步</span>}
				{marker && <span className="ctx-detail-marker">✂ {marker.map((event) => event.label).join(" · ")}</span>}
				{row.model && <span className="ctx-detail-tag">{row.model.id}</span>}
				<span className="ctx-detail-time">{fmtTime(row.ts)}</span>
				<div className="ctx-detail-metrics">
					{usage ? (
						<>
							<span className="ctx-detail-metric" title="provider 上报的本次计费输入（含缓存读写）">
								实际 {fmtTokens(promptTokensOf(usage))}
							</span>
							<span className="ctx-detail-metric">输出 {fmtTokens(usage.output)}</span>
							{cacheHit !== undefined && <span className="ctx-detail-metric">缓存 {fmtPct1(cacheHit)}</span>}
						</>
					) : (
						<span className="ctx-detail-metric">估算合计 ≈ {fmtTokens(row.totalTokens)}</span>
					)}
					{deltas && (
						<span
							className={`ctx-detail-metric ${row.totalTokens - (prev?.row.totalTokens ?? 0) >= 0 ? "ctx-detail-metric-up" : "ctx-detail-metric-down"}`}
						>
							Δ {fmtSigned(row.totalTokens - (prev?.row.totalTokens ?? 0))}
						</span>
					)}
					{bar.duration !== undefined && (
						<span className="ctx-detail-metric">耗时 {fmtDuration(bar.duration)}</span>
					)}
				</div>
			</div>

			<div className="ctx-brief">
				<button
					type="button"
					className="ctx-brief-row ctx-brief-row-link"
					onClick={() => onLocate({ seq: row.seq, cat: "user" })}
				>
					<span className="ctx-brief-tag" title="这一轮开场时用户发送的消息；回合内的每一步都会回显同一条">
						本轮
					</span>
					{brief?.user ? (
						<span className="ctx-brief-text">{brief.user}</span>
					) : (
						<span className="ctx-brief-empty">—</span>
					)}
				</button>
				<button
					type="button"
					className="ctx-brief-row ctx-brief-row-link"
					onClick={() => onLocate({ seq: row.seq, cat: "toolResult" })}
				>
					<span
						className="ctx-brief-tag"
						title="上一步回复之后、本次请求发出前新进入上下文的内容——通常是上一步所调工具的结果；每轮的第一步无新增"
					>
						输入
					</span>
					{brief && brief.inbound.length > 0 ? (
						<BriefChips items={brief.inbound} />
					) : (
						<span className="ctx-brief-empty">（无新增）</span>
					)}
				</button>
				<button
					type="button"
					className="ctx-brief-row ctx-brief-row-link"
					onClick={() => onLocate({ seq: nextSeq, cat: "assistant" })}
				>
					<span
						className="ctx-brief-tag"
						title="这一步模型返回的内容（文本回复或工具调用）；此步发起的调用，其结果会出现在下一柱的「输入」行"
					>
						回复
					</span>
					{brief && brief.response.length > 0 ? (
						<BriefChips items={brief.response} />
					) : (
						<span className="ctx-brief-empty">—</span>
					)}
				</button>
			</div>

			<StackedBar parts={compositionParts(row)} hoverKey={hoverCat} onHoverKey={onHoverCat} />
			<div className="ctx-detail-rows" onMouseLeave={() => onHoverCat(null)}>
				{CATS.map((cat) => {
					const value = row.composition[cat.key] ?? 0;
					const delta = deltas?.[cat.key];
					return (
						<div
							key={cat.key}
							className={`ctx-detail-row${hoverCat === cat.key ? " ctx-detail-row-on" : ""}`}
							onMouseEnter={() => onHoverCat(cat.key)}
						>
							<i style={{ background: cat.color }} />
							<span className="ctx-detail-label">{cat.label}</span>
							<span className="ctx-bar-track">
								{delta === undefined ? (
									<span
										className="ctx-bar-fill"
										style={{ width: `${(value / total) * 100}%`, background: cat.color }}
									/>
								) : (
									<>
										<span className="ctx-bar-zero" />
										<span
											className={delta >= 0 ? "ctx-bar-fill-up" : "ctx-bar-fill-down"}
											style={{ width: `${(Math.abs(delta) / maxAbs) * 50}%`, background: cat.color }}
										/>
									</>
								)}
							</span>
							{delta === undefined ? (
								<>
									<span className="ctx-detail-num">≈{fmtTokens(value)}</span>
									<span className="ctx-detail-pct">{fmtPct(value / total)}</span>
								</>
							) : (
								<>
									<span
										className={`ctx-detail-num ${delta > 0 ? "ctx-detail-num-up" : delta < 0 ? "ctx-detail-num-down" : ""}`}
									>
										{fmtSigned(delta)}
									</span>
									<span className="ctx-detail-pct">≈{fmtTokens(value)}</span>
								</>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
