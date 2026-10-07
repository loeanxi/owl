/**
 * 号池 Manager 面板（迁移阶段 6）—— owl 内嵌 pool-server 管理台。
 * 管理台 SPA 运行在 pool-server (8790)，此处 iframe 全量嵌入。
 * 登录/首次设置/账号/签到/Key/模型/费率/日志/备份割接全部在管理台内完成。
 * CORS 已配（同机 127.0.0.1），cookie 同 host 自然携带。
 */
import { useCallback, useEffect, useState } from "react";

const DEFAULT_MANAGER_URL = "http://127.0.0.1:8790";

export function ManagerTab() {
	const [url] = useState(() => {
		const injected = (globalThis as Record<string, unknown>).OWL_MANAGER_URL;
		return typeof injected === "string" && injected.length > 0 ? injected : DEFAULT_MANAGER_URL;
	});
	const [status, setStatus] = useState<"checking" | "up" | "down">("checking");
	const [reloadKey, setReloadKey] = useState(0);

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
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#fff" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", borderBottom: "1px solid #eee", fontSize: 12 }}>
				<span style={{ flex: 1 }} />
				<span
					style={{ cursor: "pointer", color: status === "up" ? "#4caf7d" : status === "checking" ? "#888" : "#c0392b" }}
					onClick={check}
				>
					● {status === "up" ? "号池运行中" : status === "checking" ? "检测中…" : "号池离线"}
				</span>
				<button
					type="button"
					style={{ padding: "2px 8px", fontSize: 11 }}
					onClick={() => setReloadKey((k) => k + 1)}
				>
					刷新
				</button>
			</div>
			{status === "up" ? (
				<iframe
					key={reloadKey}
					src={url}
					title="号池管理台"
					style={{ flex: 1, width: "100%", border: "none", minHeight: 0 }}
				/>
			) : (
				<div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", justifyContent: "center", flex: 1 }}>
					<p style={{ fontWeight: 600 }}>号池服务未启动</p>
					<p style={{ fontSize: 12, color: "#888" }}>
						运行 <code>node apps/pool-server/dist/main.js</code>（默认 127.0.0.1:8790）
					</p>
					<button type="button" onClick={check}>重试</button>
				</div>
			)}
		</div>
	);
}
