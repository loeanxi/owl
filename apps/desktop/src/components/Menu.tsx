import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 轻量下拉菜单：点击触发器开合，点击外部或 Esc 关闭。
 * 面板向上弹出（输入栏在窗口底部）。
 */
export function Menu({
	trigger,
	triggerClassName,
	panelClassName,
	children,
	triggerTitle,
}: {
	trigger: ReactNode;
	triggerClassName: string;
	panelClassName?: string;
	/** 静态内容，或 (close) => 内容（菜单项点击后自动收起）。 */
	children: ReactNode | ((close: () => void) => ReactNode);
	triggerTitle?: string;
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
					className={`absolute bottom-full z-20 mb-2 rounded-xl border border-owl-border bg-owl-panel py-1 shadow-xl shadow-black/50 ${panelClassName ?? "left-0"}`}
				>
					{typeof children === "function" ? children(() => setOpen(false)) : children}
				</div>
			)}
		</div>
	);
}
