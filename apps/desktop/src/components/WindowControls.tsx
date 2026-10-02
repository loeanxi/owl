import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 浏览器 dev 下没有 Tauri 注入的 IPC，此时不渲染窗口按钮。 */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const buttonClass =
	"inline-flex h-5 w-6 items-center justify-center rounded text-owl-faint " +
	"transition-colors hover:bg-owl-hover hover:text-owl-muted";

/** 无边框窗口的自绘控制按钮：最小化 / 最大化还原 / 关闭。 */
export function WindowControls(): React.JSX.Element | null {
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		if (!inTauri) return;
		const current = getCurrentWindow();
		const sync = (): void => {
			void current.isMaximized().then(setMaximized).catch(() => {});
		};
		sync();
		let disposed = false;
		let off = (): void => {};
		void current
			.onResized(sync)
			.then((unlisten) => {
				if (disposed) unlisten();
				else off = unlisten;
			})
			.catch(() => {});
		return () => {
			disposed = true;
			off();
		};
	}, []);

	if (!inTauri) return null;
	const current = getCurrentWindow();

	return (
		<div className="ml-1.5 flex items-center gap-1" data-tauri-drag-region="false">
			<button
				type="button"
				aria-label="最小化"
				title="最小化"
				className={buttonClass}
				onClick={() => void current.minimize()}
			>
				<svg className="h-2 w-2" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
					<path d="M2 6h8" />
				</svg>
			</button>
			<button
				type="button"
				aria-label={maximized ? "还原" : "最大化"}
				title={maximized ? "还原" : "最大化"}
				className={buttonClass}
				onClick={() => void current.toggleMaximize()}
			>
				{maximized ? (
					<svg className="h-2 w-2" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
						<rect x="2.2" y="4.2" width="5.6" height="5.6" rx="0.5" />
						<path d="M4.4 4.2V2.6a0.4 0.4 0 0 1 0.4-0.4h4.6a0.4 0.4 0 0 1 0.4 0.4v4.6a0.4 0.4 0 0 1-0.4 0.4H7.8" />
					</svg>
				) : (
					<svg className="h-2 w-2" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
						<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="0.5" />
					</svg>
				)}
			</button>
			<button
				type="button"
				aria-label="关闭"
				title="关闭"
					className={
						"inline-flex h-5 w-6 items-center justify-center rounded text-owl-faint " +
						"transition-colors hover:bg-red-600 hover:text-white"
					}
					onClick={() => void current.close()}
				>
					<svg className="h-2 w-2" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
						<path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
					</svg>
			</button>
		</div>
	);
}
