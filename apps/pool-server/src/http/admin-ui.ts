/**
 * 管理台单页（迁移阶段 6）：pool-server 直接伺服的零依赖 SPA。
 * 覆盖：登录/首次设置、账号+签到、API Key、模型目录、费率、调用日志、备份/割接。
 * cookie 会话由 /api/admin/* 维护，页面全部走同源 fetch。
 */

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>owl 号池管理台</title>
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; background: #f6f7f9; color: #1c1e21; }
	header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e3e5e8; position: sticky; top: 0; z-index: 5; }
	header h1 { font-size: 15px; margin: 0 auto 0 0; }
	header .dot { width: 8px; height: 8px; border-radius: 50%; background: #bbb; }
	header .dot.up { background: #35a05f; } header .dot.down { background: #d0533f; }
	button { font: inherit; padding: 5px 12px; border: 1px solid #c9ccd1; border-radius: 6px; background: #fff; cursor: pointer; }
	button.primary { background: #2f6fde; border-color: #2f6fde; color: #fff; }
	button.danger { color: #c0392b; border-color: #d8a09a; }
	button:hover { filter: brightness(0.97); }
	input, select, textarea { font: inherit; padding: 5px 8px; border: 1px solid #c9ccd1; border-radius: 6px; }
	nav { display: flex; gap: 4px; padding: 8px 16px 0; flex-wrap: wrap; }
	nav button { border: none; background: none; padding: 6px 12px; border-radius: 6px 6px 0 0; color: #555; }
	nav button.active { background: #fff; border: 1px solid #e3e5e8; border-bottom-color: #fff; color: #111; font-weight: 600; }
	main { margin: 0 16px 24px; background: #fff; border: 1px solid #e3e5e8; border-radius: 0 8px 8px 8px; padding: 16px; min-height: 300px; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f2; font-size: 13px; word-break: break-all; }
	th { color: #666; font-weight: 600; }
	.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
	.muted { color: #888; font-size: 12px; }
	.ok { color: #1e8e4e; } .bad { color: #c0392b; } .warn { color: #b8860b; }
	.card { border: 1px solid #eef0f2; border-radius: 8px; padding: 12px; margin: 10px 0; }
	form.inline { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); align-items: end; }
	label { display: grid; gap: 4px; font-size: 12px; color: #555; }
	#auth { max-width: 420px; margin: 60px auto; text-align: center; }
	#auth .card { text-align: left; }
	pre { background: #f2f3f5; padding: 8px; border-radius: 6px; overflow: auto; font-size: 12px; }
</style>
</head>
<body>
<header>
	<h1>owl 号池管理台</h1>
	<span class="dot" id="dot"></span><span class="muted" id="health">检测中…</span>
	<span style="flex:1"></span>
	<span class="muted" id="who"></span>
	<button id="logout" style="display:none" onclick="logout()">退出</button>
</header>
<div id="auth" style="display:none">
	<div class="card">
		<h3 id="authTitle">登录</h3>
		<div class="card" style="background:#fff8e6" id="setupHint" hidden>首次使用：设置管理员用户名与口令</div>
		<form class="inline" style="grid-template-columns:1fr" onsubmit="return doAuth(event)">
			<label>用户名<input id="f-user" value="admin" autocomplete="username"></label>
			<label>口令<input id="f-pass" type="password" autocomplete="current-password"></label>
			<label id="f-confirm-label" hidden>确认口令<input id="f-confirm" type="password"></label>
			<label id="f-token-label" hidden>初始化令牌（远程首次设置时必填）<input id="f-token"></label>
			<button class="primary" id="authBtn" type="submit">登录</button>
		</form>
		<p class="bad" id="authErr"></p>
	</div>
</div>
<div id="app" style="display:none">
	<nav id="tabs"></nav>
	<main id="view">加载中…</main>
</div>
<script>
const $ = (id) => document.getElementById(id);
const api = async (method, path, body) => {
	const res = await fetch(path, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || json.ok === false) throw new Error(json.error || json.code || ("HTTP " + res.status));
	return json.data !== undefined ? json.data : json;
};
const esc = (text) => String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
let authed = false, setupRequired = false, view = "accounts";

async function refreshHealth() {
	try {
		const res = await fetch("/healthz");
		const h = await res.json();
		$("dot").className = "dot up";
		$("health").textContent = "运行 " + h.uptimeSeconds + "s · DB " + h.db;
	} catch {
		$("dot").className = "dot down";
		$("health").textContent = "离线";
	}
}

async function refreshSession() {
	const s = await api("GET", "/api/admin/session");
	setupRequired = s.setupRequired;
	authed = s.authenticated;
	$("auth").style.display = authed || setupRequired ? "none" : "none";
	$("app").style.display = authed ? "" : "none";
	$("logout").style.display = authed ? "" : "none";
	$("who").textContent = authed ? s.username : "";
	if (!s.enabled) { $("auth").style.display = ""; $("authTitle").textContent = "管理端鉴权未启用（仅本机可访问）"; $("authBtn").style.display = "none"; return; }
	if (!authed) {
		$("auth").style.display = "";
		$("authTitle").textContent = setupRequired ? "首次设置" : "登录";
		$("authBtn").textContent = setupRequired ? "完成设置并进入" : "登录";
		$("f-confirm-label").hidden = !setupRequired;
		$("f-token-label").hidden = !(setupRequired && s.setupTokenRequired);
		$("setupHint").hidden = !setupRequired;
	}
	return authed;
}

async function doAuth(event) {
	event.preventDefault();
	$("authErr").textContent = "";
	try {
		if (setupRequired) {
			await api("POST", "/api/admin/setup", {
				username: $("f-user").value, password: $("f-pass").value,
				confirmPassword: $("f-confirm").value, setupToken: $("f-token").value || undefined,
			});
		} else {
			await api("POST", "/api/admin/login", { username: $("f-user").value, password: $("f-pass").value });
		}
		await boot();
	} catch (err) { $("authErr").textContent = err.message; }
	return false;
}

async function logout() { await api("POST", "/api/admin/logout"); location.reload(); }

const TABS = [
	["accounts", "账号"], ["keys", "API Key"], ["models", "模型"], ["rates", "费率"],
	["logs", "调用日志"], ["backups", "备份/割接"],
];

async function boot() {
	await refreshHealth();
	const ok = await refreshSession();
	if (!ok) return;
	$("tabs").innerHTML = TABS.map(([id, label]) => '<button data-v="' + id + '" class="' + (view === id ? "active" : "") + '">' + label + "</button>").join("");
	$("tabs").querySelectorAll("button").forEach((btn) => (btn.onclick = () => { view = btn.dataset.v; boot(); }));
	render();
}

async function render() {
	const el = $("view");
	el.textContent = "加载中…";
	try {
		if (view === "accounts") return await renderAccounts(el);
		if (view === "keys") return await renderKeys(el);
		if (view === "models") return await renderModels(el);
		if (view === "rates") return await renderRates(el);
		if (view === "logs") return await renderLogs(el);
		if (view === "backups") return await renderBackups(el);
	} catch (err) { el.innerHTML = '<p class="bad">' + esc(err.message) + "</p>"; }
}

async function renderAccounts(el) {
	const accounts = await api("GET", "/api/accounts");
	el.innerHTML = '<div class="row"><button class="primary" onclick="checkinAll()">一键签到</button><span class="muted">仅签到类平台（WorkBuddy/Trae 等）</span></div>'
		+ '<form class="inline" onsubmit="return addAccount(event)">'
		+ '<label>名称<input name="name" required></label>'
		+ '<label>平台<select name="platform">' + ["WORKBUDDY","TRAE","CODEX","CURSOR","COPILOT","QODER","ZCODE","MIMO","CLAUDE","GEMINI","GROK"].map((p) => "<option>" + p + "</option>").join("") + "</select></label>"
		+ '<label style="grid-column:span 2">凭证 JSON<input name="credentials" placeholder='{"apiKey":"…"} 或 {"accessToken":"…"} 或 {"session":"…"}' required></label>'
		+ '<button class="primary">添加账号</button></form>'
		+ '<table><tr><th>名称</th><th>平台</th><th>状态</th><th>最近签到</th><th>操作</th></tr>'
		+ accounts.map((a) => "<tr><td>" + esc(a.name) + "</td><td>" + esc(a.platform) + "</td><td>"
			+ (a.enabled ? '<span class="ok">启用</span>' : '<span class="bad">停用</span>')
			+ (a.lastCheckInStatus ? " · " + esc(a.lastCheckInStatus) : "") + "</td><td>"
			+ esc(a.lastCheckInMessage || "-") + "</td><td>"
			+ '<button onclick="toggleAccount(\\'' + a.id + "'," + !a.enabled + ')">' + (a.enabled ? "停用" : "启用") + "</button> "
			+ '<button onclick="delAccount(\\'' + a.id + '')">删除</button></td></tr>').join("")
		+ "</table>";
}
window.addAccount = async (event) => {
	event.preventDefault();
	const form = event.target;
	let credentials = {};
	try { credentials = JSON.parse(form.credentials.value); } catch { alert("凭证必须是合法 JSON"); return false; }
	await api("POST", "/api/accounts", { name: form.name.value, platform: form.platform.value, credentials });
	render(); return false;
};
window.toggleAccount = async (id, enabled) => { await api("PATCH", "/api/accounts/" + id + "/enabled?enabled=" + enabled); render(); };
window.delAccount = async (id) => { if (confirm("删除该账号？")) { await api("DELETE", "/api/accounts/" + id); render(); } };
window.checkinAll = async () => {
	try { const r = await api("POST", "/api/checkin/all"); alert("签到完成：成功 " + r.success + " / 已签 " + r.already + " / 失败 " + r.failed); render(); }
	catch (err) { alert(err.message); }
};

async function renderKeys(el) {
	const keys = await api("GET", "/api/keys");
	el.innerHTML = '<form class="inline" onsubmit="return addKey(event)">'
		+ '<label>名称<input name="name" required></label>'
		+ '<label>绑定平台（可空）<select name="boundPlatform"><option value="">任意</option>' + ["WORKBUDDY","TRAE","CODEX","CURSOR","COPILOT","QODER","ZCODE","MIMO","CLAUDE","GEMINI","GROK"].map((p) => "<option>" + p + "</option>").join("") + "</select></label>"
		+ '<label>允许来源 IP（可空）<input name="allowedIps" placeholder="10.0.0.0/24 或 *"></label>'
		+ '<button class="primary">创建 Key</button></form><div id="newkey"></div>'
		+ '<table><tr><th>名称</th><th>前缀</th><th>平台</th><th>状态</th><th>限流/分</th><th>操作</th></tr>'
		+ keys.map((k) => "<tr><td>" + esc(k.name) + "</td><td>" + esc(k.keyPrefix) + "…</td><td>" + esc(k.boundPlatform || "任意") + "</td><td>"
			+ (k.enabled && !k.revokedAt ? '<span class="ok">启用</span>' : '<span class="bad">' + (k.revokedAt ? "已吊销" : "停用") + "</span>")
			+ "</td><td>" + (k.rateLimitPerMinute ?? "不限") + "</td><td>"
			+ '<button onclick="revokeKey(\\'' + k.id + '\\')">吊销</button> '
			+ '<button class="danger" onclick="delKey(\\'' + k.id + '\\')">删除</button></td></tr>').join("")
		+ "</table>";
}
window.addKey = async (event) => {
	event.preventDefault();
	const form = event.target;
	const created = await api("POST", "/api/keys", { name: form.name.value, boundPlatform: form.boundPlatform.value || null, allowedIps: form.allowedIps.value || null });
	$("newkey").innerHTML = '<div class="card ok">Key 只显示一次，请立即保存：<pre>' + esc(created.plaintext) + "</pre></div>";
	render();
	return false;
};
window.revokeKey = async (id) => { if (confirm("吊销该 Key？")) { await api("DELETE", "/api/keys/" + id); render(); } };
window.delKey = async (id) => { if (confirm("物理删除该 Key？调用日志保留。")) { await api("DELETE", "/api/keys/" + id + "/permanent"); render(); } };

async function renderModels(el) {
	const models = await api("GET", "/api/models");
	el.innerHTML = models.map((m) => '<div class="card"><b>' + esc(m.publicId) + "</b> " + (m.published ? '<span class="ok">已上架</span>' : '<span class="warn">未上架</span>')
		+ " · 窗口 " + (m.contextWindow ?? "-") + " · 输出上限 " + (m.maxOutputTokens ?? "-")
		+ " · 档位 " + esc((m.reasoningEfforts || []).join("/"))
		+ ' <button onclick="toggleModel(\\'' + m.id + "'," + !m.published + ')">' + (m.published ? "下架" : "上架") + "</button>"
		+ '<div class="muted">路由：' + esc((m.routes || []).map((r) => r.platform + ":" + r.upstreamModel).join(", ") || "无") + "</div></div>").join("")
		+ '<form class="inline" onsubmit="return addModel(event)">'
		+ '<label>公开模型 ID<input name="publicId" required placeholder="my-model"></label>'
		+ '<label>名称<input name="name"></label>'
		+ '<label>上下文窗口<input name="contextWindow" type="number"></label>'
		+ '<label>输出上限<input name="maxOutputTokens" type="number"></label>'
		+ '<label>档位（逗号分隔）<input name="efforts" placeholder="low,medium,high"></label>'
		+ '<label style="grid-column:span 2">路由（JSON 数组）<input name="routes" placeholder='[{"platform":"ZCODE","upstreamModel":"glm-5","priority":0,"reasoningEfforts":["low","high"]}]" required></label>'
		+ '<label><input type="checkbox" name="published" checked> 立即上架</label>'
		+ '<button class="primary">创建模型</button></form>';
}
window.toggleModel = async (id, published) => { await api("PATCH", "/api/models/" + id + "/published?published=" + published); render(); };
window.addModel = async (event) => {
	event.preventDefault();
	const form = event.target;
	let routes = [];
	try { routes = JSON.parse(form.routes.value || "[]"); } catch { alert("路由 JSON 不合法"); return false; }
	await api("POST", "/api/models", {
		publicId: form.publicId.value, name: form.name.value || form.publicId.value,
		contextWindow: Number(form.contextWindow.value) || null,
		maxOutputTokens: Number(form.maxOutputTokens.value) || null,
		reasoningEfforts: form.efforts.value ? form.efforts.value.split(",").map((s) => s.trim()).filter(Boolean) : [],
		published: form.published.checked, routes,
	});
	render(); return false;
};

async function renderRates(el) {
	const rates = await api("GET", "/api/billing/rates");
	el.innerHTML = '<p class="muted">单价单位：分 / 1M token（人民币）。仅归属成员的 Key 参与扣费。</p>'
		+ '<table><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>状态</th></tr>'
		+ rates.map((r) => "<tr><td>" + esc(r.model) + "</td><td>" + r.promptPer1m + "</td><td>" + r.completionPer1m + "</td><td>" + r.cacheReadPer1m + "</td><td>" + r.cacheWritePer1m + "</td><td>"
			+ (r.enabled ? '<span class="ok">启用</span>' : '<span class="warn">停用</span>') + "</td></tr>").join("")
		+ "</table>"
		+ '<form class="inline" onsubmit="return addRate(event)">'
		+ '<label>模型（含路由前缀）<input name="model" required placeholder="star-lm"></label>'
		+ '<label>输入<input name="prompt" type="number" required></label>'
		+ '<label>输出<input name="completion" type="number" required></label>'
		+ '<label>缓存读<input name="cacheRead" type="number" value="0"></label>'
		+ '<label>缓存写<input name="cacheWrite" type="number" value="0"></label>'
		+ '<button class="primary">保存费率</button></form>';
}
window.addRate = async (event) => {
	event.preventDefault();
	const form = event.target;
	await api("POST", "/api/billing/rates", {
		model: form.model.value, promptPer1m: Number(form.prompt.value), completionPer1m: Number(form.completion.value),
		cacheReadPer1m: Number(form.cacheRead.value), cacheWritePer1m: Number(form.cacheWrite.value), enabled: true,
	});
	render(); return false;
};

async function renderLogs(el) {
	const logs = await api("GET", "/api/gateway/logs?limit=50");
	el.innerHTML = '<table><tr><th>时间</th><th>模型</th><th>平台</th><th>状态</th><th>tokens(P/C)</th><th>耗时</th><th>错误</th></tr>'
		+ logs.map((l) => "<tr><td>" + new Date(l.occurredAt).toLocaleString() + "</td><td>" + esc(l.model) + "</td><td>" + esc(l.platform || "-") + "</td><td>"
			+ (l.status === "OK" ? '<span class="ok">OK</span>' : '<span class="bad">' + esc(l.status) + "</span>") + "</td><td>"
			+ (l.promptTokens ?? "-") + " / " + (l.completionTokens ?? "-") + "</td><td>" + (l.latencyMs ?? "-") + "ms</td><td>"
			+ esc(l.message || l.errorCategory || "-") + "</td></tr>").join("")
		+ "</table>";
}

async function renderBackups(el) {
	const list = await api("GET", "/api/backups/list");
	el.innerHTML = '<div class="card"><b>创建快照</b><div class="row"><button class="primary" onclick="snapshot()">立即快照（全部表 → zip）</button><span id="snapmsg" class="muted"></span></div></div>'
		+ '<div class="card"><b>从 manager 备份导入（数据割接）</b>'
		+ '<form class="inline" onsubmit="return doImport(event)">'
		+ '<label style="grid-column:span 2">manager 备份目录（内含每表 .jsonl）<input name="dir" required placeholder="D:/manager/backups/manager-xxx"></label>'
		+ '<label><input type="checkbox" name="force"> 目标表非空时强制覆盖</label>'
		+ '<button class="primary">导入</button></form></div>'
		+ '<div class="card"><b>已有快照</b><ul>' + (list.length ? list.map((f) => "<li>" + esc(f) + "</li>").join("") : "<li class='muted'>暂无</li>") + "</ul></div>";
}
window.snapshot = async () => {
	const r = await api("POST", "/api/backups/snapshot");
	$("snapmsg").textContent = "已生成 " + r.file + "（" + r.sha256.slice(0, 12) + "…）";
};
window.doImport = async (event) => {
	event.preventDefault();
	const form = event.target;
	if (!confirm("导入会覆盖 owl 当前数据（默认非空表拒绝）。继续？")) return false;
	try {
		const r = await api("POST", "/api/backups/import-manager", { dir: form.dir.value, force: form.force.checked });
		alert("导入完成：\n" + r.imported.map((row) => row.table + ": " + row.rows + " 行").join("\n"));
		render();
	} catch (err) { alert(err.message); }
	return false;
};

refreshHealth();
setInterval(refreshHealth, 30000);
boot().catch((err) => { $("authErr").textContent = err.message; $("auth").style.display = ""; });
</script>
</body>
</html>`;

export function adminHtml(): string {
	return ADMIN_HTML;
}
