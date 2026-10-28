/**
 * 号池 Manager 面板（迁移阶段 6）—— iframe 嵌入 pool-server 管理台。
 * 管理台 SPA（登录/账号/签到/Key/模型/费率/日志/备份）全部在 8790 同源运行，
 * iframe 内部无跨源问题。CORS 头仅供 owl 页面直连 API 时使用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveSurfaceTheme } from "../../owl-appearance.ts";
import { attachManagerAccountAuth } from "./manager-account-auth.ts";
import { attachManagerTheme, managerFrameUrl } from "./manager-theme.ts";
import "./manager-tab.css";

const DEFAULT_URL = "http://127.0.0.1:8790";

export function ManagerTab({
	onOpenExternal,
	onThemeChange,
}: {
	onOpenExternal: (url: string) => Promise<void>;
	onThemeChange: (theme: "dark" | "light") => Promise<void>;
}) {
	const [url] = useState(() => {
		const injected = (globalThis as Record<string, unknown>).OWL_MANAGER_URL;
		return typeof injected === "string" && injected.length > 0 ? injected : DEFAULT_URL;
	});
	const [status, setStatus] = useState<"checking" | "up" | "down">("checking");
	const [reloadKey, setReloadKey] = useState(0);
	const frameUrl = useMemo(
		() => managerFrameUrl(url, window.location.origin, resolveSurfaceTheme(document.documentElement.dataset)),
		[url, reloadKey],
	);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const themeBridgeRef = useRef<ReturnType<typeof attachManagerTheme> | null>(null);
	const themeChangeRef = useRef(onThemeChange);
	themeChangeRef.current = onThemeChange;
	const openExternalRef = useRef(onOpenExternal);
	openExternalRef.current = onOpenExternal;

	useEffect(
		() =>
			attachManagerAccountAuth({
				host: window,
				managerUrl: url,
				frameWindow: () => frameRef.current?.contentWindow ?? null,
				openExternal: (target) => openExternalRef.current(target),
			}),
		[url],
	);
	useEffect(() => {
		const surface = surfaceRef.current;
		if (!surface) return;
		const bridge = attachManagerTheme({
			host: window,
			root: document.documentElement,
			surface,
			managerUrl: url,
			frameWindow: () => frameRef.current?.contentWindow ?? null,
			onThemeChange: (theme) => themeChangeRef.current(theme),
		});
		themeBridgeRef.current = bridge;
		return () => {
			bridge.dispose();
			themeBridgeRef.current = null;
		};
	}, [url]);

	const check = useCallback(() => {
		setStatus("checking");
		fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) })
			.then((res) => setStatus(res.ok ? "up" : "down"))
			.catch(() => setStatus("down"));
	}, [url]);

	useEffect(() => {
		check();
	}, [check, reloadKey]);

	return (
		<div ref={surfaceRef} className="owl-manager-tab">
			<div className="owl-manager-bar">
				<button type="button" className="owl-manager-status" onClick={check} aria-live="polite">
					<span className={`owl-manager-status-dot is-${status}`} aria-hidden="true" />
					{status === "up" ? "号池运行中" : status === "checking" ? "检测中…" : "号池离线"}
				</button>
				<button type="button" className="owl-manager-refresh" onClick={() => setReloadKey((k) => k + 1)}>
					刷新
				</button>
			</div>
			{status === "up" ? (
				<iframe
					ref={frameRef}
					key={reloadKey}
					src={frameUrl}
					title="号池管理台"
					className="owl-manager-frame"
					onLoad={() => themeBridgeRef.current?.sync()}
					allow="clipboard-write"
				/>
			) : (
				<div className="owl-manager-empty">
					<p style={{ fontWeight: 600 }}>号池服务未启动</p>
					<p className="owl-manager-hint">
						Owl 启动时会自动拉起号池（默认 127.0.0.1:8790）。若仍离线，可托盘「重启后台服务」， 或手动运行{" "}
						<code>node apps/pool-server/dist/main.js</code>。
					</p>
					<button type="button" className="owl-manager-refresh" onClick={check}>
						重试
					</button>
				</div>
			)}
		</div>
	);
}
