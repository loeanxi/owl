/**
 * Manager 号池 tab —— manager 迁移阶段 6 的桌面端入口。
 *
 * 嵌 pool-server 管理台（127.0.0.1:8790）的 WebView 面板：账号池、签到、
 * Key、费率、调用日志、备份/割接全部经这里使用。池服务未启动时给出
 * 带启动指引的空态。地址可配（OWL_MANAGER_URL，默认本机 8790）。
 *
 * 阶段 6 的原生 UI 渐进替换策略见迁移文档 §9：先用管理台整页嵌入
 * 保证能力全量可用，后续按域替换为原生面板。
 */
import { useCallback, useEffect, useState } from "react";
import type { TabComponentProps } from "../registry.ts";
import { IconRefresh } from "../icons.tsx";

const DEFAULT_MANAGER_URL = "http://127.0.0.1:8790";

interface Healthz {
	status: string;
	db: string;
	uptimeSeconds: number;
}

export function ManagerTab(_props: TabComponentProps) {
	const [url] = useState(() => resolveManagerUrl());
	const [health, setHealth] = useState<Healthz | null>(null);
	const [probe, setProbe] = useState<"checking" | "up" | "down">("checking");
	const [reloadKey, setReloadKey] = useState(0);

	const check = useCallback(async () => {
		setProbe("checking");
		try {
			const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
			if (!response.ok) {
				throw new Error(String(response.status));
			}
			setHealth((await response.json()) as Healthz);
			setProbe("up");
		} catch {
			setHealth(null);
			setProbe("down");
		}
	}, [url]);

	useEffect(() => {
		void check();
	}, [check, reloadKey]);

	if (probe === "down") {
		return (
			<div className="manager-tab manager-tab-down">
				<p>号池服务未启动</p>
				<p className="manager-tab-hint">
					在仓库根目录运行 <code>node apps/pool-server/dist/main.js</code>（默认 127.0.0.1:8790），
					或设置 OWL_MANAGER_URL 指向已部署的实例后刷新。
				</p>
				<button type="button" onClick={() => void check()}>
					<IconRefresh size={14} /> 重试
				</button>
			</div>
		);
	}

	return (
		<div className="manager-tab">
			<div className="manager-tab-bar">
				<span className={`manager-tab-status manager-tab-${probe}`}>
					{probe === "checking" ? "连接中…" : `运行 ${health?.uptimeSeconds ?? 0}s · DB ${health?.db ?? "?"}`}
				</span>
				<button type="button" title="重新加载" onClick={() => setReloadKey((key) => key + 1)}>
					<IconRefresh size={14} />
				</button>
			</div>
			{probe === "up" ? (
				<iframe key={reloadKey} src={url} title="owl 号池管理台" className="manager-tab-frame" />
			) : null}
		</div>
	);
}

function resolveManagerUrl(): string {
	// 桌面端构建注入的覆盖点；默认本机 pool-server
	try {
		const injected = (globalThis as Record<string, unknown>).OWL_MANAGER_URL;
		if (typeof injected === "string" && injected.length > 0) {
			return injected;
		}
	} catch {
		// 忽略
	}
	return DEFAULT_MANAGER_URL;
}
