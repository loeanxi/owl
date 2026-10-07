/**
 * 号池 Manager 面板（迁移阶段 6）—— owl 原生 React 面板，直连 pool-server REST。
 * 不走 iframe：跨源 fetch 由 pool-server 的 CORS 回显放行（凭据模式）。
 * 覆盖：健康状态、账号+一键签到、API Key（明文一次性）、模型上架、调用日志。
 */
import { useCallback, useEffect, useState } from "react";

const DEFAULT_MANAGER_URL = "http://127.0.0.1:8790";

const PLATFORMS = ["WORKBUDDY", "TRAE", "CODEX", "CURSOR", "COPILOT", "QODER", "ZCODE", "MIMO", "CLAUDE", "GEMINI", "GROK"];

interface AccountRow {
	id: string;
	name: string;
	platform: string;
	enabled: boolean;
	lastCheckInStatus?: string | null;
	lastCheckInMessage?: string | null;
}

interface KeyRow {
	id: string;
	name: string;
	keyPrefix: string;
	boundPlatform: string | null;
	enabled: boolean;
	revokedAt: number | null;
	rateLimitPerMinute: number | null;
}

interface ModelRow {
	id: string;
	publicId: string;
	published: boolean;
	contextWindow: number | null;
	maxOutputTokens: number | null;
	routes?: Array<{ platform: string; upstreamModel: string }>;
}

interface LogRow {
	occurredAt: number;
	model: string;
	platform: string | null;
	status: string;
	promptTokens: number | null;
	completionTokens: number | null;
	latencyMs: number | null;
	message: string | null;
}

type ViewKind = "accounts" | "keys" | "models" | "logs";

export function ManagerTab() {
	const [url] = useState(() => {
		const injected = (globalThis as Record<string, unknown>).OWL_MANAGER_URL;
		return typeof injected === "string" && injected.length > 0 ? injected : DEFAULT_MANAGER_URL;
	});
	const [probe, setProbe] = useState<"checking" | "up" | "down">("checking");
	const [view, setView] = useState<ViewKind>("accounts");
	const [accounts, setAccounts] = useState<AccountRow[]>([]);
	const [keys, setKeys] = useState<KeyRow[]>([]);
	const [models, setModels] = useState<ModelRow[]>([]);
	const [logs, setLogs] = useState<LogRow[]>([]);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const request = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
		const response = await fetch(`${url}${path}`, {
			method,
			credentials: "include",
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
		if (!response.ok || json.ok === false) {
			throw new Error(json.error ?? `HTTP ${response.status}`);
		}
		return (json.data ?? (json as unknown)) as T;
	}, [url]);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			if (view === "accounts") setAccounts(await request<AccountRow[]>("GET", "/api/accounts"));
			else if (view === "keys") setKeys(await request<KeyRow[]>("GET", "/api/keys"));
			else if (view === "models") setModels(await request<ModelRow[]>("GET", "/api/models"));
			else if (view === "logs") setLogs(await request<LogRow[]>("GET", "/api/gateway/logs?limit=50"));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [request, view]);

	// 探活；通过则拉当前视图
	useEffect(() => {
		let cancelled = false;
		setProbe("checking");
		fetch(`${url}/healthz`, { credentials: "include", signal: AbortSignal.timeout(3000) })
			.then((res) => {
				if (!res.ok) throw new Error(String(res.status));
				if (!cancelled) setProbe("up");
			})
			.catch(() => {
				if (!cancelled) setProbe("down");
			});
		return () => {
			cancelled = true;
		};
	}, [url]);

	useEffect(() => {
		if (probe === "up") void refresh();
	}, [probe, refresh]);

	const run = useCallback(async (action: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await action();
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [refresh]);

	if (probe !== "up") {
		return (
			<div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 8 }}>
				<p style={{ fontWeight: 600 }}>{probe === "checking" ? "连接号池服务中…" : "号池服务未启动"}</p>
				<p style={{ fontSize: 12, color: "#888" }}>
					在仓库根目录运行 <code>node apps/pool-server/dist/main.js</code>（默认 127.0.0.1:8790），
					或设置 OWL_MANAGER_URL 指向已部署实例。
				</p>
				<button
					type="button"
					style={{ alignSelf: "flex-start" }}
					onClick={() => {
						setProbe("checking");
						fetch(`${url}/healthz`, { credentials: "include" })
							.then((res) => setProbe(res.ok ? "up" : "down"))
							.catch(() => setProbe("down"));
					}}
				>
					重试
				</button>
			</div>
		);
	}

	const header = (cells: string[]) => (
		<tr>{cells.map((cell) => <th key={cell} style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #e5e5e5" }}>{cell}</th>)}</tr>
	);

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 13 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" }}>
				{(["accounts", "keys", "models", "logs"] as ViewKind[]).map((kind) => (
					<button key={kind} type="button" style={{ fontWeight: view === kind ? 700 : 400 }} onClick={() => setView(kind)}>
						{kind === "accounts" ? "账号" : kind === "keys" ? "API Key" : kind === "models" ? "模型" : "调用日志"}
					</button>
				))}
				<span style={{ flex: 1 }} />
				<span style={{ color: "#4caf7d", fontSize: 12 }}>● 号池运行中</span>
			</div>
			{error !== null && <div style={{ color: "#c0392b", padding: "4px 8px" }}>{error}</div>}
			<div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 8px 12px" }}>
				{view === "accounts" && (
					<>
						<div style={{ display: "flex", gap: 8, margin: "8px 0", flexWrap: "wrap", alignItems: "center" }}>
							<button
								type="button"
								disabled={busy}
								onClick={() => void run(async () => {
									const result = await request<{ success: number; already: number; failed: number }>("POST", "/api/checkin/all");
									alert(`签到完成：成功 ${result.success} / 已签 ${result.already} / 失败 ${result.failed}`);
								})}
							>
								一键签到
							</button>
							<AddAccountForm platforms={PLATFORMS} busy={busy} onCreate={(input) => void run(() => request("POST", "/api/accounts", input))} />
						</div>
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							{header(["名称", "平台", "状态", "最近签到", "操作"])}
							<tbody>
								{accounts.map((account) => (
									<tr key={account.id}>
										<td style={{ padding: "6px 8px" }}>{account.name}</td>
										<td style={{ padding: "6px 8px" }}>{account.platform}</td>
										<td style={{ padding: "6px 8px" }}>{account.enabled ? "启用" : "停用"}{account.lastCheckInStatus ? ` · ${account.lastCheckInStatus}` : ""}</td>
										<td style={{ padding: "6px 8px" }}>{account.lastCheckInMessage ?? "-"}</td>
										<td style={{ padding: "6px 8px" }}>
											<button type="button" disabled={busy} onClick={() => void run(() => request("PATCH", `/api/accounts/${account.id}/enabled?enabled=${!account.enabled}`))}>
												{account.enabled ? "停用" : "启用"}
											</button>{" "}
											<button type="button" disabled={busy} onClick={() => void run(() => request("DELETE", `/api/accounts/${account.id}`))}>删除</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}
				{view === "keys" && (
					<>
						<div style={{ margin: "8px 0" }}>
							<AddKeyForm platforms={PLATFORMS} busy={busy} onCreate={(input) => void run(async () => {
								const created = await request<{ plaintext: string }>("POST", "/api/keys", input);
								setNewKey(created.plaintext);
							})} />
						</div>
						{newKey !== null && (
							<div style={{ background: "#fff8e6", padding: 8, borderRadius: 6, marginBottom: 8 }}>
								Key 只显示一次，请立即保存：<code>{newKey}</code>
							</div>
						)}
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							{header(["名称", "前缀", "平台", "状态", "操作"])}
							<tbody>
								{keys.map((key) => (
									<tr key={key.id}>
										<td style={{ padding: "6px 8px" }}>{key.name}</td>
										<td style={{ padding: "6px 8px" }}>{key.keyPrefix}…</td>
										<td style={{ padding: "6px 8px" }}>{key.boundPlatform ?? "任意"}</td>
										<td style={{ padding: "6px 8px" }}>{key.enabled && key.revokedAt === null ? "启用" : "已吊销/停用"}</td>
										<td style={{ padding: "6px 8px" }}>
											<button type="button" disabled={busy} onClick={() => void run(() => request("DELETE", `/api/keys/${key.id}`))}>吊销</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}
				{view === "models" && (
					<table style={{ width: "100%", borderCollapse: "collapse" }}>
						{header(["公开 ID", "状态", "窗口", "输出上限", "路由"])}
						<tbody>
							{models.map((model) => (
								<tr key={model.id}>
									<td style={{ padding: "6px 8px" }}>{model.publicId}</td>
									<td style={{ padding: "6px 8px" }}>{model.published ? "已上架" : "未上架"}</td>
									<td style={{ padding: "6px 8px" }}>{model.contextWindow ?? "-"}</td>
									<td style={{ padding: "6px 8px" }}>{model.maxOutputTokens ?? "-"}</td>
									<td style={{ padding: "6px 8px" }}>{(model.routes ?? []).map((route) => `${route.platform}:${route.upstreamModel}`).join(", ") || "-"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{view === "logs" && (
					<table style={{ width: "100%", borderCollapse: "collapse" }}>
						{header(["时间", "模型", "平台", "状态", "tokens(P/C)", "耗时", "错误"])}
						<tbody>
							{logs.map((log, index) => (
								<tr key={index}>
									<td style={{ padding: "6px 8px" }}>{new Date(log.occurredAt).toLocaleString()}</td>
									<td style={{ padding: "6px 8px" }}>{log.model}</td>
									<td style={{ padding: "6px 8px" }}>{log.platform ?? "-"}</td>
									<td style={{ padding: "6px 8px" }}>{log.status}</td>
									<td style={{ padding: "6px 8px" }}>{log.promptTokens ?? "-"} / {log.completionTokens ?? "-"}</td>
									<td style={{ padding: "6px 8px" }}>{log.latencyMs ?? "-"}ms</td>
									<td style={{ padding: "6px 8px" }}>{log.message ?? "-"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}

interface AddAccountFormProps {
	platforms: string[];
	busy: boolean;
	onCreate: (input: { name: string; platform: string; credentials: Record<string, unknown> }) => void;
}

function AddAccountForm({ platforms, busy, onCreate }: AddAccountFormProps) {
	const [open, setOpen] = useState(false);
	if (!open) {
		return <button type="button" disabled={busy} onClick={() => setOpen(true)}>添加账号</button>;
	}
	return (
		<form
			style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
			onSubmit={(event) => {
				event.preventDefault();
				const data = new FormData(event.currentTarget);
				let credentials: Record<string, unknown> = {};
				try {
					credentials = JSON.parse(String(data.get("credentials")));
				} catch {
					alert("凭证必须是合法 JSON");
					return;
				}
				onCreate({ name: String(data.get("name")), platform: String(data.get("platform")), credentials });
				setOpen(false);
			}}
		>
			<input name="name" placeholder="名称" required />
			<select name="platform">{platforms.map((p) => <option key={p}>{p}</option>)}</select>
			<input name="credentials" placeholder='{"apiKey":"…"}' required style={{ minWidth: 220 }} />
			<button type="submit" disabled={busy}>保存</button>
			<button type="button" onClick={() => setOpen(false)}>取消</button>
		</form>
	);
}

interface AddKeyFormProps {
	platforms: string[];
	busy: boolean;
	onCreate: (input: { name: string; boundPlatform: string | null; allowedIps: string | null }) => void;
}

function AddKeyForm({ platforms, busy, onCreate }: AddKeyFormProps) {
	const [open, setOpen] = useState(false);
	if (!open) {
		return <button type="button" disabled={busy} onClick={() => setOpen(true)}>创建 Key</button>;
	}
	return (
		<form
			style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
			onSubmit={(event) => {
				event.preventDefault();
				const data = new FormData(event.currentTarget);
				onCreate({
					name: String(data.get("name")),
					boundPlatform: String(data.get("boundPlatform")) || null,
					allowedIps: String(data.get("allowedIps")) || null,
				});
				setOpen(false);
			}}
		>
			<input name="name" placeholder="名称" required />
			<select name="boundPlatform"><option value="">任意平台</option>{platforms.map((p) => <option key={p}>{p}</option>)}</select>
			<input name="allowedIps" placeholder="允许 IP（可空）" />
			<button type="submit" disabled={busy}>创建</button>
			<button type="button" onClick={() => setOpen(false)}>取消</button>
		</form>
	);
}
