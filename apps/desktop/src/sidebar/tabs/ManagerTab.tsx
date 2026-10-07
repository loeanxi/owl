/**
 * 号池 Manager 面板（迁移阶段 6）—— owl 原生 React 面板，直连 pool-server REST。
 * 内嵌登录流程：401 时自动显示登录/首次设置表单，登录后 cookie 自动携带。
 * 功能：健康状态、账号+一键签到、API Key（明文一次性）、模型列表、调用日志。
 */
import { useCallback, useEffect, useState } from "react";

const DEFAULT_URL = "http://127.0.0.1:8790";
const PLATFORMS = ["WORKBUDDY", "TRAE", "CODEX", "CURSOR", "COPILOT", "QODER", "ZCODE", "MIMO", "CLAUDE", "GEMINI", "GROK"];

interface AccountRow { id: string; name: string; platform: string; enabled: boolean; lastCheckInStatus?: string | null; lastCheckInMessage?: string | null; }
interface KeyRow { id: string; name: string; keyPrefix: string; enabled: boolean; revokedAt: number | null; }
interface ModelRow { id: string; publicId: string; published: boolean; contextWindow: number | null; maxOutputTokens: number | null; }
interface LogRow { occurredAt: number; model: string; platform: string | null; status: string; promptTokens: number | null; completionTokens: number | null; latencyMs: number | null; message: string | null; }
type ViewKind = "accounts" | "keys" | "models" | "logs";
type AuthState = "checking" | "ok" | "login" | "setup";

const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #ddd", fontSize: 12, color: "#666" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee", fontSize: 13 };
const input: React.CSSProperties = { padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4, fontSize: 13 };
const btn: React.CSSProperties = { padding: "5px 14px", border: "1px solid #ccc", borderRadius: 4, cursor: "pointer", fontSize: 13 };
const btnP: React.CSSProperties = { ...btn, background: "#2f6fde", color: "#fff", borderColor: "#2f6fde" };

export function ManagerTab() {
	const [baseUrl] = useState(() => {
		const injected = (globalThis as Record<string, unknown>).OWL_MANAGER_URL;
		return typeof injected === "string" && injected.length > 0 ? injected : DEFAULT_URL;
	});
	const [auth, setAuth] = useState<AuthState>("checking");
	const [view, setView] = useState<ViewKind>("accounts");
	const [accounts, setAccounts] = useState<AccountRow[]>([]);
	const [keys, setKeys] = useState<KeyRow[]>([]);
	const [models, setModels] = useState<ModelRow[]>([]);
	const [logs, setLogs] = useState<LogRow[]>([]);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [msg, setMsg] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const request = useCallback(async (method: string, path: string, body?: unknown): Promise<unknown> => {
		const res = await fetch(`${baseUrl}${path}`, {
			method,
			credentials: "include",
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok || json.ok === false) {
			if (res.status === 401) { setAuth("login"); }
			throw new Error(String(json.error ?? json.code ?? `HTTP ${res.status}`));
		}
		return json.data ?? json;
	}, [baseUrl]);

	const refresh = useCallback(async () => {
		try {
			if (view === "accounts") setAccounts((await request("GET", "/api/accounts")) as AccountRow[]);
			else if (view === "keys") setKeys((await request("GET", "/api/keys")) as KeyRow[]);
			else if (view === "models") setModels((await request("GET", "/api/models")) as ModelRow[]);
			else if (view === "logs") setLogs((await request("GET", "/api/gateway/logs?limit=50")) as LogRow[]);
			setAuth("ok");
		} catch { /* 401 已由 request 设 auth=login */ }
	}, [request, view]);

	useEffect(() => { void refresh(); }, [refresh]);

	const run = useCallback(async (action: () => Promise<unknown>) => {
		setBusy(true);
		try { await action(); await refresh(); }
		catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	}, [refresh]);

	if (auth === "login" || auth === "setup") {
		return <LoginForm baseUrl={baseUrl} isSetup={auth === "setup"} onDone={() => { setAuth("ok"); void refresh(); }} />;
	}
	if (auth === "checking") {
		return <div style={{ padding: 40, color: "#888" }}>连接号池服务…</div>;
	}

	const tabs: Array<[ViewKind, string]> = [["accounts", "账号"], ["keys", "API Key"], ["models", "模型"], ["logs", "日志"]];
	const th = { textAlign: "left" as const, padding: "6px 8px", borderBottom: "1px solid #ddd", fontSize: 12, color: "#666" };
	const td = { padding: "6px 8px", borderBottom: "1px solid #eee", fontSize: 13 };

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 13 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" }}>
				{tabs.map(([k, label]) => (
					<button key={k} type="button" style={{ ...btn, border: "none", fontWeight: view === k ? 700 : 400, background: "none" }} onClick={() => setView(k)}>{label}</button>
				))}
				<span style={{ flex: 1 }} />
				<span style={{ color: "#4caf7d", fontSize: 12 }}>● 号池</span>
			</div>
			{msg && <div style={{ color: "#c0392b", padding: "4px 8px", fontSize: 12 }}>{msg}</div>}
			<div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 8px 12px" }}>
				{view === "accounts" && (
					<div>
						<div style={{ display: "flex", gap: 8, margin: "8px 0", flexWrap: "wrap", alignItems: "center" }}>
							<button type="button" style={btnP} disabled={busy} onClick={() => void run(async () => {
								const r = (await request("POST", "/api/checkin/all")) as { success: number; already: number; failed: number };
								alert(`签到：成功${r.success} 已签${r.already} 失败${r.failed}`);
							})}>一键签到</button>
							<AddAccount onDone={(d) => void run(() => request("POST", "/api/accounts", d))} />
						</div>
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							<thead><tr>{["名称","平台","状态","最近签到","操作"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
							<tbody>{accounts.map(a => (
								<tr key={a.id}>
									<td style={td}>{a.name}</td><td style={td}>{a.platform}</td>
									<td style={td}>{a.enabled ? "✓" : "✗"}{a.lastCheckInStatus ? ` ${a.lastCheckInStatus}` : ""}</td>
									<td style={td}>{a.lastCheckInMessage ?? "-"}</td>
									<td style={td}>
										<button type="button" style={btn} disabled={busy} onClick={() => void run(() => request("PATCH", `/api/accounts/${a.id}/enabled?enabled=${!a.enabled}`))}>{a.enabled ? "停" : "启"}</button>{" "}
										<button type="button" style={btn} disabled={busy} onClick={() => void run(() => request("DELETE", `/api/accounts/${a.id}`))}>删</button>
									</td>
								</tr>
							))}</tbody>
						</table>
					</div>
				)}
				{view === "keys" && (
					<div>
						<div style={{ margin: "8px 0" }}>
							<AddKey onDone={(plaintext) => { setNewKey(plaintext); void run(async () => {}); }} />
						</div>
						{newKey && <div style={{ background: "#fff8e6", padding: 8, borderRadius: 6, marginBottom: 8 }}>Key 只显示一次：<code>{newKey}</code></div>}
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							<thead><tr>{["名称","前缀","状态","操作"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
							<tbody>{keys.map(k => (
								<tr key={k.id}>
									<td style={td}>{k.name}</td><td style={td}>{k.keyPrefix}…</td>
									<td style={td}>{k.enabled && !k.revokedAt ? "✓" : "✗"}</td>
									<td style={td}><button type="button" style={btn} disabled={busy} onClick={() => void run(() => request("DELETE", `/api/keys/${k.id}`))}>吊销</button></td>
								</tr>
							))}</tbody>
						</table>
					</div>
				)}
				{view === "models" && (
					<table style={{ width: "100%", borderCollapse: "collapse" }}>
						<thead><tr>{["公开 ID","状态","窗口","输出上限"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
						<tbody>{models.map(m => (
							<tr key={m.id}>
								<td style={td}>{m.publicId}</td><td style={td}>{m.published ? "✓" : "✗"}</td>
								<td style={td}>{m.contextWindow ?? "-"}</td><td style={td}>{m.maxOutputTokens ?? "-"}</td>
							</tr>
						))}</tbody>
					</table>
				)}
				{view === "logs" && (
					<table style={{ width: "100%", borderCollapse: "collapse" }}>
						<thead><tr>{["时间","模型","平台","状态","tokens","耗时"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
						<tbody>{logs.map((l, i) => (
							<tr key={i}>
								<td style={td}>{new Date(l.occurredAt).toLocaleString()}</td><td style={td}>{l.model}</td>
								<td style={td}>{l.platform ?? "-"}</td><td style={td}>{l.status}</td>
								<td style={td}>{l.promptTokens ?? "-"} / {l.completionTokens ?? "-"}</td><td style={td}>{l.latencyMs ?? "-"}ms</td>
							</tr>
						))}</tbody>
					</table>
				)}
			</div>
		</div>
	);
}

function LoginForm({ baseUrl, isSetup, onDone }: { baseUrl: string; isSetup: boolean; onDone: () => void }) {
	const [username, setUsername] = useState("admin");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErr(""); setBusy(true);
		try {
			const payload: Record<string, unknown> = { username, password };
			if (isSetup) payload.confirmPassword = confirm;
			const res = await fetch(`${baseUrl}/api/admin/${isSetup ? "setup" : "login"}`, {
				method: "POST", credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			if (!res.ok || json.ok === false) throw new Error(String(json.error ?? `HTTP ${res.status}`));
			onDone();
		} catch (error) { setErr(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	};
	return (
		<div style={{ maxWidth: 340, margin: "40px auto", padding: 20 }}>
			<h3 style={{ margin: "0 0 12px" }}>{isSetup ? "首次设置" : "登录号池"}</h3>
			<form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
				<input style={input} placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} required />
				<input style={input} type="password" placeholder="口令（8位以上含字母+数字）" value={password} onChange={e => setPassword(e.target.value)} required />
				{isSetup && <input style={input} type="password" placeholder="确认口令" value={confirm} onChange={e => setConfirm(e.target.value)} required />}
				<button type="submit" style={btnP} disabled={busy}>{busy ? "…" : isSetup ? "设置并进入" : "登录"}</button>
				{err && <span style={{ color: "#c0392b", fontSize: 12 }}>{err}</span>}
			</form>
		</div>
	);
}

function AddAccount({ onDone }: { onDone: (d: Record<string, unknown>) => void }) {
	const [open, setOpen] = useState(false);
	if (!open) return <button type="button" style={btn} onClick={() => setOpen(true)}>添加账号</button>;
	return (
		<form style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} onSubmit={e => {
			e.preventDefault();
			const d = new FormData(e.currentTarget);
			let cred = {};
			try { cred = JSON.parse(String(d.get("credentials"))); } catch { alert("凭证必须是合法 JSON"); return; }
			onDone({ name: String(d.get("name")), platform: String(d.get("platform")), credentials: cred });
			setOpen(false);
		}}>
			<input style={input} placeholder="名称" name="name" required />
			<select style={input} name="platform">{PLATFORMS.map(p => <option key={p}>{p}</option>)}</select>
			<input style={{ ...input, minWidth: 200 }} placeholder='{"apiKey":"…"}' name="credentials" required />
			<button type="submit" style={btnP}>保存</button>
			<button type="button" style={btn} onClick={() => setOpen(false)}>取消</button>
		</form>
	);
}

function AddKey({ onDone }: { onDone: (plaintext: string) => void }) {
	const [open, setOpen] = useState(false);
	if (!open) return <button type="button" style={btnP} onClick={() => setOpen(true)}>创建 Key</button>;
	return (
		<form style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} onSubmit={e => {
			e.preventDefault();
			const d = new FormData(e.currentTarget);
			fetch("/api/keys", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: String(d.get("name")), boundPlatform: String(d.get("platform")) || null }) })
				.then(res => res.json()).then(json => { onDone(json.data.plaintext); setOpen(false); })
				.catch(err => alert(err.message));
		}}>
			<input style={input} placeholder="名称" name="name" required />
			<select style={input} name="platform"><option value="">任意平台</option>{PLATFORMS.map(p => <option key={p}>{p}</option>)}</select>
			<button type="submit" style={btnP}>创建</button>
			<button type="button" style={btn} onClick={() => setOpen(false)}>取消</button>
		</form>
	);
}
