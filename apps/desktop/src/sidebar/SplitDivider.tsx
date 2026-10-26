/**
 * 分屏分隔条：拖动调比例（拖动中跟随指针报百分比），双击复位到一半，方向键微调。
 * 拆成独立组件：分隔条是分屏唯一的操作入口，单独渲染才好测、才好目检。
 */
import { useCallback, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { startPointerDrag, type PointerDragHandlers } from "./pointer-drag.ts";
import { clampSplitRatio, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN, type SidebarStore } from "./store.ts";

export function SplitDivider({ store, splitId, dir, ratio }: {
	store: SidebarStore;
	/** 目标分隔条 id（store.setRatio 用）。 */
	splitId: string;
	/** row = 左右分屏，col = 上下分屏。 */
	dir: "row" | "col";
	/** 第一侧占比（0–1）：分隔条在容器里的位置。 */
	ratio: number;
}): React.JSX.Element {
	const t = useT();
	// 拖动中的比例提示（跟随指针）：松手即清。
	const [drag, setDrag] = useState<{ x: number; y: number; ratio: number } | undefined>(undefined);
	const activeDrag = useRef<(() => void) | undefined>(undefined);

	const beginPointerDrag = useCallback((event: React.PointerEvent<HTMLElement>, handlers: PointerDragHandlers): void => {
		if (event.button !== 0 || !event.isPrimary) return;
		activeDrag.current?.();
		event.preventDefault();
		activeDrag.current = startPointerDrag(event.currentTarget, event.nativeEvent, {
			...handlers,
			onFinish: (cancelled) => {
				activeDrag.current = undefined;
				handlers.onFinish(cancelled);
			},
		});
	}, []);

	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLElement>): void => {
			const parent = event.currentTarget.parentElement;
			if (!parent) return;
			const rect = parent.getBoundingClientRect();
			beginPointerDrag(event, {
				cursor: dir === "row" ? "col-resize" : "row-resize",
				onMove: (move) => {
					const next = dir === "row" ? (move.clientX - rect.left) / rect.width : (move.clientY - rect.top) / rect.height;
					// 拖动中不落盘：松手再 persist，避免一次拖动写十几次 localStorage。
					store.setRatio(splitId, next, { persist: false });
					// 把分隔条位置报出来：只看那条 1px 细线，看不出拖到了哪。
					setDrag({ x: move.clientX, y: move.clientY, ratio: next });
				},
				onFinish: () => {
					setDrag(undefined);
					store.persist();
				},
			});
		},
		[beginPointerDrag, dir, splitId, store],
	);

	return (
		<>
			<div
				role="separator"
				aria-orientation={dir === "row" ? "vertical" : "horizontal"}
				aria-valuenow={Math.round(ratio * 100)}
				aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
				aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
				aria-label={t("wb.splitPane")}
				title={t("wb.splitPaneHint")}
				tabIndex={0}
				data-tauri-drag-region="false"
				style={{ touchAction: "none" }}
				className={`group relative z-10 shrink-0 ${dir === "row" ? "-mx-1 w-2 cursor-col-resize" : "-my-1 h-2 cursor-row-resize"}`}
				onPointerDown={onPointerDown}
				/* 双击复位：一半是最常用的分屏比例，给一条不用瞄准的快捷路。 */
				onDoubleClick={() => store.setRatio(splitId, 0.5, { persist: true })}
				onKeyDown={(event) => {
					const step = event.shiftKey ? 0.1 : 0.02;
					if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
						event.preventDefault();
						store.setRatio(splitId, ratio - step, { persist: true });
					} else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
						event.preventDefault();
						store.setRatio(splitId, ratio + step, { persist: true });
					}
				}}
			>
				<div
					className={`absolute bg-owl-border/50 transition-colors group-hover:bg-owl-accent/60 ${
						dir === "row" ? "inset-y-0 left-1/2 w-px -translate-x-1/2" : "inset-x-0 top-1/2 h-px -translate-y-1/2"
					}`}
				/>
			</div>
			{drag && (
				<div
					className="pointer-events-none fixed z-50 rounded-md border border-owl-border bg-owl-panel px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-owl-text shadow-xl"
					style={{ left: drag.x + 10, top: drag.y + 10 }}
				>
					{Math.round(clampSplitRatio(drag.ratio) * 100)}%
				</div>
			)}
		</>
	);
}
