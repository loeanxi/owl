/**
 * 管理台单页（迁移阶段 6）：pool-server 直接伺服的零依赖 SPA。
 * 覆盖：登录/首次设置、账号+签到、API Key、模型目录、费率、调用日志、备份/割接。
 * cookie 会话由 /api/admin/* 维护，页面全部走同源 fetch。
 *
 * 实现约束：事件一律用 data-act/data-form 委托，禁止内联 onclick 字符串拼接
 * （引号转义曾导致整段脚本解析失败——白屏根因）。
 */

const ADMIN_HTML = String.raw`<!DOCTYPE html>
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
	input, select { font: inherit; padding: 5px 8px; border: 1px solid #c9ccd1; border-radius: 6px; }
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
</style>
</head>
<body>
<header>
	<h1>owl 号池管理台</h1>
	<span class="dot" id="dot"></span><span class="muted" id="health">检测中…</span>
	<span style="flex:1"></span>
	<span class="muted" id="who"></span>
	<button id="logout" style="display:none" data-act="logout">退出</button>
</header>
<div id="auth" style="display:none">
	<div class="card">
		<h3 id="authTitle">登录</h3>
		<div class="card" style="background:#fff8e6" id="setupHint" hidden>首次使用：设置管理员用户名与口令</div>
		<form class="inline" style="grid-template-columns:1fr" data-form="auth">
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
"use strict";
var $ = function (id) { return document.getElementById(id); };
function api(method, path, body) {
	return fetch(path, {
		method: method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}).then(function (res) {
		return res.json().catch(function () { return {}; }).then(function (json) {
			if (!res.ok || json.ok === false) throw new Error(json.error || json.code || ("HTTP " + res.status));
			return json.data !== undefined ? json.data : json;
		});
	});
}
function esc(text) {
	return String(text === null || text === undefined ? "" : text).replace(/[&<>"]/g, function (ch) {
		return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
	});
}
var authed = false, setupRequired = false, view = "accounts";

function refreshHealth() {
	return fetch("/healthz").then(function (res) { return res.json(); }).then(function (h) {
		$("dot").className = "dot up";
		$("health").textContent = "运行 " + h.uptimeSeconds + "s · DB " + h.db;
	}).catch(function () {
		$("dot").className = "dot down";
		$("health").textContent = "离线";
	});
}

function refreshSession() {
	return api("GET", "/api/admin/session").then(function (s) {
		setupRequired = s.setupRequired === true;
		authed = s.authenticated === true;
		$("app").style.display = authed ? "" : "none";
		$("logout").style.display = authed ? "" : "none";
		$("who").textContent = authed ? String(s.username || "") : "";
		if (!s.enabled) {
			$("auth").style.display = "";
			$("authTitle").textContent = "管理端鉴权未启用（仅本机可访问）";
			$("authBtn").style.display = "none";
			return false;
		}
		if (!authed) {
			$("auth").style.display = "";
			$("authTitle").textContent = setupRequired ? "首次设置" : "登录";
			$("authBtn").textContent = setupRequired ? "完成设置并进入" : "登录";
			$("f-confirm-label").hidden = !setupRequired;
			$("f-token-label").hidden = !(setupRequired && s.setupTokenRequired);
			$("setupHint").hidden = !setupRequired;
		}
		return authed;
	});
}

function submitAuth() {
	$("authErr").textContent = "";
	var payload = { username: $("f-user").value, password: $("f-pass").value };
	var call;
	if (setupRequired) {
		payload.confirmPassword = $("f-confirm").value;
		payload.setupToken = $("f-token").value || undefined;
		call = api("POST", "/api/admin/setup", payload);
	} else {
		call = api("POST", "/api/admin/login", payload);
	}
	return call.then(function () { return boot(); }).catch(function (err) {
		$("authErr").textContent = err.message;
	});
}

function logout() {
	api("POST", "/api/admin/logout").then(function () { location.reload(); });
}

var TABS = [["accounts", "账号"], ["keys", "API Key"], ["models", "模型"], ["rates", "费率"], ["logs", "调用日志"], ["backups", "备份/割接"]];

function boot() {
	return refreshHealth().then(function () {
		return refreshSession();
	}).then(function (ok) {
		if (!ok) return null;
		$("tabs").innerHTML = TABS.map(function (tab) {
			return '<button data-view="' + tab[0] + '" class="' + (view === tab[0] ? "active" : "") + '">' + tab[1] + "</button>";
		}).join("");
		return render();
	});
}

function render() {
	var el = $("view");
	el.textContent = "加载中…";
	var call = null;
	if (view === "accounts") call = renderAccounts(el);
	else if (view === "keys") call = renderKeys(el);
	else if (view === "models") call = renderModels(el);
	else if (view === "rates") call = renderRates(el);
	else if (view === "logs") call = renderLogs(el);
	else if (view === "backups") call = renderBackups(el);
	return Promise.resolve(call || null).catch(function (err) {
		el.innerHTML = '<p class="bad">' + esc(err.message) + "</p>";
	});
}

var PLATFORM_OPTIONS = ["WORKBUDDY", "TRAE", "CODEX", "CURSOR", "COPILOT", "QODER", "ZCODE", "MIMO", "CLAUDE", "GEMINI", "GROK"];

function platformOptions(selected) {
	return PLATFORM_OPTIONS.map(function (p) {
		return "<option" + (p === selected ? " selected" : "") + ">" + p + "</option>";
	}).join("");
}

function renderAccounts(el) {
	return api("GET", "/api/accounts").then(function (accounts) {
		var rows = accounts.map(function (a) {
			var status = a.enabled ? '<span class="ok">启用</span>' : '<span class="bad">停用</span>';
			if (a.lastCheckInStatus) status += " · " + esc(a.lastCheckInStatus);
			return "<tr><td>" + esc(a.name) + "</td><td>" + esc(a.platform) + "</td><td>" + status + "</td><td>"
				+ esc(a.lastCheckInMessage || "-") + '</td><td>'
				+ '<button data-act="account-toggle" data-id="' + esc(a.id) + '" data-enabled="' + (a.enabled ? "0" : "1") + '">' + (a.enabled ? "停用" : "启用") + "</button> "
				+ '<button class="danger" data-act="account-del" data-id="' + esc(a.id) + '">删除</button></td></tr>';
		}).join("");
		el.innerHTML = '<div class="row"><button class="primary" data-act="checkin-all">一键签到</button>'
			+ '<span class="muted">仅签到类平台（WorkBuddy/Trae 等）</span></div>'
			+ '<form class="inline" data-form="add-account"><label>名称<input name="name" required></label>'
			+ '<label>平台<select name="platform">' + platformOptions("") + "</select></label>"
			+ '<label style="grid-column:span 2">凭证 JSON<input name="credentials" required></label>'
			+ '<button class="primary">添加账号</button></form>'
			+ "<table><tr><th>名称</th><th>平台</th><th>状态</th><th>最近签到</th><th>操作</th></tr>" + rows + "</table>";
	});
}

function renderKeys(el) {
	return api("GET", "/api/keys").then(function (keys) {
		var rows = keys.map(function (k) {
			var status = k.enabled && !k.revokedAt ? '<span class="ok">启用</span>' : '<span class="bad">' + (k.revokedAt ? "已吊销" : "停用") + "</span>";
			return "<tr><td>" + esc(k.name) + "</td><td>" + esc(k.keyPrefix) + "…</td><td>" + esc(k.boundPlatform || "任意") + "</td><td>" + status + "</td><td>"
				+ (k.rateLimitPerMinute === null || k.rateLimitPerMinute === undefined ? "不限" : k.rateLimitPerMinute) + '</td><td>'
				+ '<button data-act="key-revoke" data-id="' + esc(k.id) + '">吊销</button> '
				+ '<button class="danger" data-act="key-del" data-id="' + esc(k.id) + '">删除</button></td></tr>';
		}).join("");
		el.innerHTML = '<form class="inline" data-form="add-key"><label>名称<input name="name" required></label>'
			+ '<label>绑定平台（可空）<select name="boundPlatform"><option value="">任意</option>' + platformOptions("") + "</select></label>"
			+ '<label>允许来源 IP（可空）<input name="allowedIps"></label>'
			+ '<button class="primary">创建 Key</button></form><div id="newkey"></div>'
			+ "<table><tr><th>名称</th><th>前缀</th><th>平台</th><th>状态</th><th>限流/分</th><th>操作</th></tr>" + rows + "</table>";
	});
}

function renderModels(el) {
	return api("GET", "/api/models").then(function (models) {
		el.innerHTML = models.map(function (m) {
			var routes = (m.routes || []).map(function (r) { return r.platform + ":" + r.upstreamModel; }).join(", ");
			return '<div class="card"><b>' + esc(m.publicId) + "</b> "
				+ (m.published ? '<span class="ok">已上架</span>' : '<span class="warn">未上架</span>')
				+ " · 窗口 " + (m.contextWindow === null ? "-" : m.contextWindow)
				+ " · 输出上限 " + (m.maxOutputTokens === null ? "-" : m.maxOutputTokens)
				+ " · 档位 " + esc((m.reasoningEfforts || []).join("/"))
				+ ' <button data-act="model-toggle" data-id="' + esc(m.id) + '" data-published="' + (m.published ? "0" : "1") + '">' + (m.published ? "下架" : "上架") + "</button>"
				+ '<div class="muted">路由：' + esc(routes || "无") + "</div></div>";
		}).join("")
			+ '<form class="inline" data-form="add-model"><label>公开模型 ID<input name="publicId" required></label>'
			+ '<label>名称<input name="name"></label>'
			+ '<label>上下文窗口<input name="contextWindow" type="number"></label>'
			+ '<label>输出上限<input name="maxOutputTokens" type="number"></label>'
			+ '<label>档位（逗号分隔）<input name="efforts"></label>'
			+ '<label style="grid-column:span 2">路由 JSON 数组<input name="routes" required></label>'
			+ '<label><input type="checkbox" name="published" checked> 立即上架</label>'
			+ '<button class="primary">创建模型</button></form>';
	});
}

function renderRates(el) {
	return api("GET", "/api/billing/rates").then(function (rates) {
		var rows = rates.map(function (r) {
			return "<tr><td>" + esc(r.model) + "</td><td>" + r.promptPer1m + "</td><td>" + r.completionPer1m + "</td><td>"
				+ r.cacheReadPer1m + "</td><td>" + r.cacheWritePer1m + "</td><td>"
				+ (r.enabled ? '<span class="ok">启用</span>' : '<span class="warn">停用</span>') + "</td></tr>";
		}).join("");
		el.innerHTML = '<p class="muted">单价单位：分 / 1M token（人民币）。仅归属成员的 Key 参与扣费。</p>'
			+ "<table><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>状态</th></tr>" + rows + "</table>"
			+ '<form class="inline" data-form="add-rate"><label>模型<input name="model" required></label>'
			+ '<label>输入<input name="prompt" type="number" required></label>'
			+ '<label>输出<input name="completion" type="number" required></label>'
			+ '<label>缓存读<input name="cacheRead" type="number" value="0"></label>'
			+ '<label>缓存写<input name="cacheWrite" type="number" value="0"></label>'
			+ '<button class="primary">保存费率</button></form>';
	});
}

function renderLogs(el) {
	return api("GET", "/api/gateway/logs?limit=50").then(function (logs) {
		var rows = logs.map(function (l) {
			var status = l.status === "OK" ? '<span class="ok">OK</span>' : '<span class="bad">' + esc(l.status) + "</span>";
			return "<tr><td>" + new Date(l.occurredAt).toLocaleString() + "</td><td>" + esc(l.model) + "</td><td>" + esc(l.platform || "-")
				+ "</td><td>" + status + "</td><td>" + (l.promptTokens === null ? "-" : l.promptTokens) + " / "
				+ (l.completionTokens === null ? "-" : l.completionTokens) + "</td><td>" + (l.latencyMs === null ? "-" : l.latencyMs)
				+ "ms</td><td>" + esc(l.message || l.errorCategory || "-") + "</td></tr>";
		}).join("");
		el.innerHTML = "<table><tr><th>时间</th><th>模型</th><th>平台</th><th>状态</th><th>tokens(P/C)</th><th>耗时</th><th>错误</th></tr>" + rows + "</table>";
	});
}

function renderBackups(el) {
	return api("GET", "/api/backups/list").then(function (list) {
		var items = list.length ? list.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") : '<li class="muted">暂无</li>';
		el.innerHTML = '<div class="card"><b>创建快照</b><div class="row"><button class="primary" data-act="snapshot">立即快照（全部表 → zip）</button><span id="snapmsg" class="muted"></span></div></div>'
			+ '<div class="card"><b>从 manager 备份导入（数据割接）</b>'
			+ '<form class="inline" data-form="import-manager"><label style="grid-column:span 2">manager 备份目录（内含每表 .jsonl）<input name="dir" required></label>'
			+ '<label><input type="checkbox" name="force"> 目标表非空时强制覆盖</label>'
			+ '<button class="primary">导入</button></form></div>'
			+ '<div class="card"><b>已有快照</b><ul>' + items + "</ul></div>";
	});
}

/* ── 事件委托：唯一点击与提交入口，杜绝内联 JS 引号拼接 ── */
document.addEventListener("click", function (event) {
	var target = event.target;
	var btn = target && target.closest ? target.closest("[data-act],[data-view]") : null;
	if (btn === null) return;
	if (btn.dataset.view) {
		view = btn.dataset.view;
		render();
		return;
	}
	var act = btn.dataset.act;
	var id = btn.dataset.id;
	if (act === "logout") return logout();
	if (act === "checkin-all") {
		api("POST", "/api/checkin/all").then(function (r) {
			alert("签到完成：成功 " + r.success + " / 已签 " + r.already + " / 失败 " + r.failed);
			render();
		}).catch(function (err) { alert(err.message); });
		return;
	}
	if (act === "account-toggle") {
		api("PATCH", "/api/accounts/" + id + "/enabled?enabled=" + btn.dataset.enabled).then(render);
		return;
	}
	if (act === "account-del") {
		if (window.confirm("删除该账号？")) api("DELETE", "/api/accounts/" + id).then(render);
		return;
	}
	if (act === "key-revoke") {
		if (window.confirm("吊销该 Key？")) api("DELETE", "/api/keys/" + id).then(render);
		return;
	}
	if (act === "key-del") {
		if (window.confirm("物理删除该 Key？调用日志保留。")) api("DELETE", "/api/keys/" + id + "/permanent").then(render);
		return;
	}
	if (act === "model-toggle") {
		api("PATCH", "/api/models/" + id + "/published?published=" + btn.dataset.published).then(render);
		return;
	}
	if (act === "snapshot") {
		api("POST", "/api/backups/snapshot").then(function (r) {
			var msg = $("snapmsg");
			if (msg) msg.textContent = "已生成 " + r.file;
		}).catch(function (err) { alert(err.message); });
	}
});

document.addEventListener("submit", function (event) {
	var target = event.target;
	var form = target && target.closest ? target.closest("form[data-form]") : null;
	if (form === null) return;
	event.preventDefault();
	var data = new FormData(form);
	var value = function (name) { return String(data.get(name) === null ? "" : data.get(name)); };
	var kind = form.dataset.form;
	if (kind === "auth") return submitAuth();
	if (kind === "add-account") {
		var credentials = {};
		try { credentials = JSON.parse(value("credentials")); } catch (err) { alert("凭证必须是合法 JSON"); return; }
		api("POST", "/api/accounts", { name: value("name"), platform: value("platform"), credentials: credentials }).then(render)
			.catch(function (err) { alert(err.message); });
		return;
	}
	if (kind === "add-key") {
		api("POST", "/api/keys", {
			name: value("name"),
			boundPlatform: value("boundPlatform") || null,
			allowedIps: value("allowedIps") || null,
		}).then(function (created) {
			var box = $("newkey");
			if (box) box.innerHTML = '<div class="card ok">Key 只显示一次，请立即保存：<pre>' + esc(created.plaintext) + "</pre></div>";
			render();
		}).catch(function (err) { alert(err.message); });
		return;
	}
	if (kind === "add-model") {
		var routes = [];
		try { routes = JSON.parse(value("routes") || "[]"); } catch (err) { alert("路由 JSON 不合法"); return; }
		api("POST", "/api/models", {
			publicId: value("publicId"),
			name: value("name") || value("publicId"),
			contextWindow: Number(value("contextWindow")) || null,
			maxOutputTokens: Number(value("maxOutputTokens")) || null,
			reasoningEfforts: value("efforts") ? value("efforts").split(",").map(function (item) { return item.trim(); }).filter(Boolean) : [],
			published: data.get("published") === "on",
			routes: routes,
		}).then(render).catch(function (err) { alert(err.message); });
		return;
	}
	if (kind === "add-rate") {
		api("POST", "/api/billing/rates", {
			model: value("model"),
			promptPer1m: Number(value("prompt")),
			completionPer1m: Number(value("completion")),
			cacheReadPer1m: Number(value("cacheRead")),
			cacheWritePer1m: Number(value("cacheWrite")),
			enabled: true,
		}).then(render).catch(function (err) { alert(err.message); });
		return;
	}
	if (kind === "import-manager") {
		if (!window.confirm("导入会覆盖 owl 当前数据（默认非空表拒绝）。继续？")) return;
		api("POST", "/api/backups/import-manager", { dir: value("dir"), force: data.get("force") === "on" }).then(function (r) {
			alert("导入完成：\n" + r.imported.map(function (row) { return row.table + ": " + row.rows + " 行"; }).join("\n"));
			render();
		}).catch(function (err) { alert(err.message); });
	}
});

refreshHealth();
setInterval(refreshHealth, 30000);
boot().catch(function (err) {
	$("authErr").textContent = err.message;
	$("auth").style.display = "";
});
</script>
</body>
</html>`;

export function adminHtml(): string {
	return ADMIN_HTML;
}
