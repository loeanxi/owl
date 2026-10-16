import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../i18n/index.ts";
import "./window-controls.css";

/** 浏览器 dev 下没有 Tauri 注入的 IPC，此时不渲染窗口按钮。 */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const buttonClass = "owl-chrome-button owl-window-button";

/** 无边框窗口的自绘控制按钮：最小化 / 最大化还原 / 关闭。 */
export function WindowControls(): React.JSX.Element | null {
	const t = useT();
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
		<div className="owl-window-controls" data-tauri-drag-region="false">
			<button
				type="button"
				aria-label={t("window.minimize")}
				title={t("window.minimize")}
				className={buttonClass}
				onClick={() => void current.minimize()}
			>
				<svg className="owl-window-control-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
					<path d="M3 8h10" />
				</svg>
			</button>
			<button
				type="button"
				aria-label={maximized ? t("window.restore") : t("window.maximize")}
				title={maximized ? t("window.restore") : t("window.maximize")}
				className={buttonClass}
				onClick={() => void current.toggleMaximize()}
			>
				{maximized ? (
					<svg className="owl-window-control-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
						<rect x="3.5" y="6.5" width="6" height="6" rx="0.5" />
						<path d="M6.5 6.5V3.5h6v6h-3" />
					</svg>
				) : (
					<svg className="owl-window-control-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
						<rect x="3.5" y="3.5" width="9" height="9" rx="0.75" />
					</svg>
				)}
			</button>
			<button
				type="button"
				aria-label={t("window.close")}
				title={t("window.close")}
				className={`${buttonClass} owl-window-close`}
				onClick={() => void current.close()}
			>
				<svg className="owl-window-control-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
					<path d="m3 3 10 10M13 3 3 13" />
				</svg>
			</button>
		</div>
	);
}
