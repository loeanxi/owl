import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 轻量下拉菜单：点击触发器开合，点击外部或 Esc 关闭。
 * 面板默认向上弹出（输入栏在窗口底部）；窗口顶部用 direction="down" 向下弹。
 */
export function Menu({
	trigger,
	triggerClassName,
	panelClassName,
	children,
	triggerTitle,
	direction = "up",
}: {
	trigger: ReactNode;
	triggerClassName: string;
	panelClassName?: string;
	/** 静态内容，或 (close) => 内容（菜单项点击后自动收起）。 */
	children: ReactNode | ((close: () => void) => ReactNode);
	triggerTitle?: string;
	/** 面板弹出方向：up=触发器上方（默认），down=触发器下方。 */
	direction?: "up" | "down";
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent): void => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div className="relative" ref={rootRef}>
			<button
				type="button"
				className={triggerClassName}
				title={triggerTitle}
				onClick={() => setOpen((value) => !value)}
			>
				{trigger}
			</button>
			{open && (
				<div
					className={`absolute z-20 rounded-xl border border-owl-border bg-owl-panel py-1 shadow-xl shadow-black/50 ${direction === "down" ? "top-full mt-2" : "bottom-full mb-2"} ${panelClassName ?? "left-0"}`}
				>
					{typeof children === "function" ? children(() => setOpen(false)) : children}
				</div>
			)}
		</div>
	);
}
