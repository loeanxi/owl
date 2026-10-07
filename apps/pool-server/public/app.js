const $ = (sel) => document.querySelector(sel);

/* 词表访问器：i18n.js 未加载时回退到 key 本身，便于肉眼发现漏翻。
   所有面向用户的文案都必须走 t()，不要再写死中文字符串。 */
const t = (key, params) => (window.loeanI18n ? window.loeanI18n.t(key, params) : key);
const locale = () => (window.loeanI18n ? window.loeanI18n.locale() : "zh-CN");
/* 后端错误解析：优先用响应的 code + params 走词表（跟随语言），
   查不到码时回退响应里的 error 原文，最后才用本地兜底 key。 */
const errorText = (body, fallbackKey, fallbackParams) =>
  (window.loeanI18n ? window.loeanI18n.errorText(body, fallbackKey, fallbackParams) : (body && body.error) || "");

const state = {
  view: "overview",
  editingId: null,
  accounts: [],
  members: [],
  records: [],
  keys: [],
  platformFilter: "ALL",
  statusFilter: "ALL",
  search: "",
  usageItems: [],
  usageSummary: { calls: 0, fails: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  usageRange: null,
  usageDate: "",
  usageLive: false,
  usageRequestSeq: 0,
  usageEs: null,
  usageTab: "usage",
  usagePollTimer: null,
  // 建站至今累计汇总，供积分扣减页「总扣积分」卡复用（null = 尚未加载）
  lifetimeSummary: null,
  creditTimer: null,
  creditRefreshing: false,
  admin: { enabled: true, authenticated: false, username: "", setupRequired: false },
  billingTab: "rates",
  billingStatus: null,
  billingRates: [],
  billingWallets: [],
  billingLedger: [],
  rateDrafts: [],
  rateDraftPlatforms: [],
  rateDraftPlatform: "",
};

/* 凭证字段配置：label/placeholder 存词表 key，取词时才翻译（切语言后重渲染即可）。
   字段名与占位示例中的标识符/路径不进词表，原地保留。 */
const CRED_FIELDS = {
  WORKBUDDY: [
    { name: "accessToken", labelKey: "admin.cred.accessToken.label", type: "password", placeholderKey: "admin.cred.accessToken.ph" },
    { name: "authFile", labelKey: "admin.cred.authFile.label", type: "text", placeholderKey: "admin.cred.authFile.ph" },
  ],
  TRAE: [
    { name: "deviceId", labelKey: "admin.cred.deviceId.label", type: "text", placeholderKey: "admin.cred.deviceId.ph" },
    { name: "session", labelKey: "admin.cred.session.label", type: "password", placeholderKey: "admin.cred.session.ph" },
  ],
  CODEX: [
    { name: "codexHome", labelKey: "admin.cred.codexHome.label", type: "text", required: true, placeholderKey: "admin.cred.codexHome.ph" },
    { name: "defaultReasoningEffort", labelKey: "admin.cred.effort.label", type: "select", options: [
      { value: "", labelKey: "admin.cred.effort.modelDefault" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
      { value: "max", label: "max" },
      { value: "ultra", label: "ultra" },
    ] },
  ],
  ZCODE: [
    { name: "apiKey", labelKey: "admin.cred.zcodeApiKey.label", type: "password", required: true, placeholderKey: "admin.cred.zcodeApiKey.ph" },
    { name: "channel", labelKey: "admin.cred.zcodeChannel.label", type: "select", options: [
      { value: "BIGMODEL", labelKey: "admin.cred.zcodeChannel.bigmodel" },
      { value: "ZAI", labelKey: "admin.cred.zcodeChannel.zai" },
      { value: "ZCODE_PLAN", labelKey: "admin.cred.zcodeChannel.plan" },
    ] },
  ],
  MIMO: [
    { name: "mimoHome", labelKey: "admin.cred.mimoHome.label", type: "text", required: true, placeholderKey: "admin.cred.mimoHome.ph" },
  ],
};

for (const platform of POOL_LOGIN_PLATFORMS) {
  CRED_FIELDS[platform] = [
    { name: "runtimeHome", labelKey: "pool.runtimeHome", type: "text", placeholderKey: "pool.runtimeHomePh" },
    { name: "apiKey", labelKey: platform === "COPILOT" ? "pool.pat" : platform === "QODER" ? "pool.qoderCnPat" : "pool.apiKey", type: "password", placeholderKey: "pool.tokenPh" },
    ...(platform === "QODER" ? [{ name: "checkinToken", labelKey: "pool.qoderCheckinPat", type: "password", placeholderKey: "pool.qoderCheckinPatPh" }] : []),
    ...(platform === "CURSOR" ? [{ name: "sessionToken", labelKey: "pool.cursorSessionToken", type: "password", placeholderKey: "pool.cursorSessionTokenPh" }] : []),
  ];
}

/* CLAUDE 不走 Node bridge（上方循环的桥接字段模板不适用）：authType 选择
   OAuth（refreshToken，可先建号再走托管授权）或 API Key（直连）。 */
CRED_FIELDS.CLAUDE = [
  { name: "authType", labelKey: "admin.cred.claudeAuthType.label", type: "select", options: [
    { value: "apikey", labelKey: "admin.cred.claudeAuthType.apikey" },
    { value: "oauth", labelKey: "admin.cred.claudeAuthType.oauth" },
  ] },
  { name: "apiKey", labelKey: "admin.cred.claudeApiKey.label", type: "password", placeholderKey: "admin.cred.claudeApiKey.ph" },
  { name: "refreshToken", labelKey: "admin.cred.claudeRefreshToken.label", type: "password", placeholderKey: "admin.cred.claudeRefreshToken.ph" },
];
CRED_FIELDS.GEMINI = [
  { name: "apiKey", labelKey: "admin.cred.geminiApiKey.label", type: "password", required: true, placeholderKey: "admin.cred.geminiApiKey.ph" },
];
CRED_FIELDS.GROK = [
  { name: "apiKey", labelKey: "admin.cred.grokApiKey.label", type: "password", required: true, placeholderKey: "admin.cred.grokApiKey.ph" },
];

function formField(form, name) {
  return form?.elements?.namedItem(name) || null;
}

function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`.trim();
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 4200);
}

// ---------- 管理端登录 / 首次设密（P0-1） ----------

// 切换登录卡片为「首次设置」或「登录」两种形态。
function setLoginMode(setupRequired) {
  state.admin.setupRequired = !!setupRequired;
  const fields = $("#login-fields");
  const setupFields = $("#setup-fields");
  if (fields) fields.hidden = !!setupRequired;
  if (setupFields) setupFields.hidden = !setupRequired;
  for (const input of fields?.querySelectorAll("input") || []) {
    input.disabled = !!setupRequired;
    input.required = !setupRequired;
  }
  for (const input of setupFields?.querySelectorAll("input") || []) {
    input.disabled = !setupRequired;
    input.required = !!setupRequired;
  }
  const tokenField = formField($("#form-login"), "setupToken");
  const tokenRequired = !!setupRequired && !!state.admin.setupTokenRequired;
  const tokenFields = $("#setup-token-fields");
  if (tokenFields) tokenFields.hidden = !tokenRequired;
  if (tokenField) {
    tokenField.disabled = !tokenRequired;
    tokenField.required = tokenRequired;
    if (!tokenRequired) tokenField.value = "";
  }
  const title = $("#login-title");
  if (title) title.textContent = setupRequired ? t("admin.login.title.setup") : t("admin.login.title");
  const submit = $("#login-submit");
  if (submit) submit.textContent = setupRequired ? t("admin.login.submit.setup") : t("admin.login.submit");
  // 首次设置时用户名可改；登录时固定填当前用户名
  const uname = formField($("#form-login"), "username");
  if (uname && !setupRequired) uname.value = state.admin.username || "admin";
}

function setAdminBackgroundInert(inert) {
  const gate = $("#login-gate");
  for (const element of document.body.children) {
    if (element === gate || element.tagName === "SCRIPT" || element.tagName === "STYLE") continue;
    element.inert = inert;
    if (inert) element.setAttribute("aria-hidden", "true");
    else element.removeAttribute("aria-hidden");
  }
}

function trapLoginFocus(event) {
  if (event.key !== "Tab") return;
  const gate = $("#login-gate");
  if (!gate || gate.hidden) return;

  const focusable = Array.from(gate.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusOutsideGate = !gate.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || focusOutsideGate)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || focusOutsideGate)) {
    event.preventDefault();
    first.focus();
  }
}

function showLoginGate(message = "") {
  if (typeof stopModelDiagnostics === "function") stopModelDiagnostics();
  state.admin.authenticated = false;
  const gate = $("#login-gate");
  if (gate) gate.hidden = false;
  setLoginMode(state.admin.setupRequired);
  const err = $("#login-error");
  if (err) {
    err.textContent = message;
    err.hidden = !message;
  }
  const adminBox = $("#nav-admin");
  if (adminBox) adminBox.hidden = true;
  stopUsageWatch();
  stopCreditWatch();
  const form = $("#form-login");
  formField(form, state.admin.setupRequired ? "setupUsername" : "username")?.focus();
  setAdminBackgroundInert(true);
}

function hideLoginGate() {
  const gate = $("#login-gate");
  if (gate) gate.hidden = true;
  setAdminBackgroundInert(false);
  $(".nav-item.active")?.focus();
}

function renderAdminBadge() {
  const box = $("#nav-admin");
  if (!box) return;
  box.hidden = !state.admin.enabled || !state.admin.authenticated;
  const name = $("#admin-username");
  if (name) name.textContent = state.admin.username || "admin";
}

async function checkAdminSession() {
  try {
    const res = await fetch("/api/admin/session", { headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    const data = body.data || {};
    state.admin = {
      enabled: data.enabled !== false,
      authenticated: !!data.authenticated,
      username: data.username || "admin",
      setupRequired: !!data.setupRequired,
      setupTokenRequired: !!data.setupTokenRequired,
    };
  } catch {
    // 后端不可达时不做阻断，交由后续 API 报错提示
    state.admin = { enabled: true, authenticated: false, username: "admin", setupRequired: false };
  }
  renderAdminBadge();
  return state.admin.authenticated;
}

// 提交登录或首次设置（两种形态共用一个表单）。
async function submitLogin(event) {
  event.preventDefault();
  const form = $("#form-login");
  const setup = state.admin.setupRequired;
  const errEl = $("#login-error");
  const showErr = (msg) => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }
  };

  const payload = setup
    ? {
        username: formField(form, "setupUsername").value.trim(),
        password: formField(form, "setupPassword").value,
        confirmPassword: formField(form, "setupConfirm").value,
        setupToken: formField(form, "setupToken")?.value || "",
      }
    : {
        username: formField(form, "username").value.trim(),
        password: formField(form, "password").value,
      };

  if (setup) {
    if (!payload.username || !payload.password) return showErr(t("admin.login.err.required"));
    if (payload.password !== payload.confirmPassword) {
      return showErr(t("admin.login.err.mismatch"));
    }
    if (payload.password.length < 8) return showErr(t("admin.login.err.tooShort"));
  } else if (!payload.username || !payload.password) {
    return showErr(t("admin.login.err.required"));
  }

  const btn = $("#login-submit");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(setup ? "/api/admin/setup" : "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      // 首次设置被别处抢先：重新拉状态切换到登录形态
      if (setup && res.status === 409) {
        await checkAdminSession();
        setLoginMode(state.admin.setupRequired);
      }
      showErr(errorText(body, "admin.error.requestFailed"));
      return;
    }
    state.admin = {
      enabled: true,
      authenticated: true,
      username: body.data?.username || payload.username,
      setupRequired: false,
    };
    form.reset();
    showErr("");
    hideLoginGate();
    renderAdminBadge();
    toast(setup ? t("admin.login.toast.setupDone") : t("admin.login.toast.done"), "ok");
    const catchUpPending = body.data?.catchUpPending || 0;
    if (!setup && catchUpPending > 0) {
      setTimeout(() => toast(t("admin.login.toast.catchUp", { count: catchUpPending }), "ok"), 900);
    }
    await setView(state.view || "overview");
  } catch (err) {
    showErr(err.message || t("admin.error.requestFailed"));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 修改口令（需已登录）。
async function submitPasswordChange(event) {
  event.preventDefault();
  const form = $("#form-password");
  const errEl = $("#password-error");
  const showErr = (msg) => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }
  };
  const payload = {
    currentPassword: form.currentPassword.value,
    newPassword: form.newPassword.value,
    confirmPassword: form.confirmPassword.value,
  };
  if (payload.newPassword !== payload.confirmPassword) return showErr(t("admin.password.err.mismatch"));
  if (payload.newPassword.length < 8) return showErr(t("admin.password.err.tooShort"));
  try {
    const res = await fetch("/api/admin/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      showErr(errorText(body, "admin.password.err.failed"));
      return;
    }
    form.reset();
    showErr("");
    $("#dlg-password")?.close();
    toast(t("admin.password.toast.done"), "ok");
  } catch (err) {
    showErr(err.message || t("admin.password.err.failed"));
  }
}

async function logout() {
  try {
    await fetch("/api/admin/logout", { method: "POST" });
  } catch {
    // 退出接口失败也强制回登录页
  }
  state.admin.authenticated = false;
  renderAdminBadge();
  showLoginGate(t("common.logout.done"));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  // P0-1：未登录/会话过期统一回到登录页，而不是抛出难懂的 HTTP 错误
  if (res.status === 401) {
    showLoginGate(t("member.error.sessionExpired"));
    throw new Error(errorText(body, "member.error.unauthenticated"));
  }
  if (!res.ok || body.success === false) {
    // 兜底不用 t()：HTTP 状态码本身无需翻译，但要让 errorText 先有机会用上后端 code
    throw new Error(errorText(body, null) || `HTTP ${res.status}`);
  }
  return body.data;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/* 协议白名单：只有 http/https 才允许放进 <a href>（escapeHtml 拦不住 javascript: 伪协议）。
   与 shared.js 的 window.safeHttpUrl 同构；管理页不加载 shared.js，故在本地再留一份。 */
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

/**
 * 主题化确认弹窗（替代浏览器原生 confirm）。
 * 返回 Promise<boolean>：确认 true / 取消或 Esc false。
 * opts: { title?, okText?, danger? } —— danger=false 时确认键为主按钮样式。
 */
function uiConfirm(message, opts = {}) {
  const dlg = document.getElementById("dlg-confirm");
  if (!dlg) return Promise.resolve(window.confirm(message));
  const textEl = document.getElementById("dlg-confirm-text");
  const titleEl = document.getElementById("dlg-confirm-title");
  const okBtn = document.getElementById("dlg-confirm-ok");
  const cancelBtn = document.getElementById("dlg-confirm-cancel");
  if (!textEl || !okBtn || !cancelBtn) return Promise.resolve(window.confirm(message));

  textEl.textContent = message;
  if (titleEl) titleEl.textContent = opts.title || t("admin.dlg.confirm");
  okBtn.textContent = opts.okText || t("admin.dlg.confirm");
  okBtn.className = opts.danger === false ? "btn primary" : "btn danger";
  cancelBtn.textContent = opts.cancelText || t("admin.dlg.cancel");

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("cancel", onCancel);
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onClose = () => done(false);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("cancel", onCancel);
    dlg.addEventListener("close", onClose);
    dlg.showModal();
    okBtn.focus();
  });
}

// 成员页等其他脚本复用同一套确认弹窗
window.uiConfirm = uiConfirm;

function formatNum(n) {
  return Number(n || 0).toLocaleString(locale(), { maximumFractionDigits: 4 });
}

function formatTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(locale(), { hour12: false });
  } catch {
    return String(iso);
  }
}

function formatTimeShort(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(locale(), { hour12: false });
  } catch {
    return String(iso);
  }
}

function shortMsg(text, max = 80) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

function platformPill(platform) {
  const p = platform || "";
  return `<span class="pill platform">${escapeHtml(p || "—")}</span>`;
}

function statusPill(kind, label) {
  return `<span class="pill ${kind}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

// 用量来源标记：已知=上游回传，估算=网关推算，未知=无数据。
function usageSourceTag(source) {
  if (source === "DEFERRED") return `<span class="pill" title="${escapeHtml(t("admin.usage.src.deferred.tip"))}">${escapeHtml(t("admin.usage.src.deferred"))}</span>`;
  const s = String(source || "UNKNOWN").toUpperCase();
  if (s === "KNOWN") return `<span class="src-tag" title="${escapeHtml(t("admin.usage.src.known.tip"))}">${escapeHtml(t("admin.usage.src.known"))}</span>`;
  if (s === "ESTIMATED") return `<span class="src-tag estimated" title="${escapeHtml(t("admin.usage.src.estimated.tip"))}">${escapeHtml(t("admin.usage.src.estimated"))}</span>`;
  return `<span class="src-tag unknown" title="${escapeHtml(t("admin.usage.src.unknown.tip"))}">${escapeHtml(t("admin.usage.src.unknown"))}</span>`;
}

function callStatusPill(status) {
  const s = String(status || "").toUpperCase();
  if (s === "OK") return statusPill("ok", "OK");
  if (s === "ABORTED") return statusPill("warn", t("member.status.ABORTED"));
  return statusPill("err", s || "—");
}

function checkInPill(status) {
  const map = {
    SUCCESS: ["ok", t("admin.status.SUCCESS")],
    ALREADY: ["ok", t("admin.checkin.status.ALREADY")],
    OK: ["ok", t("admin.status.SUCCESS")],
    INACTIVE: ["warn", t("admin.checkin.status.INACTIVE")],
    AUTH_ERROR: ["err", t("admin.checkin.status.AUTH_ERROR")],
    FAILED: ["err", t("member.status.FAILED")],
    FAIL: ["err", t("member.status.FAIL")],
  };
  const [kind, label] = map[status] || ["", status || "—"];
  return statusPill(kind, label);
}

function credentialPill(a) {
  const st = a.credentialStatus || "UNKNOWN";
  const days = a.credentialRemainingDays;
  const tip = `${a.credentialMessage || ""}${a.credentialExpiresAt ? t("admin.credential.tipExpiresAt", { time: a.credentialExpiresAt }) : ""}`;
  if (st === "EXPIRED") return { key: "BAD", kind: "err", label: t("admin.credential.EXPIRED"), tip };
  if (st === "ERROR") return { key: "BAD", kind: "err", label: t("admin.credential.ERROR"), tip };
  if (st === "WARN") {
    const d = days == null ? "?" : days;
    return { key: "BAD", kind: "warn", label: t("admin.credential.expiresIn", { days: d }), tip };
  }
  if (st === "OK") {
    const d = days == null ? "?" : days;
    return { key: "OK", kind: "ok", label: t("admin.credential.remainingDays", { days: d }), tip };
  }
  return { key: "OK", kind: "", label: t("admin.credential.UNKNOWN"), tip };
}

// health.code 是稳定枚举，用于逻辑判断；label 只给眼睛看，可随语言变化。
function accountHealth(a) {
  if (!a.enabled) return { key: "BAD", kind: "warn", code: "DISABLED", label: t("admin.health.DISABLED") };
  if (a.platform === "TRAE" && !a.credentialsMasked?.session) {
    return { key: "BAD", kind: "warn", code: "LOGIN_REQUIRED", label: t("pool.traeLoginRequired") };
  }
  const cred = a.credentialStatus || "";
  if (cred === "EXPIRED") return { key: "BAD", kind: "err", code: "CRED_EXPIRED", label: t("admin.credential.EXPIRED") };
  if (cred === "ERROR") return { key: "BAD", kind: "err", code: "CRED_ERROR", label: t("admin.credential.ERROR") };
  if (cred === "WARN") return { key: "BAD", kind: "warn", code: "CRED_WARN", label: t("admin.health.CRED_WARN") };
  if (a.platform === "CODEX" || a.platform === "ZCODE" || a.platform === "MIMO" || poolLoginPlatform(a.platform)) {
    return cred === "OK" ? { key: "OK", kind: "ok", code: "USABLE", label: t("admin.health.USABLE") }
      : { key: "OK", kind: "warn", code: "PENDING_CHECK", label: t("admin.health.PENDING_CHECK") };
  }
  const st = a.lastCheckInStatus || "";
  if (st === "AUTH_ERROR") return { key: "BAD", kind: "err", code: "AUTH_ERROR", label: t("admin.health.AUTH_ERROR") };
  if (st === "FAILED" || st === "FAIL") return { key: "BAD", kind: "err", code: "ERROR", label: t("admin.health.ERROR") };
  if (st === "SUCCESS" || st === "ALREADY" || st === "OK") return { key: "OK", kind: "ok", code: "NORMAL", label: t("admin.health.NORMAL") };
  return { key: "OK", kind: "warn", code: "PENDING_SIGN", label: t("admin.health.PENDING_SIGN") };
}

function accountRowClass(a) {
  const cred = a.credentialStatus || "";
  if (cred === "EXPIRED" || cred === "ERROR") return "cred-danger";
  if (cred === "WARN") return "cred-warn";
  return "";
}

function todayCheckIn(a) {
  const qoderCheckin = a.platform === "QODER" && !!a.credentialsMasked?.checkinToken;
  if (a.platform === "CODEX" || a.platform === "ZCODE" || a.platform === "MIMO" || (poolLoginPlatform(a.platform) && !qoderCheckin)) return { key: "none", text: t("admin.checkin.NA"), cls: "" };
  if (!a.lastCheckInAt || !isToday(a.lastCheckInAt)) {
    return { key: "none", text: t("admin.checkin.none"), cls: "" };
  }
  const st = a.lastCheckInStatus || "";
  if (st === "SUCCESS" || st === "ALREADY" || st === "OK") {
    return { key: "done", text: t("admin.checkin.done"), cls: "ok" };
  }
  if (st === "INACTIVE") return { key: "none", text: t("admin.checkin.status.INACTIVE"), cls: "" };
  return { key: "fail", text: t("member.status.FAIL"), cls: "err" };
}

function creditsCell(a) {
  if (a.creditsStatus === "FAIL" && a.platform !== "MIMO") {
    return `<span class="err-text" title="${escapeHtml(a.creditsMessage || "")}">${escapeHtml(t("admin.credits.queryFailed"))}</span>`;
  }
  if (Array.isArray(a.creditBuckets) && a.creditBuckets.length) {
    const cursor = a.platform === "CURSOR";
    const rows = a.creditBuckets.map((bucket) => {
      const label = quotaBucketLabel(a.platform, bucket);
      const value = bucket.remaining != null
        ? `${formatNum(bucket.remaining)}${bucket.unit === "%" ? "%" : ` ${escapeHtml(bucket.unit || "")}`}`
        : bucket.unlimited ? escapeHtml(t("admin.credits.unlimited"))
          : cursor ? `<a href="https://cursor.com/dashboard/spending" target="_blank" rel="noopener noreferrer">${escapeHtml(t("admin.credits.openDashboard"))}</a>`
            : bucket.remainingPercent != null ? `${formatNum(bucket.remainingPercent)}%` : "—";
      const details = [bucket.used != null && bucket.total != null
        ? `${t("admin.credits.used")} ${formatNum(bucket.used)} / ${formatNum(bucket.total)}` : "",
        bucket.resetsAt ? `${t("admin.credits.reset")} ${new Date(bucket.resetsAt).toLocaleString()}` : "",
        bucket.note || ""].filter(Boolean).join(" · ");
      const displayValue = bucket.unavailable
        ? `${value} · ${escapeHtml(t("admin.credits.unavailable"))}` : value;
      return `<span class="quota-item" title="${escapeHtml(details)}"><span class="quota-label">${escapeHtml(label)}</span><span class="quota-value">${displayValue}</span></span>`;
    }).join("");
    return `<span class="quota-buckets${cursor ? " cursor-pools" : ""}">${rows}</span>`;
  }
  if (a.platform === "CODEX") {
    return `<span class="muted-text" title="${escapeHtml(a.creditsMessage || "")}">${escapeHtml(t("admin.credits.window"))}</span>`;
  }
  if (a.platform === "ZCODE" || a.platform === "MIMO") {
    return `<span class="muted-text" title="${escapeHtml(a.creditsMessage || "")}">${escapeHtml(t("admin.credits.subscription"))}</span>`;
  }
  if (a.platform === "TRAE" && a.creditsUnlimited) {
    return `<span title="${escapeHtml(a.creditsMessage)}">${escapeHtml(t("admin.credits.unlimited"))}</span>`;
  }
  if (a.credits == null) {
    return `<span class="muted-text" title="${escapeHtml(a.creditsMessage || "")}">—</span>`;
  }
  return `<span title="${escapeHtml(a.creditsMessage || a.creditsLabel || "")}">${formatNum(a.credits)}</span>`;
}

function quotaBucketLabel(platform, bucket) {
  if (platform === "CURSOR") {
    if (bucket.key === "cursor_plan") return t("admin.credits.cursorPlan");
    if (bucket.key === "cursor_on_demand") return t("admin.credits.cursorOnDemand");
    return bucket.key === "cursor_models" ? "Cursor Models" : "Other Models";
  }
  if (platform === "CODEX") return bucket.key === "primary" ? t("admin.credits.primary") : t("admin.credits.secondary");
  if (platform === "ZCODE") return ({ hour5: t("admin.credits.zcode5h"), weekly: t("admin.credits.zcodeWeekly") })[bucket.key] || bucket.label;
  if (platform === "QODER") return ({ plan: t("admin.credits.plan"), addon: t("admin.credits.addon"), organization: t("admin.credits.organization") })[bucket.key] || bucket.label;
  return bucket.label || bucket.key;
}

function renderCredentials(masked) {
  if (!masked) return "";
  return Object.entries(masked).map(([k, v]) => `${k}=${v}`).join(" · ");
}

function zcodeChannelLabel(channel) {
  const key = { BIGMODEL: "bigmodel", ZAI: "zai", ZCODE_PLAN: "plan" }[channel] || "bigmodel";
  return t(`admin.cred.zcodeChannel.${key}`);
}

function filterAccounts() {
  const q = state.search.trim().toLowerCase();
  return state.accounts.filter((a) => {
    if (state.platformFilter !== "ALL" && a.platform !== state.platformFilter) return false;
    if (state.statusFilter !== "ALL" && accountHealth(a).key !== state.statusFilter) return false;
    if (q) {
      const hay = `${a.name || ""} ${a.remark || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function updateFilterCounts() {
  const all = state.accounts.length;
  const wb = state.accounts.filter((a) => a.platform === "WORKBUDDY").length;
  const trae = state.accounts.filter((a) => a.platform === "TRAE").length;
  const codex = state.accounts.filter((a) => a.platform === "CODEX").length;
  const ok = state.accounts.filter((a) => accountHealth(a).key === "OK").length;
  const bad = all - ok;
  const set = (key, n) => {
    const el = document.querySelector(`[data-c="${key}"]`);
    if (el) el.textContent = n;
  };
  set("ALL", all);
  set("WORKBUDDY", wb);
  set("TRAE", trae);
  set("CODEX", codex);
  set("ZCODE", state.accounts.filter((a) => a.platform === "ZCODE").length);
  set("MIMO", state.accounts.filter((a) => a.platform === "MIMO").length);
  POOL_LOGIN_PLATFORMS.forEach(platform => set(platform, state.accounts.filter(a => a.platform === platform).length));
  set("OK", ok);
  set("BAD", bad);

  const sub = $("#accounts-sub");
  if (sub) {
    const enabled = state.accounts.filter((a) => a.enabled).length;
    sub.textContent = t("admin.accounts.summary", { total: all, enabled, bad });
  }
  updateCreditTotal();
}

// 标题旁「总积分」：合计当前列表（含筛选）中有数值的积分。
function updateCreditTotal() {
  const el = $("#accounts-credits");
  if (!el) return;
  const rows = filterAccounts();
  let sum = 0;
  let counted = 0;
  for (const a of rows) {
    if (a.credits != null && a.creditsStatus !== "FAIL") {
      sum += Number(a.credits) || 0;
      counted++;
    }
  }
  el.textContent = counted ? t("admin.accounts.creditsTotal", { sum: formatNum(sum) }) : t("admin.accounts.creditsTotal.none");
  el.title = counted
    ? t("admin.accounts.creditsTotal.tip", { count: counted })
    : t("admin.accounts.creditsTotal.tipNone");
}

function updateNav() {
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === state.view);
  });
}

function setView(view) {
  state.view = view;
  ["overview", "accounts", "models", "members", "billing", "usage", "keys", "records"].forEach((v) => {
    const el = $(`#view-${v}`);
    if (el) el.hidden = v !== view;
  });
  updateNav();

  if (view !== "usage") stopUsageWatch();
  if (view !== "accounts") stopCreditWatch();
  if (view !== "models" && typeof stopModelDiagnostics === "function") stopModelDiagnostics();

  const jobs = {
    overview: () => loadOverview(),
    accounts: () => {
      startCreditWatch();
      return loadAccounts();
    },
    models: () => loadPoolModels(),
    members: () => loadMembers(),
    billing: () => loadBilling(),
    usage: () => {
      startUsageWatch();
      setUsageTab("usage");
      return loadUsage();
    },
    keys: () => loadKeys(),
    records: () => loadRecords(),
  };

  Promise.resolve(jobs[view]?.()).catch((e) => toast(e.message, "err"));
}

/* ---------- Overview ---------- */

async function loadOverview() {
  const [accounts, usage, records] = await Promise.all([
    api("/api/accounts"),
    api("/api/gateway/usage?limit=8").catch(() => ({ summary: {}, items: [] })),
    api("/api/checkin/records").catch(() => []),
  ]);

  state.accounts = accounts || [];
  state.usageItems = usage.items || [];
  state.usageSummary = usage.summary || state.usageSummary;
  state.records = records || [];

  renderOverviewKpis();
  renderOverviewHealth();
  renderOverviewRecent();
  if (typeof refreshAdminBackupStatus === "function") refreshAdminBackupStatus();
}

function renderOverviewKpis() {
  const accounts = state.accounts;
  const total = accounts.length;
  const wb = accounts.filter((a) => a.platform === "WORKBUDDY").length;
  const trae = accounts.filter((a) => a.platform === "TRAE").length;
  const codex = accounts.filter((a) => a.platform === "CODEX").length;

  const checked = accounts.filter((a) => {
    const ci = todayCheckIn(a);
    return ci.key === "done";
  }).length;
  const checkFail = accounts.filter((a) => todayCheckIn(a).key === "fail").length;
  const checkinTotal = accounts.filter(a => ["WORKBUDDY", "TRAE"].includes(a.platform)).length;
  const pending = Math.max(0, checkinTotal - checked - checkFail);

  const s = state.usageSummary;
  const calls = s.calls || 0;
  const fails = s.fails || 0;
  const prompt = s.promptTokens || 0;
  const completion = s.completionTokens || 0;
  const totalTok = s.totalTokens || prompt + completion;

  const set = (k, v) => {
    const el = document.querySelector(`#overview-kpis [data-k="${k}"]`);
    if (el) el.textContent = v;
  };

  set("accounts", formatNum(total));
  set("accountsSub", Object.entries(POOL_PLATFORMS).map(([platform, name]) => ({ name, count: accounts.filter(a => a.platform === platform).length })).filter(item => item.count).map(item => `${item.name} ${item.count}`).join(" · ") || "—");
  set("checkin", `${checked}/${checkinTotal}`);
  set("checkinSub", t("admin.checkin.summary", { ok: checked, pending, fail: checkFail }));
  set("calls", formatNum(calls));
  set("callsSub", t("admin.overview.callsSub", { fail: fails, rate: calls ? Math.round(((calls - fails) / calls) * 100) : 100 }));
  set("tokens", formatCompact(totalTok));
  set("tokensSub", `Prompt ${formatCompact(prompt)} · Comp ${formatCompact(completion)}`);

  renderKpiMeter("accountsMeter", [
    { value: wb, cls: "seg-a", label: `WorkBuddy ${wb}` },
    { value: trae, cls: "seg-b", label: `Trae ${trae}` },
    { value: codex, cls: "seg-c", label: `Codex ${codex}` },
    ...POOL_LOGIN_PLATFORMS.map((platform, index) => ({ value: accounts.filter(a => a.platform === platform).length, cls: ["seg-a", "seg-b", "seg-c"][index % 3], label: POOL_PLATFORMS[platform] })),
  ]);
  renderKpiMeter("checkinMeter", [
    { value: checked, cls: "seg-ok", label: t("admin.checkin.seg.ok", { count: checked }) },
    { value: pending, cls: "seg-idle", label: t("admin.checkin.seg.pending", { count: pending }) },
    { value: checkFail, cls: "seg-err", label: t("admin.checkin.seg.fail", { count: checkFail }) },
  ]);
  renderKpiMeter("callsMeter", [
    { value: calls - fails, cls: "seg-ok", label: t("admin.checkin.seg.ok", { count: calls - fails }) },
    { value: fails, cls: "seg-err", label: t("admin.checkin.seg.fail", { count: fails }) },
  ]);
}

// 分段比例条：每段宽度按 value 占总和的比例，总和为 0 时只显示底轨。
function renderKpiMeter(key, segments) {
  const el = document.querySelector(`#overview-kpis [data-k="${key}"]`);
  if (!el) return;
  const sum = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
  el.innerHTML = sum
    ? segments
      .filter((s) => s.value > 0)
      .map((s) => `<span class="${s.cls}" style="flex-grow:${s.value}" title="${escapeHtml(s.label)}"></span>`)
      .join("")
    : "";
}

/**
 * 紧凑数字：用于 KPI 等窄容器，避免 8 位以上整数撑破卡片。
 * 逐级升位到 T（万亿），并去掉多余的 .0。原始精度由调用方放进 title 里保留。
 * 超过 T 量级（≥1e15）不再升位，改为科学计数，保证任何数量级都不会溢出卡片。
 */
function formatCompact(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1e15) return v.toExponential(2).replace("e+", "e");
  if (abs >= 1e12) return `${trimZero(v / 1e12)}T`;
  if (abs >= 1e9) return `${trimZero(v / 1e9)}B`;
  if (abs >= 1e6) return `${trimZero(v / 1e6)}M`;
  if (abs >= 1e3) return `${trimZero(v / 1e3)}K`;
  return formatNum(v);
}

function trimZero(v) {
  // 保留 1 位小数，但 55.0 → 55，避免「55.0M」这种噪声
  return v.toFixed(1).replace(/\.0$/, "");
}

/**
 * 把紧凑值写进 KPI，并在 title 里保留千分位原值。
 * KPI 卡片 overflow:hidden，超长会直接被裁掉，因此窄容器一律走紧凑格式。
 */
function setCompactValue(selector, raw) {
  const el = $(selector);
  if (!el) return;
  const full = formatNum(raw);
  el.textContent = formatCompact(raw);
  el.title = full;
}

function renderOverviewHealth() {
  const root = $("#overview-health");
  const rows = [...state.accounts]
    .sort((a, b) => {
      const rank = { BAD: 0, OK: 1 };
      const ha = accountHealth(a).key;
      const hb = accountHealth(b).key;
      if (rank[ha] !== rank[hb]) return rank[ha] - rank[hb];
      return (a.name || "").localeCompare(b.name || "");
    })
    .slice(0, 8);

  if (!rows.length) {
    root.innerHTML = `<tr><td colspan="4"><div class="empty">${escapeHtml(t("admin.accounts.empty"))}</div></td></tr>`;
    return;
  }

  root.innerHTML = rows.map((a) => {
    const h = accountHealth(a);
    const cp = credentialPill(a);
    const tip = cp.tip ? `${h.label} · ${cp.tip}` : h.label;
    return `
      <tr class="${accountRowClass(a)}">
        <td><div class="cell-title">${escapeHtml(a.name)}</div></td>
        <td>${platformPill(a.platform)}</td>
        <td title="${escapeHtml(tip)}">${statusPill(h.kind, h.label)}</td>
        <td class="num">${creditsCell(a)}</td>
      </tr>`;
  }).join("");
}

function renderOverviewRecent() {
  const root = $("#overview-recent");
  const items = (state.usageItems || []).slice(0, 6);
  if (!items.length) {
    root.innerHTML = `<div class="empty">${escapeHtml(t("member.empty.records"))}</div>`;
    return;
  }
  root.innerHTML = items.map((row) => {
    const ok = String(row.status || "").toUpperCase() === "OK";
    const model = row.model || "-";
    const account = row.accountName || row.accountId || "-";
    return `
      <div class="recent-item${ok ? "" : " fail"}">
        <div class="recent-title">${escapeHtml(model)} <span class="recent-account">· ${escapeHtml(account)}</span></div>
        <div class="recent-meta">
          <span class="recent-status${ok ? "" : " fail"}">${ok ? "OK" : escapeHtml(row.status || "—")}</span>
          · ${escapeHtml(formatTimeShort(row.occurredAt))}
          · ${formatCompact(row.totalTokens)} tok
          · ${formatNum(row.latencyMs)}ms
        </div>
      </div>`;
  }).join("");
}

/* ---------- Accounts ---------- */

async function loadAccounts() {
  const accounts = await api("/api/accounts");
  state.accounts = accounts || [];
  updateFilterCounts();
  renderAccountList();
}

function renderAccountList() {
  const root = $("#account-list");
  const filtered = filterAccounts();
  updateCreditTotal();
  if (!filtered.length) {
    root.innerHTML = `<tr><td colspan="7"><div class="empty">${escapeHtml(state.accounts.length ? t("admin.accounts.emptyFiltered") : t("admin.accounts.emptyHint"))}</div></td></tr>`;
    return;
  }

  root.innerHTML = filtered.map((a, idx) => {
    const h = accountHealth(a);
    const cp = credentialPill(a);
    const ci = todayCheckIn(a);
    const cred = a.platform === "CODEX"
      ? t("admin.accounts.codexCred", {
          home: a.credentialsMasked?.codexHome || "—",
          effort: a.credentialsMasked?.defaultReasoningEffort || t("admin.cred.effort.modelDefault"),
        })
      : a.platform === "ZCODE"
      ? t("admin.accounts.zcodeCred", {
          key: a.credentialsMasked?.apiKey || "—",
          channel: zcodeChannelLabel(a.credentialsMasked?.channel),
        })
      : renderCredentials(a.credentialsMasked) || "—";
    const remark = a.remark || "—";
    const needsCredUpdate = h.code === "AUTH_ERROR" || h.code === "CRED_EXPIRED";
    const isCodex = a.platform === "CODEX";
    const isZcode = a.platform === "ZCODE";
    const isMimo = a.platform === "MIMO";
    const isTrae = a.platform === "TRAE";
    const hasLogin = poolLoginPlatform(a.platform);
    const qoderCheckin = a.platform === "QODER" && !!a.credentialsMasked?.checkinToken;
    const checkinLabel = isTrae || qoderCheckin ? t("admin.accounts.act.checkin") : hasLogin ? t("pool.login") : isCodex ? t("admin.accounts.act.creditQuery")
      : needsCredUpdate ? t("admin.accounts.act.updateCred") : (isZcode || isMimo) ? t("admin.accounts.act.edit") : t("admin.accounts.act.checkin");
    const checkinAct = isTrae || qoderCheckin ? "checkin" : hasLogin ? "authorize" : isCodex ? "refresh-credit"
      : needsCredUpdate ? "edit" : (isZcode || isMimo) ? "edit" : "checkin";
    const tip = cp.tip ? `${h.label} · ${cp.tip}` : h.label;
    return `
      <tr data-id="${escapeHtml(a.id)}" class="${accountRowClass(a)}">
        <td>
          <div class="cell-title">${escapeHtml(a.name)}</div>
          <div class="cell-sub" title="${escapeHtml(cred)}">${escapeHtml(cred)}</div>
        </td>
        <td>${platformPill(a.platform)}</td>
        <td title="${escapeHtml(tip)}">${statusPill(h.kind, h.label)}</td>
        <td class="num">${creditsCell(a)}</td>
        <td><span class="${ci.cls === "ok" ? "ok-text" : ci.cls === "err" ? "err-text" : "muted-text"}">${escapeHtml(ci.text)}</span></td>
        <td title="${escapeHtml(a.remark || "")}"><span class="muted-text">${escapeHtml(shortMsg(remark, 16))}</span></td>
        <td class="ops-col">
          <div class="row-actions">
            <button class="row-btn" data-act="ping">Ping</button>
            <button class="row-btn primary" data-act="${checkinAct}">${escapeHtml(checkinLabel)}</button>
            ${qoderCheckin || isTrae ? `<button class="row-btn" data-act="authorize">${escapeHtml(t(isTrae ? "pool.traeLogin" : "pool.login"))}</button>` : ""}
            ${hasLogin || a.platform === "TRAE" ? `<button class="row-btn" data-act="refresh-credit">${escapeHtml(t(a.platform === "TRAE" ? "admin.accounts.act.refreshCredit" : "admin.accounts.act.creditQuery"))}</button>` : ""}
            ${checkinAct === "edit" ? "" : `<button class="row-btn" data-act="edit">${escapeHtml(t("admin.accounts.act.edit"))}</button>`}
            <div class="more">
              <button type="button" class="row-btn more-trigger" popovertarget="account-more-${idx}" aria-label="${escapeHtml(t("admin.accounts.moreAria", { name: a.name }))}" title="${escapeHtml(t("admin.accounts.more"))}">⋯</button>
              <div id="account-more-${idx}" class="more-menu row-popover" popover="auto">
                <button class="row-btn" data-act="check-cred">${escapeHtml(t("admin.accounts.act.checkCred"))}</button>
                ${checkinAct === "refresh-credit" || hasLogin ? "" : `<button class="row-btn" data-act="refresh-credit">${escapeHtml(t("admin.accounts.act.refreshCredit"))}</button>`}
                <button class="row-btn" data-act="toggle">${escapeHtml(a.enabled ? t("admin.accounts.act.disable") : t("admin.accounts.act.enable"))}</button>
                <button class="row-btn danger" data-act="del">${escapeHtml(t("admin.accounts.act.del"))}</button>
              </div>
            </div>
          </div>
        </td>
      </tr>`;
  }).join("");
}

/* ---------- Members ---------- */

async function loadMembers() {
  const root = $("#member-list");
  try {
    const [members, wallets, status] = await Promise.all([
      api("/api/members"),
      api("/api/billing/wallets").catch(() => []),
      api("/api/billing/status").catch(() => null),
    ]);
    state.members = members || [];
    state.billingWallets = wallets || [];
    if (status) state.billingStatus = status;
    renderMemberList();
  } catch (err) {
    if (root) root.innerHTML = `<tr><td colspan="6"><div class="empty">${escapeHtml(t("admin.load.failed", { message: err.message }))}</div></td></tr>`;
  }
}

function memberKeyState(member) {
  const key = member?.key;
  if (!key) return { kind: "warn", label: t("admin.members.key.none") };
  if (!member.enabled || !key.enabled) return { kind: "warn", label: t("admin.members.key.disabled") };
  if (key.expired) return { kind: "err", label: t("member.status.EXPIRED") };
  return { kind: "ok", label: t("admin.health.NORMAL") };
}

/* Key 已无 Token 配额：这里改为说明该 Key 是否走成员钱包计费。 */
function memberBillingText(key) {
  if (!key) return "—";
  return key.ownerMemberId ? t("admin.keys.billed") : t("admin.keys.unbilled");
}

/* 成员行的钱包余额：计费未就绪 / 无钱包 / 旧币种 / 正常人民币四种情况。 */
function memberWalletCell(member) {
  if (!billingServerReady()) {
    return `<span class="muted-text">${escapeHtml(t("admin.billing.restartShort"))}</span>`;
  }
  const wallet = (state.billingWallets || []).find((w) => w.memberId === member.id);
  if (!wallet || !wallet.hasWallet) {
    return `<div class="muted-text">${escapeHtml(t("admin.members.wallet.none"))}</div>
          <div class="cell-sub">${escapeHtml(memberBillingText(member.key))}</div>`;
  }
  if (isLegacyBillingWallet(wallet)) {
    return `<div class="muted-text">${escapeHtml(t("admin.billing.wallet.migrationRequired"))}</div>`;
  }
  return `<div class="cell-title">${escapeHtml(formatBillingAmount(wallet.balance))}</div>
          <div class="cell-sub">${escapeHtml(memberBillingText(member.key))}</div>`;
}

function renderMemberList() {
  const root = $("#member-list");
  if (!root) return;
  const members = state.members || [];
  if (!members.length) {
    root.innerHTML = `<tr><td colspan="6"><div class="empty">${escapeHtml(t("admin.members.empty"))}</div></td></tr>`;
    return;
  }
  root.innerHTML = members.map((member) => {
    const key = member.key;
    const stateInfo = memberKeyState(member);
    const identifier = key?.identifier || "—";
    const platform = key?.boundPlatform || t("admin.keyDlg.any");
    const created = member.createdAt ? formatTime(member.createdAt) : "—";
    return `
      <tr data-id="${escapeHtml(member.id)}">
        <td>
          <div class="cell-title">${escapeHtml(member.displayName || member.username)}</div>
          <div class="cell-sub">@${escapeHtml(member.username || "—")}</div>
        </td>
        <td>
          <div class="p-mono">${escapeHtml(identifier)}</div>
          <div class="cell-sub">${escapeHtml(platform)}</div>
        </td>
        <td class="num">${memberWalletCell(member)}</td>
        <td>${statusPill(stateInfo.kind, stateInfo.label)}</td>
        <td><span class="muted-text">${escapeHtml(created)}</span></td>
        <td class="ops-col">
          <div class="row-actions">
            <button class="row-btn" data-act="edit-member">${escapeHtml(t("admin.members.act.edit"))}</button>
            <button class="row-btn" data-act="member-wallet">${escapeHtml(t("admin.billing.act.walletOp"))}</button>
            <button class="row-btn${member.enabled ? " danger" : ""}" data-act="toggle-member">${escapeHtml(member.enabled ? t("admin.members.act.disable") : t("admin.members.act.restore"))}</button>
            <button class="row-btn" data-act="rotate-member-key" ${member.enabled ? "" : "disabled"}>${escapeHtml(t("admin.members.act.rotateKey"))}</button>
            <button class="row-btn danger" data-act="del-member">${escapeHtml(t("admin.members.act.delete"))}</button>
          </div>
        </td>
      </tr>`;
  }).join("");
}

function openMemberDialog(member = null) {
  const form = $("#form-member");
  if (!form) return;
  const editing = !!member;
  form.reset();
  setMemberFormError("");
  form.id.value = member?.id || "";
  form.username.value = member?.username || "";
  form.username.disabled = editing;
  form.displayName.value = member?.displayName || "";
  form.password.value = "";
  form.enabled.checked = member ? !!member.enabled : true;
  document.querySelectorAll(".member-key-fields").forEach((field) => { field.hidden = editing; });
  const passwordLabel = form.querySelector(".member-password-row");
  if (passwordLabel) passwordLabel.firstChild.textContent = editing ? t("admin.members.password.reset") : t("admin.members.password.initial");
  const title = $("#member-dlg-title");
  if (title) title.textContent = editing ? t("admin.members.dlg.edit") : t("admin.members.dlg.create");
  const hint = $("#member-dlg-hint");
  if (hint) hint.textContent = editing
    ? t("admin.members.hint.edit")
    : t("admin.members.hint.create");
  const save = $("#btn-save-member");
  if (save) save.textContent = editing ? t("admin.members.save.edit") : t("admin.members.save.create");
  $("#dlg-member")?.showModal();
}

function setMemberFormError(message) {
  const error = $("#member-form-error");
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
  if (message) error.scrollIntoView({ block: "nearest" });
}

async function submitMember(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel" || event.submitter?.dataset?.closeDlg !== undefined) {
    event.target.closest("dialog")?.close();
    return;
  }
  const form = $("#form-member");
  const id = form.id.value;
  const password = form.password.value;
  const toIso = (value) => value ? new Date(value).toISOString() : null;
  setMemberFormError("");
  try {
    if (id) {
      const updated = await api(`/api/members/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: form.displayName.value.trim(),
          password: password || null,
          enabled: form.enabled.checked,
        }),
      });
      toast(t("admin.members.toast.updated", { name: updated.displayName || form.displayName.value.trim() }), "ok");
      $("#dlg-member")?.close();
      await loadMembers();
      return;
    }
    const created = await api("/api/members", {
      method: "POST",
      body: JSON.stringify({
        username: form.username.value.trim(),
        displayName: form.displayName.value.trim(),
        password,
        keyName: form.keyName.value.trim() || null,
        boundPlatform: form.boundPlatform.value || null,
        rateLimitPerMinute: form.rateLimitPerMinute.value ? Number(form.rateLimitPerMinute.value) : null,
        expiresAt: toIso(form.expiresAt.value),
        enabled: form.enabled.checked,
      }),
    });
    $("#dlg-member")?.close();
    await loadMembers();
    showMemberKey(created.member?.displayName || form.displayName.value.trim(), created.plaintext);
  } catch (err) {
    setMemberFormError(t(id ? "admin.members.error.save" : "admin.members.error.create", { message: err.message || t("admin.error.retryLater") }));
  }
}

function showMemberKey(displayName, plaintext) {
  const dialog = $("#dlg-member-key");
  if (!dialog) return;
  $("#member-key-member").value = displayName || t("member.rail.memberFallback");
  $("#member-key-plaintext").value = plaintext || "";
  dialog.showModal();
  $("#member-key-plaintext").focus();
  $("#member-key-plaintext").select();
}

async function rotateMemberKey(member) {
  if (!member?.id || !member.enabled) return;
  if (!(await uiConfirm(t("admin.members.confirmRotate", { name: member.displayName })))) return;
  const key = member.key || {};
  try {
    const result = await api(`/api/members/${encodeURIComponent(member.id)}/rotate-key`, {
      method: "POST",
      body: JSON.stringify({
        keyName: key.name || null,
        boundPlatform: key.boundPlatform || null,
        rateLimitPerMinute: Number(key.rateLimitPerMinute) >= 0 ? Number(key.rateLimitPerMinute) : null,
        expiresAt: key.expiresAt || null,
      }),
    });
    await loadMembers();
    showMemberKey(member.displayName, result.plaintext);
  } catch (err) {
    toast(err.message, "err");
  }
}

/* ---------- Billing ---------- */

const BILLING_NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const BILLING_SIGNED_DECIMAL = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

function billingDecimalParts(value) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] || "").replace(/0+$/, "");
  const zero = integer === "0" && fraction === "";
  return { integer, fraction, negative: match[1] === "-" && !zero, zero };
}

function formatDecimalAmount(value, minimumFractionDigits = 2) {
  const decimal = billingDecimalParts(value);
  if (!decimal) return "—";
  const integer = decimal.integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = decimal.fraction.padEnd(minimumFractionDigits, "0");
  return (decimal.negative ? "-" : "") + integer + (fraction ? "." + fraction : "");
}

function compareDecimalAmounts(left, right) {
  const a = billingDecimalParts(left);
  const b = billingDecimalParts(right);
  if (!a || !b) return 0;
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  let order = Math.sign(a.integer.length - b.integer.length);
  if (!order) order = a.integer > b.integer ? 1 : a.integer < b.integer ? -1 : 0;
  if (!order) {
    const digits = Math.max(a.fraction.length, b.fraction.length);
    const af = a.fraction.padEnd(digits, "0");
    const bf = b.fraction.padEnd(digits, "0");
    order = af > bf ? 1 : af < bf ? -1 : 0;
  }
  return a.negative ? -order : order;
}

function formatBillingAmount(value) {
  const decimal = formatDecimalAmount(value);
  if (decimal === "—") return decimal;
  return decimal.startsWith("-") ? "-¥" + decimal.slice(1) : "¥" + decimal;
}

function formatHistoricalBillingAmount(value) {
  const amount = formatDecimalAmount(value, 0);
  return amount === "—" ? amount : t("billing.legacyAmount", { amount });
}

function billingServerReady() {
  return state.billingStatus?.currency === "CNY";
}

function billingRatesReady() {
  return billingServerReady() && state.billingStatus?.rateUnit === "PER_1M_TOKENS";
}

function requireBillingServerReady() {
  if (billingServerReady()) return true;
  toast(t("admin.billing.restartRequired"), "warn");
  return false;
}

function requireBillingRatesReady() {
  if (billingRatesReady()) return true;
  toast(t("admin.billing.rateRestartRequired"), "warn");
  return false;
}

function isHistoricalBillingEntry(entry) {
  return !billingServerReady() || !!entry.historical || !!(entry.currency && entry.currency !== "CNY");
}

function isLegacyBillingWallet(wallet) {
  return !billingServerReady() || !!wallet.migrationRequired || !!(wallet.currency && wallet.currency !== "CNY");
}

function formatBillingLedgerAmount(entry) {
  const decimal = billingDecimalParts(entry.amount);
  if (!decimal) return "—";
  const historical = isHistoricalBillingEntry(entry);
  const negative = (entry.entryType === "USAGE_CHARGE" && entry.status !== "VOIDED")
    || (entry.entryType === "ADJUSTMENT" && entry.balanceBefore != null
      && entry.balanceAfter != null && compareDecimalAmounts(entry.balanceAfter, entry.balanceBefore) < 0);
  const magnitude = decimal.integer + (decimal.fraction ? "." + decimal.fraction : "");
  const signed = negative && !decimal.zero ? "-" + magnitude : magnitude;
  const formatted = historical ? formatHistoricalBillingAmount(signed) : formatBillingAmount(signed);
  return (!negative && !decimal.zero ? "+" : "") + formatted
    + (historical ? " · " + t("billing.legacyRecord") : "");
}

async function loadBilling() {
  const [status, rates, wallets, ledger] = await Promise.all([
    api("/api/billing/status"),
    api("/api/billing/rates"),
    api("/api/billing/wallets"),
    api("/api/billing/ledger?limit=80"),
  ]);
  // 草稿是独立接口：失败（如旧后端尚未重启）不拖垮整个计费页
  let rateDrafts = null;
  try {
    rateDrafts = await api("/api/billing/rate-drafts");
  } catch {
    rateDrafts = null;
  }
  state.billingStatus = status || {};
  state.billingRates = rates || [];
  state.billingWallets = wallets || [];
  state.billingLedger = ledger || [];
  state.rateDrafts = rateDrafts?.drafts || [];
  state.rateDraftPlatforms = rateDrafts?.platforms || [];
  renderBillingStatus();
  setBillingTab(state.billingTab || "rates");
  renderBillingRates();
  renderBillingRateDrafts();
  renderBillingWallets();
  renderBillingLedger();
}

function renderBillingStatus() {
  const s = state.billingStatus || {};
  const enabledEl = $("#billing-enabled-v");
  if (enabledEl) {
    enabledEl.textContent = s.enabled ? t("admin.billing.on") : t("admin.billing.off");
    enabledEl.classList.toggle("err", !s.enabled);
    enabledEl.classList.toggle("accent", !!s.enabled);
  }
  const currency = $("#billing-currency-sub");
  if (currency) currency.textContent = billingServerReady()
    ? t("admin.billing.currency", { currency: t("billing.currencyName") })
    : t("admin.billing.legacyCurrency", { currency: s.currency || "credit" });
  const rateCount = $("#billing-rate-count");
  if (rateCount) rateCount.textContent = formatNum(s.rateCount ?? state.billingRates.length);
  const walletCount = $("#billing-wallet-count");
  if (walletCount) walletCount.textContent = formatNum(s.walletCount ?? 0);
  const sub = $("#billing-status-sub");
  if (sub) {
    sub.textContent = !billingServerReady() ? t("admin.billing.restartRequired")
      : !billingRatesReady() ? t("admin.billing.rateRestartRequired")
      : s.enabled ? t("admin.billing.sub.on") : t("admin.billing.sub.off");
  }
  const newRate = $("#btn-new-rate");
  if (newRate) newRate.disabled = !billingRatesReady();
}

function setBillingTab(tab) {
  state.billingTab = tab;
  document.querySelectorAll("#billing-subtabs .subtab").forEach((el) => {
    el.classList.toggle("active", el.dataset.billingTab === tab);
  });
  const panels = {
    rates: $("#billing-panel-rates"),
    "rate-drafts": $("#billing-panel-rate-drafts"),
    wallets: $("#billing-panel-wallets"),
    ledger: $("#billing-panel-ledger"),
  };
  Object.entries(panels).forEach(([key, el]) => {
    if (el) el.hidden = key !== tab;
  });
}

function renderBillingRates() {
  const root = $("#billing-rate-list");
  if (!root) return;
  const rows = state.billingRates || [];
  const ready = billingRatesReady();
  if (!rows.length) {
    root.innerHTML = `<tr><td colspan="8"><div class="empty">${escapeHtml(t("admin.billing.ratesEmpty"))}</div></td></tr>`;
    return;
  }
  root.innerHTML = rows.map((r) => `
    <tr data-rate-id="${escapeHtml(r.id)}">
      <td><code>${escapeHtml(r.model)}</code></td>
      <td class="num">${ready ? escapeHtml(formatBillingAmount(r.promptPer1m)) : "—"}</td>
      <td class="num">${ready ? escapeHtml(formatBillingAmount(r.completionPer1m)) : "—"}</td>
      <td class="num">${ready ? escapeHtml(formatBillingAmount(r.cacheReadPer1m)) : "—"}</td>
      <td class="num">${ready ? escapeHtml(formatBillingAmount(r.cacheWritePer1m)) : "—"}</td>
      <td>${r.enabled ? `<span class="pill ok">${escapeHtml(t("admin.billing.enabled"))}</span>` : `<span class="pill warn">${escapeHtml(t("admin.billing.disabled"))}</span>`}</td>
      <td>${escapeHtml(r.remark || "—")}</td>
      <td class="ops-col">
        ${ready ? `
          <button type="button" class="row-btn" data-billing-act="edit-rate">${escapeHtml(t("admin.billing.act.edit"))}</button>
          <button type="button" class="row-btn" data-billing-act="toggle-rate">${escapeHtml(r.enabled ? t("admin.billing.act.disable") : t("admin.billing.act.enable"))}</button>
          <button type="button" class="row-btn danger" data-billing-act="del-rate">${escapeHtml(t("admin.billing.act.del"))}</button>` : escapeHtml(t("admin.billing.restartShort"))}
      </td>
    </tr>
  `).join("");
}

function renderDraftCurrencySymbol(currency) {
  return currency === "USD" ? "$" : "¥";
}

function renderRateDraftCell(value, currency) {
  if (value == null) return "—";
  const formatted = formatDecimalAmount(value);
  if (formatted === "—") return formatted;
  return renderDraftCurrencySymbol(currency) + formatted;
}

/* 草稿价格格：USD 行在原价下附折合人民币小字（后端按当前汇率折算，应用即落此价） */
function renderRateDraftCellCny(row, field) {
  const cell = renderRateDraftCell(row[field], row.currency);
  const preview = row.cnyPreview && row.cnyPreview[field];
  if (!preview) return cell;
  const title = escapeHtml(t("admin.billing.draft.usdPreviewTitle", { rate: row.cnyPreview.rate }));
  return cell + '<div class="muted-text draft-cny-preview" title="' + title + '">≈¥' + escapeHtml(preview) + '</div>';
}

function renderBillingRateDrafts() {
  const root = $("#billing-rate-draft-list");
  if (!root) return;
  const all = state.rateDrafts || [];
  const filter = state.rateDraftPlatform || "";
  const rows = filter ? all.filter((r) => r.platform === filter) : all;
  renderRateDraftPlatformControls(all, rows.length);
  if (!rows.length) {
    root.innerHTML = `<tr><td colspan="9"><div class="empty">${escapeHtml(t("admin.billing.draft.empty"))}</div></td></tr>`;
    return;
  }
  // 存在美元草稿时，表体首行给出汇率折算提示（价格格内同时有 ≈¥ 预览）
  const usdRow = rows.find((r) => r.cnyPreview && r.cnyPreview.rate);
  const usdHintRow = usdRow
    ? `<tr class="rate-draft-usd-hint"><td colspan="9"><div class="muted-text">${escapeHtml(t("admin.billing.draft.usdNote", { rate: usdRow.cnyPreview.rate }))}</div></td></tr>`
    : "";
  root.innerHTML = usdHintRow + rows.map((r) => {
    const applied = r.status === "APPLIED";
    // 协议白名单：拦掉 javascript: 等伪协议，非法来源一律不渲染成链接
    const sourceHref = safeHttpUrl(r.sourceUrl);
    const sourceLine = [
      r.checkedDate ? escapeHtml(t("admin.billing.draft.checkedAt", { date: r.checkedDate })) : "",
      sourceHref ? `<a href="${escapeHtml(sourceHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("admin.billing.draft.sourceLink"))}</a>` : "",
    ].filter(Boolean).join(" · ");
    const remarkLines = [
      sourceLine ? `<div class="muted-text">${sourceLine}</div>` : "",
      r.remark ? `<div>${escapeHtml(r.remark)}</div>` : "",
    ].filter(Boolean).join("");
    return `
    <tr data-rate-draft-id="${escapeHtml(r.id)}">
      <td><code>${escapeHtml(r.model)}</code></td>
      <td>${r.platform ? escapeHtml(r.platform) : `<span class="muted-text">${escapeHtml(t("admin.billing.draft.platformMissing"))}</span>`}</td>
      <td class="num">${renderRateDraftCellCny(r, "promptPer1m")}</td>
      <td class="num">${renderRateDraftCellCny(r, "completionPer1m")}</td>
      <td class="num">${renderRateDraftCellCny(r, "cacheReadPer1m")}</td>
      <td class="num">${renderRateDraftCellCny(r, "cacheWritePer1m")}</td>
      <td>${applied ? `<span class="pill ok">${escapeHtml(t("admin.billing.draft.statusApplied"))}</span>` : `<span class="pill">${escapeHtml(t("admin.billing.draft.statusDraft"))}</span>`}</td>
      <td>${remarkLines || "—"}</td>
      <td class="ops-col">
        <button type="button" class="row-btn" data-billing-act="edit-rate-draft">${escapeHtml(t("admin.billing.act.edit"))}</button>
        ${applied ? "" : `<button type="button" class="row-btn" data-billing-act="apply-rate-draft">${escapeHtml(t("admin.billing.draft.act.apply"))}</button>`}
        <button type="button" class="row-btn danger" data-billing-act="del-rate-draft">${escapeHtml(t("admin.billing.act.del"))}</button>
      </td>
    </tr>
  `;
  }).join("");
}

function renderRateDraftPlatformControls(all, filteredCount) {
  const select = $("#rate-draft-platform-filter");
  if (select) {
    const current = state.rateDraftPlatform || "";
    const options = [`<option value="" ${current ? "" : "selected"}>${escapeHtml(t("admin.billing.draft.allPlatforms"))}</option>`]
      .concat((state.rateDraftPlatforms || []).map((p) => `<option value="${escapeHtml(p)}" ${p === current ? "selected" : ""}>${escapeHtml(p)}</option>`));
    select.innerHTML = options.join("");
  }
  const datalist = $("#rate-draft-platform-options");
  if (datalist) {
    datalist.innerHTML = (state.rateDraftPlatforms || []).map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
  }
  const hint = $("#rate-draft-count-hint");
  if (hint) {
    hint.textContent = (state.rateDraftPlatform && filteredCount !== all.length)
      ? t("admin.billing.draft.countHint", { total: all.length, count: filteredCount })
      : t("admin.billing.draft.countTotal", { total: all.length });
  }
}

function openRateDraftDialog(draft = null) {
  if (!requireBillingServerReady()) return;
  const form = $("#form-billing-rate-draft");
  if (!form) return;
  form.reset();
  formField(form, "id").value = draft?.id || "";
  formField(form, "model").value = draft?.model || "";
  formField(form, "model").disabled = !!draft?.id;
  formField(form, "platform").value = draft?.platform || "";
  formField(form, "promptPer1m").value = draft?.promptPer1m ?? "";
  formField(form, "completionPer1m").value = draft?.completionPer1m ?? "";
  formField(form, "cacheReadPer1m").value = draft?.cacheReadPer1m ?? "";
  formField(form, "cacheWritePer1m").value = draft?.cacheWritePer1m ?? "";
  formField(form, "currency").value = draft?.currency || "CNY";
  formField(form, "sourceUrl").value = draft?.sourceUrl || "";
  formField(form, "checkedDate").value = draft?.checkedDate || "";
  formField(form, "remark").value = draft?.remark || "";
  $("#billing-rate-draft-dlg-title").textContent = draft?.id ? t("admin.billing.draft.edit") : t("admin.billing.draft.create");
  $("#dlg-billing-rate-draft").showModal();
}

async function submitBillingRateDraft(event) {
  event.preventDefault();
  if (!requireBillingServerReady()) return;
  const form = event.currentTarget;
  const id = formField(form, "id").value;
  const model = formField(form, "model").value.trim();
  if (!model) {
    toast(t("admin.billing.draft.modelRequired"), "err");
    return;
  }
  const prompt = formField(form, "promptPer1m").value.trim();
  const completion = formField(form, "completionPer1m").value.trim();
  const cacheRead = formField(form, "cacheReadPer1m").value.trim();
  const cacheWrite = formField(form, "cacheWritePer1m").value.trim();
  const rates = [prompt, completion, cacheRead, cacheWrite];
  if (rates.some((v) => v && !BILLING_NONNEGATIVE_DECIMAL.test(v))) {
    toast(t("admin.billing.rate.invalidAmount"), "err");
    return;
  }
  const fields = `"platform":${JSON.stringify(formField(form, "platform").value.trim() || null)},`
    + `"promptPer1m":${prompt || "null"},"completionPer1m":${completion || "null"},`
    + `"cacheReadPer1m":${cacheRead || "null"},"cacheWritePer1m":${cacheWrite || "null"},`
    + `"currency":${JSON.stringify(formField(form, "currency").value || "CNY")},`
    + `"sourceUrl":${JSON.stringify(formField(form, "sourceUrl").value.trim() || null)},`
    + `"checkedDate":${JSON.stringify(formField(form, "checkedDate").value.trim() || null)},`
    + `"remark":${JSON.stringify(formField(form, "remark").value.trim() || null)}`;
  const body = id ? `{${fields}}` : `{"model":${JSON.stringify(model)},${fields}}`;
  try {
    await api(id ? `/api/billing/rate-drafts/${encodeURIComponent(id)}` : "/api/billing/rate-drafts", {
      method: id ? "PUT" : "POST",
      body,
    });
    $("#dlg-billing-rate-draft").close();
    toast(t("admin.billing.draft.toast.saved"), "ok");
    await loadBilling();
  } catch (err) {
    toast(err.message, "err");
  }
}

async function seedRateDrafts() {
  if (!requireBillingServerReady()) return;
  const result = await api("/api/billing/rate-drafts/seed-from-catalog", { method: "POST" });
  toast(t("admin.billing.draft.toast.seeded", { created: result?.created ?? 0, total: result?.catalogTotal ?? 0 }),
    result?.created ? "ok" : "");
  await loadBilling();
}

function renderBillingWallets() {
  const root = $("#billing-wallet-list");
  if (!root) return;
  const rows = state.billingWallets || [];
  const ready = billingServerReady();
  if (!rows.length) {
    root.innerHTML = `<tr><td colspan="5"><div class="empty">${escapeHtml(t("admin.billing.walletsEmpty"))}</div></td></tr>`;
    return;
  }
  root.innerHTML = rows.map((w) => {
    const legacyWallet = w.hasWallet && isLegacyBillingWallet(w);
    const balance = !w.hasWallet ? t("member.billing.noWallet")
      : isLegacyBillingWallet(w)
        ? formatHistoricalBillingAmount(w.balance) + " · " + t("billing.legacyBalanceNote")
        : formatBillingAmount(w.balance);
    const name = `${w.displayName || w.username || "—"} · ${w.username || ""}`;
    return `
      <tr data-member-id="${escapeHtml(w.memberId)}">
        <td>
          <div>${escapeHtml(w.displayName || w.username || "—")}</div>
          <div class="muted-text">${escapeHtml(w.username || "")}${w.memberEnabled ? "" : escapeHtml(t("admin.billing.memberDisabled"))}</div>
        </td>
        <td class="num">${escapeHtml(balance)}</td>
        <td>${w.hasWallet ? `<span class="pill ok">${escapeHtml(t("admin.billing.opened"))}</span>` : `<span class="pill">${escapeHtml(t("admin.billing.notOpened"))}</span>`}</td>
        <td>${escapeHtml(formatTimeShort(w.updatedAt))}</td>
        <td class="ops-col">
          ${!ready ? `<span class="muted-text">${escapeHtml(t("admin.billing.restartShort"))}</span>`
            : w.hasWallet ? "" : `<button type="button" class="row-btn" data-billing-act="ensure-wallet">${escapeHtml(t("admin.billing.act.open"))}</button>`}
          ${!ready ? "" : legacyWallet ? `<span class="muted-text">${escapeHtml(t("admin.billing.wallet.migrationRequired"))}</span>`
            : `<button type="button" class="row-btn" data-billing-act="wallet-op" data-wallet-name="${escapeHtml(name)}">${escapeHtml(t("admin.billing.act.walletOp"))}</button>`}
        </td>
      </tr>
    `;
  }).join("");
}

function memberLabelById(memberId) {
  const hit = (state.billingWallets || []).find((w) => w.memberId === memberId);
  if (!hit) {
    // 成员删除后钱包行保留但不再进列表，这里的流水按已删成员标注。
    const shortId = (memberId || "").slice(0, 8) || "—";
    return t("admin.billing.memberDeleted", { id: shortId });
  }
  return `${hit.displayName || hit.username || "—"} (${hit.username || hit.memberId})`;
}

/* 删除确认：余额非零（含欠费）时提示管理员先处理钱包。 */
async function confirmDeleteMember(member) {
  const wallet = (state.billingWallets || []).find((w) => w.memberId === member.id);
  const name = `${member.displayName || member.username} (@${member.username || "—"})`;
  const hasBalance = wallet?.hasWallet
    && compareDecimalAmounts(wallet.balance || "0", "0") !== 0;
  const message = hasBalance
    ? t("admin.members.confirmDeleteWithBalance", { name, balance: formatBillingAmount(wallet.balance) })
    : t("admin.members.confirmDelete", { name });
  return uiConfirm(message, { title: t("admin.members.act.delete") });
}

function renderBillingLedger() {
  const root = $("#billing-ledger-list");
  if (!root) return;
  const rows = state.billingLedger || [];
  if (!rows.length) {
    root.innerHTML = `<tr><td colspan="9"><div class="empty">${escapeHtml(t("admin.billing.ledgerEmpty"))}</div></td></tr>`;
    return;
  }
  // 值是词表 key，取词时再翻译：这样切语言后重新渲染即可得到新语言。
  const typeLabel = {
    USAGE_CHARGE: "member.billing.typeUsage",
    TOP_UP: "member.billing.typeTopUp",
    ADJUSTMENT: "member.billing.typeAdjustment",
    REFUND: "member.billing.typeRefund",
  };
  const statusLabel = {
    PENDING: "member.billing.statusPending",
    REVIEW: "member.billing.statusReview",
    POSTED: "member.billing.statusPosted",
    VOIDED: "member.billing.statusVoided",
  };
  root.innerHTML = rows.map((e) => {
    const review = e.entryType === "USAGE_CHARGE" && e.status === "REVIEW" && !isHistoricalBillingEntry(e);
    const reserved = e.entryType === "USAGE_CHARGE" && (e.status === "REVIEW" || e.status === "PENDING");
    const amount = reserved
      ? `${t("admin.billing.ledger.reserved")} ${isHistoricalBillingEntry(e)
        ? formatHistoricalBillingAmount(e.reservedAmount ?? e.amount) + " · " + t("billing.legacyRecord")
        : formatBillingAmount(e.reservedAmount ?? e.amount)}`
      : formatBillingLedgerAmount(e);
    const statusText = statusLabel[e.status] ? t(statusLabel[e.status]) : (e.status || "—");
    const status = statusPill(e.status === "REVIEW" ? "warn" : e.status === "POSTED" ? "ok" : "", statusText);
    const actions = review
      ? `<button type="button" class="row-btn primary" data-billing-ledger-act="CHARGE">${escapeHtml(t("admin.billing.ledger.charge"))}</button>
         <button type="button" class="row-btn" data-billing-ledger-act="REFUND">${escapeHtml(t("admin.billing.ledger.refund"))}</button>`
      : "—";
    return `
      <tr data-ledger-id="${escapeHtml(e.id || "")}">
        <td>${escapeHtml(formatTime(e.occurredAt))}</td>
        <td>${escapeHtml(memberLabelById(e.memberId))}</td>
        <td>${escapeHtml(typeLabel[e.entryType] ? t(typeLabel[e.entryType]) : (e.entryType || "—"))}</td>
        <td class="num">${escapeHtml(amount)}</td>
        <td class="num">${e.balanceBefore == null ? "—" : escapeHtml(isHistoricalBillingEntry(e)
          ? formatHistoricalBillingAmount(e.balanceBefore) : formatBillingAmount(e.balanceBefore))}</td>
        <td class="num">${e.balanceAfter == null ? "—" : escapeHtml(isHistoricalBillingEntry(e)
          ? formatHistoricalBillingAmount(e.balanceAfter) : formatBillingAmount(e.balanceAfter))}</td>
        <td>${status}</td>
        <td>${escapeHtml(e.remark || e.model || "—")}</td>
        <td class="ops-col">${actions}</td>
      </tr>
    `;
  }).join("");
}

function openRateDialog(rate = null) {
  if (!requireBillingRatesReady()) return;
  const form = $("#form-billing-rate");
  if (!form) return;
  form.reset();
  formField(form, "id").value = rate?.id || "";
  formField(form, "model").value = rate?.model || "";
  formField(form, "model").disabled = !!rate?.id;
  formField(form, "promptPer1m").value = rate?.promptPer1m ?? 0;
  formField(form, "completionPer1m").value = rate?.completionPer1m ?? 0;
  formField(form, "cacheReadPer1m").value = rate?.cacheReadPer1m ?? "";
  formField(form, "cacheWritePer1m").value = rate?.cacheWritePer1m ?? "";
  formField(form, "remark").value = rate?.remark || "";
  formField(form, "enabled").checked = rate?.enabled !== false;
  $("#billing-rate-dlg-title").textContent = rate?.id ? t("admin.billing.rate.edit") : t("admin.billing.rate.create");
  $("#dlg-billing-rate").showModal();
}

function openWalletDialog(memberId, memberLabel) {
  if (!requireBillingServerReady()) return;
  const wallet = (state.billingWallets || []).find((row) => row.memberId === memberId);
  if (wallet?.hasWallet && isLegacyBillingWallet(wallet)) {
    toast(t("admin.billing.wallet.migrationRequired"), "warn");
    return;
  }
  const form = $("#form-billing-wallet");
  if (!form) return;
  form.reset();
  formField(form, "memberId").value = memberId || "";
  formField(form, "memberLabel").value = memberLabel || memberId || "";
  formField(form, "action").value = "top-up";
  formField(form, "amount").value = "";
  formField(form, "remark").value = "";
  formField(form, "currentBalance").value = wallet?.hasWallet
    ? formatBillingAmount(wallet.balance)
    : t("admin.members.wallet.none");
  form.dataset.currentBalance = wallet?.hasWallet
    ? wallet.balance
    : (state.billingStatus?.defaultWalletBalance || "0");
  updateWalletPreview();
  $("#billing-wallet-dlg-title").textContent = t("admin.billing.wallet.dlgTitle");
  $("#dlg-billing-wallet").showModal();
}

/* 弹窗里的预计余额：金额无效时给提示，有效时按充值/调账显示操作后余额。 */
function updateWalletPreview() {
  const form = $("#form-billing-wallet");
  const hint = $("#billing-wallet-preview");
  if (!form || !hint) return;
  const action = formField(form, "action").value;
  const amountRaw = formField(form, "amount").value.trim();
  if (!amountRaw) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }
  const decimal = billingDecimalParts(amountRaw);
  const valid = BILLING_SIGNED_DECIMAL.test(amountRaw) && decimal && !decimal.zero
    && (action === "adjust" || !decimal.negative);
  if (!valid) {
    hint.hidden = false;
    hint.textContent = t("admin.billing.wallet.previewInvalid");
    return;
  }
  const projected = addDecimalStrings(form.dataset.currentBalance || "0", amountRaw);
  if (!projected) {
    hint.hidden = false;
    hint.textContent = t("admin.billing.wallet.previewInvalid");
    return;
  }
  hint.hidden = false;
  hint.textContent = t("admin.billing.wallet.previewAfter", {
    amount: formatBillingAmount(amountRaw),
    balance: formatBillingAmount(projected),
  });
}

/* 十进制字符串精确加法（最多 6 位小数），供预计余额使用。 */
function addDecimalStrings(a, b) {
  const da = billingDecimalParts(a);
  const db = billingDecimalParts(b);
  if (!da || !db) return null;
  const scaled = (d) => {
    const digits = (d.integer + d.fraction.padEnd(6, "0")).replace(/^0+(?=\d)/, "");
    const value = BigInt(digits || "0");
    return d.negative ? -value : value;
  };
  let sum = scaled(da) + scaled(db);
  const negative = sum < 0n;
  if (negative) sum = -sum;
  const digits = sum.toString().padStart(7, "0");
  const intPart = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, "");
  return (negative ? "-" : "") + intPart + (fraction ? "." + fraction : "");
}

function openBillingReviewDialog(entry, action) {
  if (!requireBillingServerReady()) return;
  if (!entry || isHistoricalBillingEntry(entry) || entry.entryType !== "USAGE_CHARGE" || entry.status !== "REVIEW"
      || (action !== "CHARGE" && action !== "REFUND")) return;
  const form = $("#form-billing-review");
  if (!form) return;
  form.reset();
  formField(form, "ledgerId").value = entry.id;
  formField(form, "action").value = action;
  formField(form, "memberLabel").value = memberLabelById(entry.memberId);
  formField(form, "model").value = entry.model || "—";
  formField(form, "reservedAmount").value = String(entry.reservedAmount ?? entry.amount ?? 0);
  const charge = action === "CHARGE";
  const amount = formField(form, "amount");
  amount.value = "";
  amount.required = charge;
  amount.disabled = !charge;
  const amountRow = $("#billing-review-amount-row");
  if (amountRow) {
    amountRow.hidden = !charge;
    amountRow.style.display = charge ? "" : "none";
  }
  $("#billing-review-hint").textContent = t(charge
    ? "admin.billing.ledger.reviewHintCharge" : "admin.billing.ledger.reviewHintRefund");
  const error = $("#billing-review-error");
  if (error) error.hidden = true;
  const submit = $("#btn-billing-review-submit");
  submit.textContent = t(charge ? "admin.billing.ledger.charge" : "admin.billing.ledger.refund");
  $("#dlg-billing-review").showModal();
  (charge ? amount : submit).focus();
}

async function submitBillingReview(event) {
  event.preventDefault();
  if (!requireBillingServerReady()) return;
  const form = event.currentTarget;
  const ledgerId = formField(form, "ledgerId").value;
  const action = formField(form, "action").value;
  if (!ledgerId || (action !== "CHARGE" && action !== "REFUND")) return;
  const error = $("#billing-review-error");
  let body = JSON.stringify({ action: "REFUND" });
  let chargeAmount = "";
  if (action === "CHARGE") {
    chargeAmount = formField(form, "amount").value.trim();
    if (!BILLING_NONNEGATIVE_DECIMAL.test(chargeAmount)) {
      if (error) {
        error.textContent = t("admin.billing.ledger.invalidAmount");
        error.hidden = false;
      }
      formField(form, "amount").focus();
      return;
    }
    // Keep the verified decimal literal exact when sending it to BigDecimal.
    body = `{"action":"CHARGE","amount":${chargeAmount}}`;
  }
  // 扣费直接动成员余额按危险操作确认；不扣费仅结清待核对状态，用普通确认。
  const memberName = formField(form, "memberLabel").value || "—";
  const confirmed = action === "CHARGE"
    ? await uiConfirm(t("admin.billing.ledger.confirmCharge", {
      name: memberName,
      amount: formatBillingAmount(chargeAmount),
      reserved: formatBillingAmount(formField(form, "reservedAmount").value),
    }), {
      title: t("admin.billing.ledger.reviewTitle"),
      okText: t("admin.billing.ledger.charge"),
    })
    : await uiConfirm(t("admin.billing.ledger.confirmRefund", { name: memberName }), {
      title: t("admin.billing.ledger.reviewTitle"),
      okText: t("admin.billing.ledger.refund"),
      danger: false,
    });
  if (!confirmed) return;
  const submit = $("#btn-billing-review-submit");
  submit.disabled = true;
  try {
    await api(`/api/billing/ledger/${encodeURIComponent(ledgerId)}/resolve`, {
      method: "POST",
      body,
    });
  } catch (err) {
    if (error) {
      error.textContent = err.message;
      error.hidden = false;
    }
    return;
  } finally {
    submit.disabled = false;
  }
  $("#dlg-billing-review").close();
  toast(t(action === "CHARGE" ? "admin.billing.ledger.resolvedCharge" : "admin.billing.ledger.resolvedRefund"), "ok");
  try {
    await loadBilling();
  } catch (err) {
    toast(err.message, "err");
  }
}

async function submitBillingRate(event) {
  event.preventDefault();
  if (!requireBillingRatesReady()) return;
  const form = event.currentTarget;
  const id = formField(form, "id").value;
  const prompt = formField(form, "promptPer1m").value.trim();
  const completion = formField(form, "completionPer1m").value.trim();
  const cacheRead = formField(form, "cacheReadPer1m").value.trim();
  const cacheWrite = formField(form, "cacheWritePer1m").value.trim();
  if (!BILLING_NONNEGATIVE_DECIMAL.test(prompt) || !BILLING_NONNEGATIVE_DECIMAL.test(completion)
      || (cacheRead && !BILLING_NONNEGATIVE_DECIMAL.test(cacheRead))
      || (cacheWrite && !BILLING_NONNEGATIVE_DECIMAL.test(cacheWrite))) {
    toast(t("admin.billing.rate.invalidAmount"), "err");
    return;
  }
  const enabled = formField(form, "enabled").checked;
  const remark = formField(form, "remark").value || null;
  const model = formField(form, "model").value.trim();
  const fields = `"promptPer1m":${prompt},"completionPer1m":${completion},`
    + `"cacheReadPer1m":${cacheRead || "null"},"cacheWritePer1m":${cacheWrite || "null"},`
    + `"clearCacheReadPrice":${!cacheRead},"clearCacheWritePrice":${!cacheWrite},`
    + `"enabled":${enabled},"remark":${JSON.stringify(remark)}`;
  const body = id ? `{${fields}}` : `{"model":${JSON.stringify(model)},${fields}}`;
  try {
    await api(id ? `/api/billing/rates/${encodeURIComponent(id)}` : "/api/billing/rates", {
      method: id ? "PUT" : "POST",
      body,
    });
    $("#dlg-billing-rate").close();
    toast(t("admin.billing.rate.toast.saved"), "ok");
    await loadBilling();
  } catch (err) {
    toast(err.message, "err");
  }
}

async function submitBillingWallet(event) {
  event.preventDefault();
  if (!requireBillingServerReady()) return;
  const form = event.currentTarget;
  const memberId = formField(form, "memberId").value;
  const action = formField(form, "action").value;
  const amount = formField(form, "amount").value.trim();
  const decimal = billingDecimalParts(amount);
  if (!BILLING_SIGNED_DECIMAL.test(amount) || !decimal || decimal.zero
      || (action !== "adjust" && decimal.negative)) {
    toast(t("admin.billing.wallet.invalidAmount"), "err");
    return;
  }
  const memberName = formField(form, "memberLabel").value || memberId;
  // 扣减方向的调账按危险操作确认，文案用正数金额 + 「扣减」表述。
  const deduct = action === "adjust" && decimal.negative;
  const confirmKey = deduct ? "admin.billing.wallet.confirmAdjustSub"
    : action === "adjust" ? "admin.billing.wallet.confirmAdjustAdd"
    : "admin.billing.wallet.confirmTopUp";
  if (!(await uiConfirm(t(confirmKey, {
    name: memberName,
    amount: formatBillingAmount(deduct ? amount.slice(1) : amount),
  }), {
    title: t("admin.billing.wallet.dlgTitle"),
    okText: t(action === "adjust" ? "admin.walletDlg.adjust" : "admin.walletDlg.topUp"),
    danger: deduct,
  }))) return;
  const remark = formField(form, "remark").value || null;
  const path = action === "adjust" ? "adjust" : "top-up";
  try {
    // 未开户成员从成员页直接充值时，这里自动开户再入账。
    const wallet = (state.billingWallets || []).find((row) => row.memberId === memberId);
    if (!wallet?.hasWallet) {
      await api(`/api/billing/wallets/${encodeURIComponent(memberId)}/ensure`, { method: "POST" });
    }
    await api(`/api/billing/wallets/${encodeURIComponent(memberId)}/${path}`, {
      method: "POST",
      body: `{"amount":${amount},"remark":${JSON.stringify(remark)}}`,
    });
    $("#dlg-billing-wallet").close();
    toast(action === "adjust" ? t("admin.billing.wallet.toast.adjusted") : t("admin.billing.wallet.toast.toppedUp"), "ok");
    if (state.view === "members") {
      await loadMembers();
    } else {
      await loadBilling();
    }
  } catch (err) {
    toast(err.message, "err");
  }
}

/* ---------- Records ---------- */

async function loadRecords() {
  const records = await api("/api/checkin/records");
  state.records = records || [];
  const sub = $("#records-sub");
  if (sub) sub.textContent = t("admin.records.count", { count: state.records.length });
  renderRecordList();
}

function renderRecordList() {
  const root = $("#record-list");
  const records = state.records || [];
  if (!records.length) {
    root.innerHTML = `<tr><td colspan="7"><div class="empty">${escapeHtml(t("admin.records.empty"))}</div></td></tr>`;
    return;
  }
  root.innerHTML = records.map((r) => `
    <tr data-id="${escapeHtml(r.id)}">
      <td>${escapeHtml(formatTime(r.occurredAt))}</td>
      <td><div class="cell-title">${escapeHtml(r.accountName)}</div></td>
      <td>${platformPill(r.platform)}</td>
      <td>${checkInPill(r.status)}</td>
      <td class="num">${r.credits != null ? `+${formatNum(r.credits)}` : "—"}</td>
      <td title="${escapeHtml(r.message || "")}"><span class="muted-text">${escapeHtml(shortMsg(r.message || "—", 40))}</span></td>
      <td>
        <div class="row-actions">
          <button class="row-btn danger" data-act="del-record">${escapeHtml(t("admin.records.act.del"))}</button>
        </div>
      </td>
    </tr>
  `).join("");
}

/* ---------- Keys ---------- */

async function loadKeys() {
  try {
    const keys = await api("/api/keys");
    state.keys = keys || [];
    renderKeyList();
  } catch (err) {
    $("#key-list").innerHTML = `<tr><td colspan="8"><div class="empty">${escapeHtml(t("admin.load.failed", { message: err.message }))}</div></td></tr>`;
  }
}

function renderKeyList() {
  const root = $("#key-list");
  const keys = state.keys || [];
  if (!keys.length) {
    root.innerHTML = `<tr><td colspan="8"><div class="empty">${escapeHtml(t("admin.keys.empty"))}</div></td></tr>`;
    return;
  }
  root.innerHTML = keys.map((k, idx) => {
    const unlimited = t("member.overview.unlimited");
    // Token 配额已废弃：这一列改为展示该 Key 是否走成员钱包计费。
    const billing = memberBillingText(k);
    const rate = k.rateLimitPerMinute < 0 ? unlimited : t("admin.keys.perMinute", { count: k.rateLimitPerMinute });
    const expires = k.expiresAt ? t("admin.keys.expiresAt", { time: formatTime(k.expiresAt) }) : "";
    const expired = !!k.expired;
    const status = expired
      ? statusPill("err", t("member.status.EXPIRED"))
      : (k.enabled ? statusPill("ok", t("admin.keys.enabled")) : statusPill("warn", t("admin.keys.revoked")));
    return `
      <tr data-id="${escapeHtml(k.id)}" class="${expired ? "cred-danger" : ""}">
        <td><div class="cell-title">${escapeHtml(k.name)}</div><div class="cell-sub">${escapeHtml(expires || t("member.key.noExpiry"))}</div></td>
        <td><span class="key-chip"><code>${escapeHtml(k.keyPrefix)}…</code><button type="button" class="key-copy" data-act="copy-prefix" title="${escapeHtml(t("admin.keys.copyPrefix.tip"))}">⧉</button></span></td>
        <td>${escapeHtml(k.boundPlatform || t("admin.keyDlg.any"))}<div class="pool-meta">${escapeHtml(k.allowedModels == null ? t("pool.allowAllShort") : t("pool.allowedCount", { count: k.allowedModels.length }))}${effortPolicyBadge(k)}</div></td>
        <td class="num">${escapeHtml(billing)}</td>
        <td>${escapeHtml(rate)}</td>
        <td title="${escapeHtml(k.allowedIps || "")}"><span class="muted-text">${escapeHtml(shortMsg(k.allowedIps || unlimited, 20))}</span></td>
        <td>${status}</td>
        <td class="ops-col">
          <div class="row-actions">
            <button class="row-btn" data-act="edit-key">${escapeHtml(t("admin.keys.act.edit"))}</button>
            <div class="more">
              <button type="button" class="row-btn more-trigger" popovertarget="key-more-${idx}" aria-label="${escapeHtml(t("admin.accounts.moreAria", { name: k.name }))}" title="${escapeHtml(t("admin.accounts.more"))}">⋯</button>
              <div id="key-more-${idx}" class="more-menu row-popover" popover="auto">
                <button class="row-btn" data-act="toggle-key">${escapeHtml(k.enabled ? t("admin.keys.act.disable") : t("admin.keys.act.enable"))}</button>
                <button class="row-btn danger" data-act="revoke">${escapeHtml(t("admin.keys.act.revoke"))}</button>
                <button class="row-btn danger" data-act="delete-key" title="${escapeHtml(t("admin.keys.act.delTip"))}">${escapeHtml(t("admin.keys.act.del"))}</button>
              </div>
            </div>
          </div>
        </td>
      </tr>`;
  }).join("");
}

function positionRowPopover(menu) {
  const trigger = menu.previousElementSibling;
  if (!(trigger instanceof HTMLElement)) return;

  // Native popovers render in the top layer, outside the clipped table wrapper.
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.margin = "0";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const edge = 8;
  const gap = 6;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(edge, Math.min(triggerRect.right - menuRect.width, viewportWidth - menuRect.width - edge));
  const roomBelow = viewportHeight - triggerRect.bottom - gap;
  const roomAbove = triggerRect.top - gap;
  const preferredTop = roomBelow >= menuRect.height || roomBelow >= roomAbove
    ? triggerRect.bottom + gap
    : triggerRect.top - menuRect.height - gap;
  const top = Math.max(edge, Math.min(preferredTop, viewportHeight - menuRect.height - edge));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openKeyEditDialog(key) {
  const form = $("#form-key-edit");
  form.id.value = key.id;
  form.name.value = key.name || "";
  form.boundPlatform.value = key.boundPlatform || "";
  form.allowedIps.value = key.allowedIps || "";
  form.rateLimitPerMinute.value = key.rateLimitPerMinute >= 0 ? key.rateLimitPerMinute : "";
  form.expiresAt.value = toLocalInputValue(key.expiresAt);
  form.clearExpiresAt.checked = false;
  form.enabled.checked = !!key.enabled;
  form.effortMax.value = key.effortPolicy?.maxEffort || "";
  form.effortOverLimit.value = key.effortPolicy?.overLimit || "";
  form.effortMappings.value = formatEffortMappings(key.effortPolicy?.mappings);
  prepareKeyModels(key);
  $("#dlg-key-edit").showModal();
}

/* 思考强度策略：行格式 from=to 或 from=to@模型（前缀模型写作 模型*，后缀写作 *模型）。 */
/** 密钥列表的策略摘要徽标：≤上限 · N 条映射；无策略返回空串。 */
function effortPolicyBadge(key) {
  const policy = key?.effortPolicy;
  if (!policy) return "";
  const parts = [];
  if (policy.maxEffort) parts.push(`≤${policy.maxEffort}`);
  if (policy.mappings?.length) parts.push(`${policy.mappings.length}↦`);
  return parts.length ? ` <span class="key-chip">${escapeHtml(parts.join(" · "))}</span>` : "";
}

function formatEffortMappings(mappings) {
  return (mappings || []).map(m => {
    let scope = "";
    if (m.model) {
      if (m.matchType === "prefix") scope = `@${m.model}*`;
      else if (m.matchType === "suffix") scope = `@*${m.model}`;
      else scope = `@${m.model}`;
    }
    return `${m.from}=${m.to}${scope}`;
  }).join("\n");
}

function parseEffortMappings(text) {
  return (text || "").split("\n").map(l => l.trim()).filter(Boolean).map(line => {
    const eq = line.indexOf("=");
    if (eq <= 0 || eq === line.length - 1) throw new Error(t("admin.keyDlg.effortMappingsInvalid"));
    const from = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1).trim();
    const at = rest.lastIndexOf("@");
    let to = rest, matchType = null, model = null;
    if (at > 0) {
      to = rest.slice(0, at).trim();
      const scope = rest.slice(at + 1).trim();
      if (!to) throw new Error(t("admin.keyDlg.effortMappingsInvalid"));
      if (scope.startsWith("*") && scope.length > 1) { matchType = "suffix"; model = scope.slice(1); }
      else if (scope.endsWith("*") && scope.length > 1) { matchType = "prefix"; model = scope.slice(0, -1); }
      else { matchType = "exact"; model = scope; }
      if (!model) throw new Error(t("admin.keyDlg.effortMappingsInvalid"));
    }
    return { from, to, matchType, model };
  });
}

/** 三个字段全空返回 null（清除策略）；任一配置返回策略对象。 */
function readEffortPolicy(form) {
  if (!form.effortMax) return undefined;
  const max = form.effortMax.value;
  const mappingsText = form.effortMappings.value;
  if (!max && !mappingsText.trim()) return null;
  return {
    maxEffort: max || null,
    overLimit: form.effortOverLimit.value || null,
    mappings: parseEffortMappings(mappingsText),
  };
}

async function submitKeyEdit(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel" || event.submitter?.dataset?.closeDlg !== undefined) {
    event.target.closest("dialog")?.close();
    return;
  }
  const form = $("#form-key-edit");
  const id = form.id.value;
  const payload = {
    name: form.name.value.trim(),
    boundPlatform: form.boundPlatform.value,
    allowedIps: form.allowedIps.value.trim(),
    enabled: form.enabled.checked,
    clearExpiresAt: form.clearExpiresAt.checked,
    clearAllowedIps: !form.allowedIps.value.trim(),
    clearRateLimitPerMinute: form.rateLimitPerMinute.value === "",
  };
  const allowedModels = readKeyModels();
  if (allowedModels !== undefined) payload.allowedModels = allowedModels;
  // 显式带上（含 null）以区分"清除策略"与"未改动"；无策略字段时 undefined 不发送
  const effortPolicy = readEffortPolicy(form);
  if (effortPolicy !== undefined) payload.effortPolicy = effortPolicy;
  if (form.rateLimitPerMinute.value !== "") {
    payload.rateLimitPerMinute = Number(form.rateLimitPerMinute.value);
    if (payload.rateLimitPerMinute < 0) payload.clearRateLimitPerMinute = true;
  }
  if (!form.clearExpiresAt.checked && form.expiresAt.value) {
    payload.expiresAt = new Date(form.expiresAt.value).toISOString();
  }
  try {
    await api(`/api/keys/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    $("#dlg-key-edit").close();
    toast(t("admin.keys.toast.updated"), "ok");
    await loadKeys();
  } catch (err) {
    toast(err.message, "err");
  }
}

/* ---------- Usage ---------- */

function usageRowHtml(row, fresh = false) {
  return `
    <tr data-id="${escapeHtml(row.id || "")}" class="${fresh ? "fresh" : ""}">
      <td>${escapeHtml(formatTime(row.occurredAt))}</td>
      <td>${callStatusPill(row.status)}</td>
      <td>${platformPill(row.platform)}</td>
      <td>${escapeHtml(row.model || "-")}</td>
      <td title="${escapeHtml(row.accountId || "")}">${escapeHtml(row.accountName || row.accountId || "-")}</td>
      <td title="${escapeHtml(row.keyId || "")}">${escapeHtml(row.keyName || row.keyId || "-")}</td>
      <td class="num">${formatNum(row.promptTokens)}</td>
      <td class="num">${formatNum(row.completionTokens)}</td>
      <td class="num">${formatNum(row.totalTokens)} ${usageSourceTag(row.usageSource)}</td>
      <td class="num">${formatNum(row.latencyMs)}ms</td>
      <td>${escapeHtml(row.clientIp || "-")}</td>
    </tr>`;
}

function renderUsageSummary(summary) {
  const s = summary || {};
  state.usageSummary = {
    calls: s.calls || 0,
    fails: s.fails || 0,
    promptTokens: s.promptTokens || 0,
    completionTokens: s.completionTokens || 0,
    totalTokens: s.totalTokens || 0,
    creditCost: s.creditCost || 0,
    creditUnknown: s.creditUnknown || 0,
  };
  paintUsageKpis();
  // P0-2：区分已知/估算/未知用量，缺失 usage 不再被当成零消耗
  const srcEl = $("#usage-source-sub");
  if (srcEl) {
    srcEl.textContent = t("admin.usage.sourceSub", {
      known: formatNum(s.knownCalls || 0),
      estimated: formatNum(s.estimatedCalls || 0),
      unknown: formatNum(s.unknownCalls || 0),
      fail: formatNum(state.usageSummary.fails),
    });
  }
  const costEl = $("#credit-cost-today");
  if (costEl) costEl.textContent = formatNum(state.usageSummary.creditCost);
  const countEl = $("#credit-cost-count");
  if (countEl) {
    const attributed = Math.max(0, state.usageSummary.calls - state.usageSummary.creditUnknown);
    countEl.textContent = formatNum(attributed);
  }
  const unknownEl = $("#credit-cost-unknown");
  if (unknownEl) unknownEl.textContent = formatNum(state.usageSummary.creditUnknown);
  const subEl = $("#credit-cost-sub");
  if (subEl) subEl.textContent = t("admin.usage.creditUnknown", { count: formatNum(state.usageSummary.creditUnknown) });
  // 「今日已用」与「今日扣减合计」同源（选中业务日），单独留一张卡是为了
  // 在同一个视野里给出"累计 vs 当日"的对照，不必切到历史总调用页。
  paintCreditTodayKpis();
}

/**
 * 积分扣减页的两张新卡片：
 * - 总扣积分：建站至今累计，取自 /api/gateway/usage/lifetime 的 summary.creditCost
 *   （与「历史总调用」同源，避免再写一份聚合查询）。
 * - 今日已用：选中业务日，取自 state.usageSummary.creditCost（与「今日扣减合计」同源）。
 * 两者数据来自不同接口/时机，所以各自独立重绘，谁先到就先显示谁。
 */
function paintCreditTodayKpis() {
  const s = state.usageSummary || {};
  const usedEl = $("#credit-cost-used-today");
  if (usedEl) usedEl.textContent = formatNum(s.creditCost || 0);

  const usedSub = $("#credit-cost-used-sub");
  if (usedSub) {
    const day = state.usageDate || "";
    usedSub.textContent = day
      ? t("admin.usage.creditUsedSub", { date: day })
      : t("admin.usage.creditUsedSubNoDate");
  }
}

function paintCreditLifetimeKpi() {
  const life = state.lifetimeSummary;
  const totalEl = $("#credit-cost-total");
  if (!totalEl) return;
  if (!life) {
    // 未加载时不要显示 0，否则会与"真的没有扣减"混淆
    totalEl.textContent = "—";
    const sub = $("#credit-cost-total-sub");
    if (sub) sub.textContent = t("admin.usage.creditTotalPending");
    return;
  }
  totalEl.textContent = formatNum(life.creditCost || 0);
  const totalSub = $("#credit-cost-total-sub");
  if (totalSub) {
    const unknown = Number(life.creditUnknown || 0);
    totalSub.textContent = unknown > 0
      ? t("admin.usage.creditTotalWithUnknown", { unknown: formatNum(unknown) })
      : t("admin.usage.creditTotalSub");
  }
}

function renderCreditList(items) {
  const root = $("#credit-list");
  if (!root) return;
  const rows = items || [];
  if (!rows.length) {
    root.innerHTML = `<tr><td colspan="7"><div class="empty">${escapeHtml(t("admin.credits.empty"))}</div></td></tr>`;
    return;
  }
  root.innerHTML = rows.map((row) => {
    const cost = row.creditCost != null ? formatNum(row.creditCost) : "—";
    const before = row.creditsBefore != null ? formatNum(row.creditsBefore) : "—";
    const after = row.creditsAfter != null ? formatNum(row.creditsAfter) : "—";
    const ok = String(row.status || "").toUpperCase() === "OK";
    const costCls = row.creditCost == null ? "muted-text" : Number(row.creditCost) > 0 ? "err-text" : "muted-text";
    return `
      <tr data-id="${escapeHtml(row.id || "")}">
        <td>${escapeHtml(formatTime(row.occurredAt))}</td>
        <td><div class="cell-title">${escapeHtml(row.accountName || row.accountId || "-")}</div></td>
        <td>${escapeHtml(row.model || "-")}</td>
        <td class="num ${costCls}" title="${escapeHtml(row.creditCost == null ? t("admin.credits.costUnknown.tip") : t("admin.credits.costDerived.tip"))}">${cost}</td>
        <td class="num muted-text">${before}</td>
        <td class="num">${after}</td>
        <td>${ok ? statusPill("ok", "OK") : statusPill("err", row.status || "—")}</td>
      </tr>`;
  }).join("");
}

function setUsageTab(tab) {
  state.usageTab = tab;
  const credits = tab === "credits";
  const lifetime = tab === "lifetime";
  $("#usage-panel-detail")?.toggleAttribute("hidden", credits || lifetime);
  $("#usage-panel-credits")?.toggleAttribute("hidden", !credits);
  $("#usage-panel-lifetime")?.toggleAttribute("hidden", !lifetime);
  // 顶部「今日」KPI 只属于用量明细页；积分/历史各自有自己的卡片，同时显示会串口径。
  $("#usage-today-kpis")?.toggleAttribute("hidden", credits || lifetime);
  document.querySelectorAll("#usage-subtabs .subtab").forEach((el) => {
    el.classList.toggle("active", el.dataset.usageTab === tab);
  });
  if (credits) {
    renderCreditList(state.usageItems);
    paintCreditTodayKpis();
    // 「总扣积分」需要建站至今的汇总，与「历史总调用」同一个接口。
    // 已缓存就不重复请求；未缓存时按需拉一次。
    if (state.lifetimeSummary) {
      paintCreditLifetimeKpi();
    } else {
      loadLifetime().catch(() => paintCreditLifetimeKpi());
    }
  }
  if (lifetime) loadLifetime().catch((err) => toast(err.message, "err"));
}

/**
 * 历史总调用：建站至今累计，与业务日筛选无关。
 * 只在切到该子标签时拉取，避免每次刷新用量都多打一次聚合查询。
 */
async function loadLifetime() {
  const data = await api("/api/gateway/usage/lifetime");
  renderLifetime(data);
}

function renderLifetime(data) {
  const summary = data?.summary || {};
  const span = data?.span || {};
  const calls = Number(summary.calls || 0);
  const fails = Number(summary.fails || 0);

  // 缓存给积分扣减页的「总扣积分」卡复用，避免那边再打一次同样的聚合
  state.lifetimeSummary = {
    calls,
    fails,
    creditCost: Number(summary.creditCost || 0),
    creditUnknown: Number(summary.creditUnknown || 0),
  };
  paintCreditLifetimeKpi();

  const set = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text;
  };

  setCompactValue("#lifetime-calls", calls);
  set("#lifetime-fails", formatNum(fails));
  setCompactValue("#lifetime-prompt", summary.promptTokens);
  setCompactValue("#lifetime-completion", summary.completionTokens);
  setCompactValue("#lifetime-total", summary.totalTokens);

  const failRate = calls > 0 ? (fails / calls) * 100 : 0;
  set("#lifetime-fail-rate", calls > 0 ? t("admin.lifetime.failRate", { rate: failRate.toFixed(2) }) : t("admin.lifetime.noCalls"));

  // 时间跨度：首末调用都换算到业务时区，与「业务日」口径一致。
  const zone = data?.zoneId || "Asia/Shanghai";
  const fmtDay = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat(locale(), {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  };
  const first = fmtDay(span.firstOccurredAt);
  const last = fmtDay(span.lastOccurredAt);
  const spanEl = $("#lifetime-span");
  if (spanEl) {
    if (!first && !last) {
      spanEl.textContent = t("admin.lifetime.spanNone");
      spanEl.title = "";
    } else if (first === last) {
      spanEl.textContent = t("admin.lifetime.spanSince", { date: first });
      spanEl.title = `${span.firstOccurredAt} ~ ${span.lastOccurredAt}`;
    } else {
      spanEl.textContent = `${first} ~ ${last}`;
      spanEl.title = `${span.firstOccurredAt} ~ ${span.lastOccurredAt}`;
    }
  }

  const credit = Number(summary.creditCost || 0);
  const unknown = Number(summary.creditUnknown || 0);
  set("#lifetime-credit", unknown > 0
    ? t("admin.lifetime.creditWithUnknown", { credit: formatNum(credit), unknown: formatNum(unknown) })
    : t("admin.lifetime.credit", { credit: formatNum(credit) }));

  // 来源构成：解释「总数」里多少是已计费、多少是估算/未知，避免只看总数误判。
  const root = $("#lifetime-breakdown");
  if (!root) return;
  const rows = [
    [t("admin.lifetime.row.all"), calls, t("admin.lifetime.note.all")],
    [t("admin.lifetime.row.known"), Number(summary.knownCalls || 0), t("admin.lifetime.note.known")],
    [t("admin.lifetime.row.estimated"), Number(summary.estimatedCalls || 0), t("admin.lifetime.note.estimated")],
    [t("admin.lifetime.row.unknown"), Number(summary.unknownCalls || 0), t("admin.lifetime.note.unknown")],
    [t("admin.lifetime.row.failed"), fails, t("admin.lifetime.note.failed")],
  ];
  root.innerHTML = rows.map(([label, value, note]) => `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td class="num">${escapeHtml(formatNum(value))}</td>
      <td class="muted-text">${escapeHtml(note)}</td>
    </tr>`).join("");
}

function bumpSummary(row) {
  if (!row) return;
  state.usageSummary.calls = (state.usageSummary.calls || 0) + 1;
  if (row.status !== "OK") {
    state.usageSummary.fails = (state.usageSummary.fails || 0) + 1;
  } else {
    state.usageSummary.promptTokens += Number(row.promptTokens || 0);
    state.usageSummary.completionTokens += Number(row.completionTokens || 0);
    state.usageSummary.totalTokens += Number(row.totalTokens || 0);
  }
  paintUsageKpis();
}

/**
 * 刷新「用量明细」页的 KPI。
 * token 字段可达千万级以上，卡片 overflow:hidden 会把千分位原值裁掉，
 * 因此只有计数类走千分位，token 类走紧凑格式（原值放 title）。
 * 首次渲染与 SSE 增量更新必须走同一套规则，否则数字会跳动。
 */
function paintUsageKpis() {
  document.querySelectorAll("#view-usage [data-k]").forEach((el) => {
    const raw = state.usageSummary[el.dataset.k];
    if (el.dataset.k.endsWith("Tokens")) {
      setCompactValue(`#view-usage [data-k="${el.dataset.k}"]`, raw);
    } else {
      el.textContent = formatNum(raw);
    }
  });
}

/**
 * 用量空态：整句走词表，句中路径用 {code} 占位再拆开包 <code>，
 * 避免把一句话拆成两半拼接（中英语序不同）。
 */
function usageEmptyHtml() {
  const parts = t("admin.usage.empty").split("{code}");
  const path = `<code>/v1/chat/completions</code>`;
  return parts.map((part) => escapeHtml(part)).join(path);
}

function renderUsageList(items, { flashNew = false } = {}) {
  const root = $("#usage-list");
  if (!root) return;
  state.usageItems = items || [];
  renderCreditList(state.usageItems);
  if (!items || !items.length) {
    root.innerHTML = `<tr><td colspan="11"><div class="empty">${usageEmptyHtml()}</div></td></tr>`;
    return;
  }
  root.innerHTML = items.map((row, idx) => usageRowHtml(row, flashNew && idx === 0)).join("");
}

function prependUsageRow(row) {
  if (!row || !row.id) return;
  if (!isViewingCurrentBusinessDay()) return;
  const occurredAt = Date.parse(row.occurredAt || "");
  const from = Date.parse(state.usageRange.from);
  const to = Date.parse(state.usageRange.to);
  if (!Number.isFinite(occurredAt) || occurredAt < from || occurredAt >= to) return;
  if (state.usageItems.some((x) => x.id === row.id)) return;
  state.usageItems = [row, ...state.usageItems].slice(0, 200);
  bumpSummary(row);
  renderCreditList(state.usageItems);
  const root = $("#usage-list");
  if (!root) return;
  const empty = root.querySelector(".empty");
  if (empty) {
    root.innerHTML = usageRowHtml(row, true);
    return;
  }
  root.insertAdjacentHTML("afterbegin", usageRowHtml(row, true));
  while (root.children.length > 200) root.removeChild(root.lastElementChild);
}

function isViewingCurrentBusinessDay() {
  const range = state.usageRange;
  if (!state.usageLive || !range || (state.usageDate && state.usageDate !== range.date)) return false;
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const now = Date.now();
  return Number.isFinite(from) && Number.isFinite(to) && from <= now && now < to;
}

function setConnState(connected, text) {
  const badge = $("#usage-conn-state");
  const dot = $("#usage-live-dot");
  const liveBadge = $("#usage-live-badge");
  if (badge) {
    badge.textContent = text || (connected ? t("admin.usage.conn.connected") : t("admin.usage.conn.disconnected"));
    badge.className = `conn ${connected ? "ok-text" : "muted-text"}`;
  }
  if (liveBadge) {
    liveBadge.hidden = !isViewingCurrentBusinessDay();
    liveBadge.style.display = liveBadge.hidden ? "none" : "";
  }
  if (dot) {
    dot.hidden = state.view !== "usage";
    dot.classList.toggle("off", !connected || !isViewingCurrentBusinessDay());
  }
}

async function loadUsage() {
  const requestSeq = ++state.usageRequestSeq;
  const requestedDate = state.usageDate;
  const params = new URLSearchParams({ limit: "50" });
  if (requestedDate) params.set("date", requestedDate);
  const data = await api(`/api/gateway/usage?${params}`);
  if (requestSeq !== state.usageRequestSeq || requestedDate !== state.usageDate) return;
  state.usageLive = data.live === true;
  renderUsageRange(data.range);
  renderUsageSummary(data.summary);
  renderUsageList(data.items || [], { flashNew: false });
  const live = isViewingCurrentBusinessDay();
  const connected = Boolean(live && state.usageEs && window.EventSource
    && state.usageEs.readyState === window.EventSource.OPEN);
  setConnState(connected, live
    ? t(connected ? "admin.usage.conn.connected" : "admin.usage.conn.connecting")
    : t("admin.usage.conn.paused"));
}

// 展示当前统计口径（业务日 + 时区），让前后端「今日」可核对。
function renderUsageRange(range) {
  state.usageRange = range || null;
  const el = $("#usage-range-sub");
  if (!el) return;
  if (!range) {
    el.textContent = t("member.usage.rangeNone");
    return;
  }
  el.textContent = t("member.usage.range", { date: range.date, zone: range.zoneId });
  el.title = `${range.from} ~ ${range.to}`;
}

function stopUsageWatch() {
  if (state.usageEs) {
    state.usageEs.close();
    state.usageEs = null;
  }
  if (state.usagePollTimer) {
    clearInterval(state.usagePollTimer);
    state.usagePollTimer = null;
  }
  setConnState(false, t("admin.usage.conn.paused"));
  const dot = $("#usage-live-dot");
  if (dot) dot.hidden = true;
}

function startUsageWatch() {
  stopUsageWatch();
  const dot = $("#usage-live-dot");
  if (dot) {
    dot.hidden = false;
    dot.classList.remove("off");
  }
  setConnState(false, t("admin.usage.conn.connecting"));

  try {
    const es = new EventSource("/api/gateway/usage/stream");
    state.usageEs = es;
    es.addEventListener("hello", () => setConnState(isViewingCurrentBusinessDay(),
      isViewingCurrentBusinessDay() ? t("admin.usage.conn.connected") : t("admin.usage.conn.paused")));
    es.addEventListener("usage", (ev) => {
      try {
        const row = JSON.parse(ev.data);
        prependUsageRow(row);
      } catch {
        // ignore bad payload
      }
    });
    es.onerror = () => setConnState(false, isViewingCurrentBusinessDay()
      ? t("admin.usage.conn.reconnecting") : t("admin.usage.conn.paused"));
  } catch {
    setConnState(false, t("admin.usage.conn.unavailable"));
  }

  state.usagePollTimer = setInterval(() => {
    if (state.view !== "usage") return;
    loadUsage().catch(() => {});
  }, 8000);
}

/* ---------- Credits ---------- */

function startCreditWatch() {
  stopCreditWatch();
  // 进入账号页只读库里的快照；全量上游刷新改手动，或每 5 分钟静默补一次。
  state.creditTimer = setInterval(() => {
    if (state.view !== "accounts" || state.creditRefreshing) return;
    refreshCredits(true).catch(() => {});
  }, 300_000);
}

function stopCreditWatch() {
  if (state.creditTimer) {
    clearInterval(state.creditTimer);
    state.creditTimer = null;
  }
}

async function refreshCredits(silent = false) {
  if (state.creditRefreshing) {
    if (!silent) toast(t("admin.credits.toast.refreshing"), "warn");
    return;
  }
  state.creditRefreshing = true;
  const btn = $("#btn-refresh-credits");
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("admin.credits.querying");
  }
  try {
    const result = await api("/api/accounts/credits/refresh?onlyEnabled=true", { method: "POST" });
    await loadAccounts();
    if (!silent) {
      if (result?.failed) {
        toast(t("admin.credits.toast.batchFailed", { ok: result.ok, failed: result.failed }), result.ok ? "warn" : "err");
      } else if (result?.total === 0) {
        toast(t("admin.credits.toast.noAccounts"), "warn");
      } else {
        toast(t("admin.credits.toast.batchDone", { count: result?.ok ?? 0 }), "ok");
      }
    }
  } catch (err) {
    if (!silent) toast(err.message, "err");
  } finally {
    state.creditRefreshing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function refreshOneCredit(id, btn, accountName) {
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("admin.credits.querying");
  }
  try {
    const account = await api(`/api/accounts/${id}/credits/refresh`, { method: "POST" });
    if (!account) throw new Error(t("admin.credits.toast.invalidResponse"));
    await loadAccounts();
    if (account.creditsStatus === "FAIL") {
      toast(t("admin.credits.toast.queryFailed", {
        name: accountName, message: account.creditsMessage || t("admin.credits.queryFailed"),
      }), "err");
    } else if (account.credits != null) {
      toast(t("admin.credits.toast.balance", { name: accountName, amount: formatNum(account.credits) }), "ok");
    } else if (account.creditBuckets?.length) {
      toast(t("admin.credits.toast.quotaUpdated", { name: accountName }), "ok");
    } else if (account.creditsMessage) {
      toast(t("admin.credits.toast.queryNote", { name: accountName, message: account.creditsMessage }),
        account.creditsUnlimited ? "ok" : "warn");
    } else {
      toast(t("admin.credits.toast.noQuotaData", { name: accountName }), "warn");
    }
    return account;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

/* ---------- Dialogs / forms ---------- */

function renderCredFields(platform, values = {}) {
  const supportsLogin = accountAuthSupported(platform);
  $("#pool-account-hint").hidden = !supportsLogin;
  $("#pool-account-hint").textContent = t(platform === "TRAE" ? "pool.traeAccountHint" : "pool.accountHint");
  $("#btn-save-authorize").hidden = !supportsLogin;
  const fields = CRED_FIELDS[platform] || [];
  $("#cred-fields").innerHTML = fields.map((f) => {
    const field = f.type === "select"
      ? `<select name="cred_${f.name}">${f.options.map((option) =>
          `<option value="${escapeHtml(option.value)}" ${values[f.name] === option.value ? "selected" : ""}>${escapeHtml(option.labelKey ? t(option.labelKey) : option.label)}</option>`
        ).join("")}</select>`
      : `<input name="cred_${f.name}" type="${f.type}" ${f.required ? "required" : ""}
          autocomplete="${f.type === "password" ? "new-password" : "off"}"
          placeholder="${escapeHtml(f.placeholderKey ? t(f.placeholderKey) : "")}" value="${escapeHtml(values[f.name] || "")}" />`;
    const row = `<label>${escapeHtml(t(f.labelKey))}${field}</label>`;
    return platform === "TRAE" && f.name === "session"
      ? `<details><summary>${escapeHtml(t("pool.traeManualAdvanced"))}</summary>${row}</details>` : row;
  }).join("");
}

function openAccountDialog(account = null) {
  state.editingId = account ? account.id : null;
  $("#dlg-title").textContent = account ? t("admin.accounts.dlg.edit") : t("admin.accounts.dlg.create");
  const form = $("#form-account");
  form.name.value = account?.name || "";
  form.platform.value = account?.platform || "WORKBUDDY";
  form.remark.value = account?.remark || "";
  form.enabled.checked = account ? !!account.enabled : true;
  const values = account?.platform === "CODEX" || account?.platform === "ZCODE" || account?.platform === "MIMO"
      || account?.platform === "CLAUDE" || account?.platform === "GEMINI" || account?.platform === "GROK"
      ? account.credentialsMasked || {} : poolLoginPlatform(account?.platform) ? { runtimeHome: account?.credentialsMasked?.runtimeHome || "" } : {};
  renderCredFields(form.platform.value, values);
  $("#dlg-account").showModal();
}

async function submitAccount(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel" || event.submitter?.dataset?.closeDlg !== undefined) {
    event.target.closest("dialog")?.close();
    return;
  }
  const form = $("#form-account");
  const platform = form.platform.value;
  const credentials = {};
  for (const f of CRED_FIELDS[platform] || []) {
    const value = form[`cred_${f.name}`]?.value?.trim();
    const current = state.accounts.find(a => a.id === state.editingId);
    const unchangedDirectory = f.name === "runtimeHome" && current?.platform === platform && value === current.credentialsMasked?.runtimeHome;
    if (value && !unchangedDirectory) credentials[f.name] = value;
  }
  if (!Object.keys(credentials).length && !state.editingId && !accountAuthSupported(platform)) {
    toast(t("admin.accounts.err.needCredential"), "err");
    return;
  }

  const payload = {
    name: form.name.value.trim(),
    platform,
    credentials,
    enabled: form.enabled.checked,
    remark: form.remark.value.trim() || null,
  };

  try {
    let saved;
    if (state.editingId) {
      if (!Object.keys(credentials).length) {
        if (!accountAuthSupported(platform)) {
          toast(t("admin.accounts.err.repasteCredential"), "err");
          return;
        }
        delete payload.credentials;
      }
      saved = await api(`/api/accounts/${state.editingId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast(t("admin.accounts.toast.updated"), "ok");
    } else {
      saved = await api("/api/accounts", { method: "POST", body: JSON.stringify(payload) });
      toast(t("admin.accounts.toast.created"), "ok");
    }
    $("#dlg-account").close();
    await loadAccounts();
    if (event.submitter?.value === "authorize") {
      const account = state.accounts.find(a => a.id === (saved?.id || state.editingId));
      if (account) await startAccountAuth(account);
      else toast(t("pool.loginFromList"), "ok");
    }
  } catch (err) {
    toast(err.message, "err");
  }
}

async function submitKey(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel" || event.submitter?.dataset?.closeDlg !== undefined) {
    event.target.closest("dialog")?.close();
    return;
  }
  const form = $("#form-key");
  const payload = {
    name: form.name.value.trim(),
    allowedIps: form.allowedIps.value?.trim() || null,
    rateLimitPerMinute: form.rateLimitPerMinute.value ? Number(form.rateLimitPerMinute.value) : null,
    expiresAt: form.expiresAt?.value ? new Date(form.expiresAt.value).toISOString() : null,
  };
  if (form.boundPlatform.value) payload.boundPlatform = form.boundPlatform.value;
  const effortPolicy = readEffortPolicy(form);
  if (effortPolicy) payload.effortPolicy = effortPolicy;
  try {
    const created = await api("/api/keys", { method: "POST", body: JSON.stringify(payload) });
    $("#dlg-key").close();
    form.reset();
    await loadKeys();
    showKeyCreated(created.plaintext);
  } catch (err) {
    toast(err.message, "err");
  }
}

// 复制样本：代码块不进词表（用户粘贴到终端），仅注释按语言切换。
function usageSample(key) {
  const base = location.origin + "/v1";
  return `# curl
curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"wb/hy3","messages":[{"role":"user","content":"${t("admin.key.sample.hello")}"}],"stream":false}'

# Python (openai>=1.0)
from openai import OpenAI
client = OpenAI(api_key="${key}", base_url="${base}")
r = client.chat.completions.create(
    model="wb/hy3",  ${t("admin.key.sample.orComment")}
    messages=[{"role": "user", "content": "${t("admin.key.sample.hello")}"}],
)
print(r.choices[0].message.content)`;
}

function showKeyCreated(plaintext) {
  const dlg = $("#dlg-key-created");
  const input = $("#key-plaintext");
  input.value = plaintext;
  $("#key-usage-sample").textContent = usageSample(plaintext);
  dlg.showModal();
  input.focus();
  input.select();
}

async function copyText(text, btn, okText) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = okText || t("member.copy.done");
    setTimeout(() => { btn.textContent = old; }, 1600);
    toast(t("member.copy.toast"), "ok");
  } catch {
    const input = $("#key-plaintext");
    if (input && text === input.value) {
      input.focus();
      input.select();
    }
    toast(t("admin.copy.manual"), "warn");
  }
}

async function checkinAll() {
  const result = await api("/api/checkin/all?onlyEnabled=true", { method: "POST" });
  toast(t("admin.checkin.toast.done", { ok: result.success, already: result.already, fail: result.failed }), result.failed ? "err" : "ok");
  if (state.view === "overview") await loadOverview();
  else await Promise.all([loadAccounts(), loadRecords()]);
}

/* ---------- Bind ---------- */

function bind() {
  bindPoolUI();
  const backupTemplate = $("#backup-overview-template");
  if (backupTemplate) {
    $("#view-overview").append(backupTemplate.content.cloneNode(true));
    backupTemplate.remove();
    window.loeanI18n?.apply($("#view-overview"));
    if (typeof bindAdminBackupStatus === "function") bindAdminBackupStatus();
  }
  document.addEventListener("toggle", (event) => {
    if (event.newState === "open" && event.target.matches?.(".row-popover")) {
      positionRowPopover(event.target);
    }
  }, true);

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => setView(el.dataset.view));
  });

  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", () => setView(el.dataset.goto));
  });

  $("#btn-checkin-all").addEventListener("click", () => {
    checkinAll().catch((e) => toast(e.message, "err"));
  });
  $("#btn-checkin-all-2").addEventListener("click", () => {
    checkinAll().catch((e) => toast(e.message, "err"));
  });

  $("#btn-new").addEventListener("click", () => openAccountDialog());
  $("#btn-new-key").addEventListener("click", () => $("#dlg-key").showModal());
  $("#btn-new-member")?.addEventListener("click", () => openMemberDialog());
  $("#btn-new-rate")?.addEventListener("click", () => openRateDialog());
  $("#btn-billing-refresh")?.addEventListener("click", () => {
    loadBilling().catch((e) => toast(e.message, "err"));
  });
  document.querySelectorAll("#billing-subtabs .subtab").forEach((el) => {
    el.addEventListener("click", () => setBillingTab(el.dataset.billingTab));
  });
  $("#form-billing-rate")?.addEventListener("submit", (e) => {
    submitBillingRate(e).catch((err) => toast(err.message, "err"));
  });
  $("#form-billing-wallet")?.addEventListener("submit", (e) => {
    submitBillingWallet(e).catch((err) => toast(err.message, "err"));
  });
  $("#form-billing-wallet")?.addEventListener("input", updateWalletPreview);
  $("#form-billing-wallet")?.addEventListener("change", updateWalletPreview);
  $("#form-billing-review")?.addEventListener("submit", (e) => {
    submitBillingReview(e).catch((err) => toast(err.message, "err"));
  });
  $("#billing-rate-list")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-billing-act]");
    if (!btn || !requireBillingRatesReady()) return;
    const tr = btn.closest("tr[data-rate-id]");
    const id = tr?.dataset.rateId;
    const rate = (state.billingRates || []).find((r) => r.id === id);
    if (!rate) return;
    try {
      if (btn.dataset.billingAct === "edit-rate") {
        openRateDialog(rate);
      } else if (btn.dataset.billingAct === "toggle-rate") {
        await api(`/api/billing/rates/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ enabled: !rate.enabled }),
        });
        await loadBilling();
      } else if (btn.dataset.billingAct === "del-rate") {
        if (!(await uiConfirm(t("admin.billing.rate.confirmDel", { model: rate.model })))) return;
        await api(`/api/billing/rates/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast(t("admin.toast.deleted"), "ok");
        await loadBilling();
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#btn-seed-rate-drafts")?.addEventListener("click", () => {
    seedRateDrafts().catch((e) => toast(e.message, "err"));
  });
  $("#btn-new-rate-draft")?.addEventListener("click", () => openRateDraftDialog());
  $("#rate-draft-platform-filter")?.addEventListener("change", (e) => {
    state.rateDraftPlatform = e.target.value || "";
    renderBillingRateDrafts();
  });
  $("#form-billing-rate-draft")?.addEventListener("submit", (e) => {
    submitBillingRateDraft(e).catch((err) => toast(err.message, "err"));
  });
  $("#billing-rate-draft-list")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-billing-act]");
    if (!btn || !requireBillingServerReady()) return;
    const tr = btn.closest("tr[data-rate-draft-id]");
    const id = tr?.dataset.rateDraftId;
    const draft = (state.rateDrafts || []).find((r) => r.id === id);
    if (!draft) return;
    try {
      if (btn.dataset.billingAct === "edit-rate-draft") {
        openRateDraftDialog(draft);
      } else if (btn.dataset.billingAct === "apply-rate-draft") {
        const isUsd = draft.cnyPreview && draft.cnyPreview.rate;
        const foreign = draft.currency && draft.currency !== "CNY";
        const confirmed = await uiConfirm(isUsd
          ? t("admin.billing.draft.confirmApplyUsd", {
            model: draft.model,
            prompt: renderRateDraftCell(draft.promptPer1m, draft.currency),
            completion: renderRateDraftCell(draft.completionPer1m, draft.currency),
            rate: draft.cnyPreview.rate,
            cnyPrompt: "¥" + draft.cnyPreview.promptPer1m,
            cnyCompletion: "¥" + draft.cnyPreview.completionPer1m,
          })
          : foreign
          ? t("admin.billing.draft.confirmApplyForeign", {
            model: draft.model,
            prompt: renderRateDraftCell(draft.promptPer1m, draft.currency),
            completion: renderRateDraftCell(draft.completionPer1m, draft.currency),
            currency: draft.currency,
          })
          : t("admin.billing.draft.confirmApply", {
            model: draft.model,
            prompt: renderRateDraftCell(draft.promptPer1m, draft.currency),
            completion: renderRateDraftCell(draft.completionPer1m, draft.currency),
          }));
        if (!confirmed) return;
        await api(`/api/billing/rate-drafts/${encodeURIComponent(id)}/apply`, { method: "POST" });
        toast(t("admin.billing.draft.toast.applied"), "ok");
        await loadBilling();
      } else if (btn.dataset.billingAct === "del-rate-draft") {
        if (!(await uiConfirm(t("admin.billing.draft.confirmDel", { model: draft.model })))) return;
        await api(`/api/billing/rate-drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast(t("admin.toast.deleted"), "ok");
        await loadBilling();
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#billing-wallet-list")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-billing-act]");
    if (!btn || !requireBillingServerReady()) return;
    const tr = btn.closest("tr[data-member-id]");
    const memberId = tr?.dataset.memberId;
    if (!memberId) return;
    try {
      if (btn.dataset.billingAct === "ensure-wallet") {
        await api(`/api/billing/wallets/${encodeURIComponent(memberId)}/ensure`, { method: "POST" });
        toast(t("admin.billing.wallet.toast.opened"), "ok");
        await loadBilling();
      } else if (btn.dataset.billingAct === "wallet-op") {
        openWalletDialog(memberId, btn.dataset.walletName || memberLabelById(memberId));
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#billing-ledger-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-billing-ledger-act]");
    const ledgerId = button?.closest("tr[data-ledger-id]")?.dataset.ledgerId;
    const entry = (state.billingLedger || []).find((row) => row.id === ledgerId);
    if (button && entry) openBillingReviewDialog(entry, button.dataset.billingLedgerAct);
  });
  $("#btn-check-creds")?.addEventListener("click", async () => {
    try {
      const results = await api("/api/credentials/check?onlyEnabled=true", { method: "POST" });
      const bad = (results || []).filter((r) => r.status !== "OK").length;
      toast(t("admin.credentials.toast.checked", { count: results?.length || 0, bad }), bad ? "err" : "ok");
      await loadAccounts();
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#form-key-edit")?.addEventListener("submit", submitKeyEdit);
  $("#form-member")?.addEventListener("submit", submitMember);
  $("#login-gate")?.addEventListener("keydown", trapLoginFocus);
  $("#form-login")?.addEventListener("submit", submitLogin);
  $("#form-password")?.addEventListener("submit", submitPasswordChange);
  $("#btn-change-password")?.addEventListener("click", () => {
    const err = $("#password-error");
    if (err) err.hidden = true;
    $("#form-password")?.reset();
    $("#dlg-password")?.showModal();
  });
  $("#btn-logout")?.addEventListener("click", async () => {
    if (!(await uiConfirm(t("common.logout.confirm"), {
      title: t("admin.logout"),
      okText: t("admin.logout"),
      danger: false,
    }))) return;
    logout().catch((e) => toast(e.message, "err"));
  });
  $("#usage-date")?.addEventListener("change", (e) => {
    state.usageDate = e.target.value || "";
    setConnState(false, t("admin.usage.conn.paused"));
    loadUsage().catch((err) => toast(err.message, "err"));
  });
  $("#btn-refresh-credits").addEventListener("click", () => refreshCredits(false));
  $("#btn-usage-refresh").addEventListener("click", () => loadUsage().catch((e) => toast(e.message, "err")));
  $("#usage-subtabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-usage-tab]")?.dataset.usageTab;
    if (tab) setUsageTab(tab);
  });
  $("#btn-lifetime-refresh")?.addEventListener("click", () => loadLifetime().catch((e) => toast(e.message, "err")));
  $("#btn-records").addEventListener("click", () => loadRecords().catch((e) => toast(e.message, "err")));

  $("#sel-platform").addEventListener("change", (e) => renderCredFields(e.target.value));
  $("#form-account").addEventListener("submit", submitAccount);
  $("#form-key").addEventListener("submit", submitKey);

  $("#account-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    if (chip.dataset.filter) {
      state.platformFilter = chip.dataset.filter;
    } else if (chip.dataset.status) {
      state.statusFilter = state.statusFilter === chip.dataset.status ? "ALL" : chip.dataset.status;
    }
    document.querySelectorAll("#account-filters .chip").forEach((c) => {
      const on = (c.dataset.filter && c.dataset.filter === state.platformFilter)
        || (c.dataset.status && c.dataset.status === state.statusFilter);
      c.classList.toggle("active", !!on);
    });
    // platform chips are exclusive; keep ALL active when no platform match on status-only click
    if (state.platformFilter === "ALL") {
      document.querySelector('#account-filters .chip[data-filter="ALL"]')?.classList.add("active");
    }
    renderAccountList();
  });

  $("#account-search").addEventListener("input", (e) => {
    state.search = e.target.value || "";
    renderAccountList();
  });

  $("#account-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const popover = btn.closest(".row-popover");
    if (popover?.matches(":popover-open")) popover.hidePopover();
    const id = btn.closest("tr")?.dataset.id;
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return;
    try {
      const act = btn.dataset.act;
      if (act === "authorize") {
        await startAccountAuth(account);
      } else if (act === "checkin") {
        const r = await api(`/api/checkin/accounts/${id}`, { method: "POST" });
        const bad = r.result.status === "FAILED" || r.result.status === "AUTH_ERROR";
        toast(r.result.credits != null
          ? t("admin.accounts.toast.checkinWithCredits", { name: r.accountName, status: r.result.status, message: r.result.message || "", credits: r.result.credits })
          : t("admin.accounts.toast.checkin", { name: r.accountName, status: r.result.status, message: r.result.message || "" }), bad ? "err" : "ok");
        await Promise.all([loadAccounts(), loadRecords()]);
      } else if (act === "ping") {
        btn.disabled = true;
        btn.textContent = "…";
        try {
          const r = await api(`/api/accounts/${id}/ping`, { method: "POST" });
          toast(
            r.ok
              ? t("admin.accounts.toast.pingOk", { name: r.accountName, latency: r.latencyMs, message: r.message || "" })
              : t("admin.accounts.toast.pingFail", { name: r.accountName, latency: r.latencyMs, message: r.message || "" }),
            r.ok ? "ok" : "err"
          );
        } finally {
          btn.disabled = false;
          btn.textContent = "Ping";
        }
      } else if (act === "toggle") {
        await api(`/api/accounts/${id}/enabled?enabled=${!account.enabled}`, { method: "PATCH" });
        await loadAccounts();
      } else if (act === "refresh-credit") {
        await refreshOneCredit(id, btn, account.name);
      } else if (act === "check-cred") {
        btn.disabled = true;
        const r = await api(`/api/credentials/check/${id}`, { method: "POST" });
        toast(r.remainingDays != null && r.remainingDays >= 0
          ? t("admin.accounts.toast.credCheckWithDays", { name: r.accountName, status: r.status, days: r.remainingDays, message: r.message || "" })
          : t("admin.accounts.toast.credCheck", { name: r.accountName, status: r.status, message: r.message || "" }), r.status === "OK" ? "ok" : "err");
        await loadAccounts();
      } else if (act === "edit") {
        openAccountDialog(account);
      } else if (act === "del") {
        if (!(await uiConfirm(t("admin.accounts.confirmDel", { name: account.name })))) return;
        await api(`/api/accounts/${id}`, { method: "DELETE" });
        toast(t("admin.toast.deleted"), "ok");
        await loadAccounts();
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#key-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const popover = btn.closest(".row-popover");
    if (popover?.matches(":popover-open")) popover.hidePopover();
    const id = btn.closest("tr")?.dataset.id;
    const key = (state.keys || []).find((k) => k.id === id);
    if (!id) return;
    try {
      const act = btn.dataset.act;
      if (act === "copy-prefix") {
        if (key) await copyText(key.keyPrefix, btn, "✓");
      } else if (act === "revoke") {
        if (!(await uiConfirm(t("admin.keys.confirmRevoke")))) return;
        await api(`/api/keys/${id}`, { method: "DELETE" });
        await loadKeys();
      } else if (act === "delete-key") {
        if (key?.ownerMemberId) {
          toast(t("admin.keys.err.memberOwned"), "err");
          return;
        }
        if (!(await uiConfirm(
          key ? t("admin.keys.confirmDelete", { name: key.name }) : t("admin.keys.confirmDeleteUnnamed"),
          { title: t("admin.keys.dlgTitle.delete"), okText: t("admin.keys.okText.delete") }
        ))) return;
        await api(`/api/keys/${id}/permanent`, { method: "DELETE" });
        toast(t("admin.keys.toast.deleted"), "ok");
        await loadKeys();
      } else if (act === "edit-key") {
        if (key) openKeyEditDialog(key);
      } else if (act === "toggle-key") {
        if (!key) return;
        await api(`/api/keys/${id}/enabled?enabled=${!key.enabled}`, { method: "PATCH" });
        await loadKeys();
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#member-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const id = btn.closest("tr")?.dataset.id;
    const member = (state.members || []).find((item) => item.id === id);
    if (!member) return;
    try {
      if (btn.dataset.act === "edit-member") {
        openMemberDialog(member);
      } else if (btn.dataset.act === "member-wallet") {
        openWalletDialog(member.id, `${member.displayName || member.username} (@${member.username || "—"})`);
      } else if (btn.dataset.act === "toggle-member") {
        const nextEnabled = !member.enabled;
        if (!(await uiConfirm(nextEnabled
          ? t("admin.members.confirmEnable", { name: member.displayName })
          : t("admin.members.confirmDisable", { name: member.displayName })))) return;
        await api(`/api/members/${encodeURIComponent(member.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        toast(nextEnabled ? t("admin.members.toast.enabled") : t("admin.members.toast.disabled"), "ok");
        await loadMembers();
      } else if (btn.dataset.act === "rotate-member-key") {
        await rotateMemberKey(member);
      } else if (btn.dataset.act === "del-member") {
        if (!(await confirmDeleteMember(member))) return;
        await api(`/api/members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
        toast(t("admin.members.toast.deleted"), "ok");
        // 双面板同步：成员列表、钱包、计费状态与流水一次性刷新。
        await Promise.allSettled([loadMembers(), loadBilling()]);
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#record-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act='del-record']");
    if (!btn) return;
    const id = btn.closest("tr")?.dataset.id;
    if (!id || !(await uiConfirm(t("admin.records.confirmDel")))) return;
    try {
      await api(`/api/checkin/records/${id}`, { method: "DELETE" });
      await loadRecords();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#btn-del-all-records").addEventListener("click", async () => {
    if (!(await uiConfirm(t("admin.records.confirmClear"), { title: t("admin.records.dlgTitle.clear"), okText: t("admin.records.okText.clearAll") }))) return;
    try {
      await api("/api/checkin/records", { method: "DELETE" });
      toast(t("admin.records.toast.cleared"), "ok");
      await loadRecords();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  document.querySelectorAll("dialog [data-close-dlg]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.currentTarget.closest("dialog")?.close();
    });
  });

  $("#btn-copy-key").addEventListener("click", (e) => {
    copyText($("#key-plaintext").value, e.currentTarget, t("member.copy.done"));
  });
  $("#btn-copy-usage").addEventListener("click", (e) => {
    copyText($("#key-usage-sample").textContent, e.currentTarget, t("member.copy.done"));
  });
  $("#btn-copy-member-key")?.addEventListener("click", (e) => {
    copyText($("#member-key-plaintext").value, e.currentTarget, t("member.copy.done"));
  });
  $("#btn-close-key-created").addEventListener("click", () => {
    $("#dlg-key-created").close();
    $("#key-plaintext").value = "";
    $("#key-usage-sample").textContent = "";
  });
  $("#btn-close-member-key")?.addEventListener("click", () => {
    $("#dlg-member-key")?.close();
    $("#member-key-plaintext").value = "";
  });
}

/* 语言切换后，动态渲染的内容不会自己变（词表只重写带 data-i18n 的静态节点），
   所以这里按当前视图重新跑一遍渲染函数。只重渲染当前视图，不重新取数。 */
function rerenderForLanguage() {
  const renderers = {
    overview: () => {
      renderOverviewKpis();
      renderOverviewHealth();
      renderOverviewRecent();
    },
    accounts: () => {
      updateFilterCounts();
      renderAccountList();
    },
    models: () => renderPoolModels(),
    members: () => renderMemberList(),
    billing: () => {
      renderBillingStatus();
      renderBillingRates();
      renderBillingWallets();
      renderBillingLedger();
    },
    usage: () => {
      renderUsageSummary(state.usageSummary);
      renderUsageRange(state.usageRange);
      renderUsageList(state.usageItems, { flashNew: false });
      setUsageTab(state.usageTab || "usage");
    },
    keys: () => renderKeyList(),
    records: () => renderRecordList(),
  };
  renderers[state.view]?.();
  // 登录门/口令弹窗等静态壳由 i18n.apply 处理，这里只补动态标题
  if (!state.admin.authenticated) setLoginMode(state.admin.setupRequired);

  /* 已打开的对话框不会随视图重渲染：凭证字段的 label/placeholder 是在
     openAccountDialog 时一次性拼进 DOM 的，切语言不重建就会留在旧语言。
     这里按当前平台重放一次，并保留用户已填的值，避免切换语言丢输入。 */
  const accountDlg = document.getElementById("dlg-account");
  if (accountDlg?.open) {
    const platform = document.getElementById("form-account")?.platform?.value;
    if (platform) {
      const kept = {};
      document.querySelectorAll('#cred-fields [name^="cred_"]').forEach((el) => {
        kept[el.name.replace(/^cred_/, "")] = el.value;
      });
      renderCredFields(platform, kept);
    }
    const titleEl = document.getElementById("dlg-title");
    if (titleEl) {
      titleEl.textContent = state.editingId
        ? t("admin.accounts.dlg.edit")
        : t("admin.accounts.dlg.create");
    }
  }
  /* 其余对话框的标题由 JS 写，同样要跟着语言走 */
  if (document.getElementById("dlg-confirm")?.open) {
    const el = document.getElementById("dlg-confirm-title");
    if (el) el.textContent = t("admin.dlg.confirm");
    const cancelBtn = document.getElementById("dlg-confirm-cancel");
    if (cancelBtn) cancelBtn.textContent = t("admin.dlg.cancel");
  }
  if (document.getElementById("dlg-member")?.open) {
    /* 编辑态的真值在表单的 hidden id 里（见 openMemberDialog），不另设 state */
    const editing = !!(document.getElementById("form-member")?.id?.value);
    const el = document.getElementById("member-dlg-title");
    if (el) el.textContent = editing
      ? t("admin.members.dlg.edit")
      : t("admin.members.dlg.create");
    const hint = document.getElementById("member-dlg-hint");
    if (hint) hint.textContent = editing
      ? t("admin.members.hint.edit")
      : t("admin.members.hint.create");
    const save = document.getElementById("btn-save-member");
    if (save) save.textContent = editing
      ? t("admin.members.save.edit")
      : t("admin.members.save.create");
    const passwordLabel = document.querySelector("#form-member .member-password-row");
    if (passwordLabel) {
      passwordLabel.firstChild.textContent = editing
        ? t("admin.members.password.reset")
        : t("admin.members.password.initial");
    }
  }
  if (document.getElementById("dlg-billing-wallet")?.open) {
    const el = document.getElementById("billing-wallet-dlg-title");
    if (el) el.textContent = t("admin.billing.wallet.dlgTitle");
  }
  if (document.getElementById("dlg-billing-review")?.open) {
    const action = formField($("#form-billing-review"), "action")?.value;
    const charge = action === "CHARGE";
    $("#billing-review-hint").textContent = t(charge
      ? "admin.billing.ledger.reviewHintCharge" : "admin.billing.ledger.reviewHintRefund");
    $("#btn-billing-review-submit").textContent = t(charge
      ? "admin.billing.ledger.charge" : "admin.billing.ledger.refund");
  }
}

(async function init() {
  bind();
  document.addEventListener("loean:langchange", rerenderForLanguage);
  renderCredFields("WORKBUDDY");
  // 用量页日期筛选默认业务日「今天」（Asia/Shanghai），与后端默认口径一致
  if (window.loeanDatePickers) {
    window.loeanDatePickers.presetToday($("#usage-date"));
    state.usageDate = $("#usage-date")?.value || "";
  }
  const authenticated = await checkAdminSession();
  if (!authenticated) {
    // P0-1：未登录不加载任何管理数据，避免把 401 当成普通错误到处弹
    showLoginGate();
    return;
  }
  hideLoginGate();
  updateNav();
  setView("overview");
})().catch((e) => toast(e.message || String(e), "err"));
