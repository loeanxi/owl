/** 上下文页的图表基件：堆叠条、图例、环形图。 */
import { fmtPct, fmtTokens, type Part } from "./context-model.ts";

export function StackedBar({
	parts,
	capacity,
	height = 10,
	hoverKey,
	onHoverKey,
}: {
	parts: Part[];
	/** 给出时按窗口容量画，余量画斜纹「剩余窗口」。 */
	capacity?: number;
	height?: number;
	hoverKey?: string | null;
	onHoverKey?: (key: string | null) => void;
}): React.JSX.Element {
	const used = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
	const scale = Math.max(capacity ?? 0, used, 1);
	const free = capacity !== undefined ? Math.max(0, capacity - used) : 0;
	const dim = hoverKey !== undefined && hoverKey !== null && parts.some((part) => part.key === hoverKey);
	return (
		<div className={`ctx-stacked${dim ? " ctx-stacked-dim" : ""}`} style={{ height }} onMouseLeave={() => onHoverKey?.(null)}>
			{parts.map((part) =>
				part.value > 0 ? (
					<div
						key={part.key}
						className={`ctx-stacked-seg${hoverKey === part.key ? " ctx-stacked-seg-on" : ""}`}
						style={{ width: `${(part.value / scale) * 100}%`, background: part.color }}
						title={`${part.label} ≈${fmtTokens(part.raw ?? part.value)}（${fmtPct(part.value / Math.max(used, 1))}）`}
						onMouseEnter={() => onHoverKey?.(part.key)}
					/>
				) : null,
			)}
			{free > 0 && <div className="ctx-stacked-free" style={{ width: `${(free / scale) * 100}%` }} title={`剩余窗口 ${fmtTokens(free)}`} />}
		</div>
	);
}

export function Legend({
	parts,
	total,
	hoverKey,
	onHoverKey,
}: {
	parts: Part[];
	total: number;
	hoverKey?: string | null;
	onHoverKey?: (key: string | null) => void;
}): React.JSX.Element {
	return (
		<div className="ctx-legend" onMouseLeave={() => onHoverKey?.(null)}>
			{parts.map((part) => (
				<div
					key={part.key}
					className={`ctx-chip${hoverKey === part.key ? " ctx-chip-on" : ""}`}
					onMouseEnter={() => onHoverKey?.(part.key)}
				>
					<i style={{ background: part.color }} />
					<span className="ctx-chip-label">{part.label}</span>
					<span className="ctx-chip-nums">
						≈{fmtTokens(part.raw ?? part.value)}
						<em>{fmtPct(part.value / Math.max(total, 1))}</em>
					</span>
				</div>
			))}
		</div>
	);
}

const RING_R = 30;
const RING_C = 2 * Math.PI * RING_R;

/** 环形图 + 两列分段图例（Token 统计 / 耗时统计）。 */
export function DonutCard({
	parts,
	center,
	caption,
	hoverKey,
	onHoverKey,
}: {
	parts: Part[];
	center: string;
	caption: string;
	hoverKey?: string | null;
	onHoverKey?: (key: string | null) => void;
}): React.JSX.Element {
	const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
	let offset = 0;
	return (
		<div className="ctx-donut-row">
			<div className="ctx-donut">
				<svg viewBox="0 0 80 80" aria-hidden="true">
					<circle cx="40" cy="40" r={RING_R} className="ctx-donut-track" />
					{total > 0 &&
						parts.map((part) => {
							if (part.value <= 0) return null;
							const length = (part.value / total) * RING_C;
							const segment = (
								<circle
									key={part.key}
									cx="40"
									cy="40"
									r={RING_R}
									className={`ctx-donut-seg${hoverKey && hoverKey !== part.key ? " ctx-donut-seg-dim" : ""}`}
									stroke={part.color}
									strokeDasharray={`${Math.max(length - 0.6, 0.2)} ${RING_C}`}
									strokeDashoffset={-offset}
									onMouseEnter={() => onHoverKey?.(part.key)}
									onMouseLeave={() => onHoverKey?.(null)}
								/>
							);
							offset += length;
							return segment;
						})}
				</svg>
				<div className="ctx-donut-center">
					<b>{center}</b>
					<span>{caption}</span>
				</div>
			</div>
			<div className="ctx-sl" onMouseLeave={() => onHoverKey?.(null)}>
				{parts.map((part) => (
					<div
						key={part.key}
						className={`ctx-sl-row${hoverKey === part.key ? " ctx-sl-row-on" : ""}${part.value <= 0 ? " ctx-sl-row-dim" : ""}`}
						onMouseEnter={() => onHoverKey?.(part.key)}
					>
						<div className="ctx-sl-main">
							<i className="ctx-sl-dot" style={{ background: part.color }} />
							<span className="ctx-sl-label">{part.label}</span>
							<span className="ctx-sl-pct">{fmtPct(part.value / Math.max(total, 1))}</span>
						</div>
						<div className="ctx-sl-sub">{part.sub ?? `≈${fmtTokens(part.value)}`}</div>
					</div>
				))}
			</div>
		</div>
	);
}
