import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { startPointerDrag } from "../../sidebar/pointer-drag.ts";

type Pane = "days" | "assistant";
type PaneWidths = Record<Pane, number>;
const STORAGE_KEY = "owl.myself.pane-widths";
const DEFAULT_WIDTHS: PaneWidths = { days: 180, assistant: 330 };
const MIN_WIDTHS: PaneWidths = { days: 168, assistant: 280 };
const MAX_WIDTHS: PaneWidths = { days: 320, assistant: 640 };
const MAIN_MIN_WIDTH = 360;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

function loadWidths(): PaneWidths {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
		if (saved && typeof saved === "object") {
			const values = saved as Record<string, unknown>;
			return {
				days:
					typeof values.days === "number" && Number.isFinite(values.days)
						? clamp(values.days, MIN_WIDTHS.days, MAX_WIDTHS.days)
						: DEFAULT_WIDTHS.days,
				assistant:
					typeof values.assistant === "number" && Number.isFinite(values.assistant)
						? clamp(values.assistant, MIN_WIDTHS.assistant, MAX_WIDTHS.assistant)
						: DEFAULT_WIDTHS.assistant,
			};
		}
	} catch {
		/* Layout preferences are optional in restricted webviews. */
	}
	return { ...DEFAULT_WIDTHS };
}

/** The two assistant panes share one width budget and the app's existing pointer gesture. */
export function useMyselfPaneResize(
	container: RefObject<HTMLDivElement | null>,
	enabled: boolean,
	assistantOpen: boolean,
) {
	const [preferred, setPreferred] = useState(loadWidths);
	const [containerWidth, setContainerWidth] = useState(0);
	const [resizing, setResizing] = useState<Pane>();
	const dragCleanup = useRef<(() => void) | undefined>(undefined);
	const widthsRef = useRef(preferred);
	widthsRef.current = preferred;

	useEffect(() => {
		const element = container.current;
		if (!enabled || !element) return;
		let alive = true;
		const measure = (): void => {
			if (alive) setContainerWidth(element.getBoundingClientRect().width);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			alive = false;
			observer.disconnect();
			dragCleanup.current?.();
			dragCleanup.current = undefined;
		};
	}, [container, enabled]);

	const width = Math.floor(containerWidth) || 1280;
	const docked = width > 1050;
	const horizontalDays = width <= 720;
	const daysMax = Math.min(
		MAX_WIDTHS.days,
		Math.max(MIN_WIDTHS.days, width - MAIN_MIN_WIDTH - (docked && assistantOpen ? MIN_WIDTHS.assistant : 0)),
	);
	const days = clamp(preferred.days, MIN_WIDTHS.days, daysMax);
	const assistantMax = Math.max(
		1,
		Math.min(MAX_WIDTHS.assistant, docked ? width - days - MAIN_MIN_WIDTH : width - 24),
	);
	const assistantMin = Math.min(MIN_WIDTHS.assistant, assistantMax);
	const assistant = clamp(preferred.assistant, assistantMin, assistantMax);
	const maximums = {
		days:
			docked && assistantOpen
				? Math.min(daysMax, Math.max(MIN_WIDTHS.days, width - assistant - MAIN_MIN_WIDTH))
				: daysMax,
		assistant: assistantMax,
	};
	const minimums = { days: MIN_WIDTHS.days, assistant: assistantMin };
	const actual = { days, assistant };

	const update = (pane: Pane, value: number, persist: boolean): void => {
		const next = { ...widthsRef.current, [pane]: Math.round(clamp(value, minimums[pane], maximums[pane])) };
		widthsRef.current = next;
		setPreferred(next);
		if (persist) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				/* Keep the in-memory layout. */
			}
		}
	};
	const reset = (pane: Pane): void => {
		const next = { ...widthsRef.current, [pane]: DEFAULT_WIDTHS[pane] };
		widthsRef.current = next;
		setPreferred(next);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			/* Keep the in-memory layout. */
		}
	};
	const begin = (pane: Pane, event: ReactPointerEvent<HTMLInputElement>): void => {
		if (event.button !== 0 || !event.isPrimary) return;
		dragCleanup.current?.();
		const initial = { ...widthsRef.current };
		const startWidth = actual[pane];
		const startX = event.clientX;
		event.currentTarget.focus();
		setResizing(pane);
		dragCleanup.current = startPointerDrag(event.currentTarget, event.nativeEvent, {
			cursor: "col-resize",
			onMove: (next) => update(pane, startWidth + (next.clientX - startX) * (pane === "days" ? 1 : -1), false),
			onFinish: (cancelled) => {
				dragCleanup.current = undefined;
				setResizing(undefined);
				if (cancelled) {
					widthsRef.current = initial;
					setPreferred(initial);
					return;
				}
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(widthsRef.current));
				} catch {
					/* Keep the in-memory layout. */
				}
			},
		});
	};
	return {
		style: {
			"--owl-myself-days-width": `${days}px`,
			"--owl-myself-assistant-width": `${assistant}px`,
		} as CSSProperties,
		horizontalDays,
		handleProps: (pane: Pane) => ({
			type: "range" as const,
			min: minimums[pane],
			max: maximums[pane],
			value: actual[pane],
			step: 1,
			"data-myself-resize-handle": pane,
			className: `owl-myself-resize-handle is-${pane}${resizing === pane ? " is-active" : ""}`,
			style: pane === "days" && horizontalDays ? { display: "none" } : undefined,
			onPointerDown: (event: ReactPointerEvent<HTMLInputElement>) => begin(pane, event),
			onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(pane, Number(event.target.value), true),
			onDoubleClick: () => reset(pane),
		}),
	};
}
