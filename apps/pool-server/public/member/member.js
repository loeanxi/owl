/* 基础 helpers（$ / t / locale / errorText / escapeHtml）来自 shared.js，
   与管理台共用同一份实现，不再各自复制。 */

const memberState = {
  session: null,
  view: "overview",
  overview: null,
  key: null,
  activeKeyId: "",
  usageKeyId: "",
  keySelectionVersion: 0,
  connect: null,
  models: null,
  billing: null,
  billingCurrency: null,
  usage: null,
  trend: null,
  protocol: "openai",
  sampleFormat: "curl",
  ccswitchApp: "claude",
  usageFilter: "ALL",
  usagePage: 0,
  usageRequestId: 0,
  ledgerRows: [],
  ledgerCursor: { before: null, lastId: null, hasMore: false, loading: false },
  modelsKeyword: "",
  highlightRequestId: "",
  playground: { model: "", messages: [], busy: false, meta: null, sessionId: "" },
};

/* 模型下拉的记忆键：接入配置页选过模型后，总览「推荐模型」跟随这个选择。 */
const MEMBER_MODEL_PREF_KEY = "loean-member-model";
/* 模拟调用独立的模型记忆键，避免和接入配置页的推荐模型互相干扰。 */
const PG_MODEL_PREF_KEY = "loean-member-pg-model";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function formatMoney(value) {
  const decimal = formatDecimalAmount(value);
  if (decimal === "—") return decimal;
  return decimal.startsWith("-") ? "-¥" + decimal.slice(1) : "¥" + decimal;
}

function formatLegacyAmount(value) {
  return formatDecimalAmount(value, 0);
}

function isRmbBillingServer() {
  return memberState.billingCurrency === "CNY";
}

function memberRatesReady(rateUnit) {
  return isRmbBillingServer() && rateUnit === "PER_1M_TOKENS";
}

function isLegacyWallet(wallet) {
  return !!wallet.hasWallet && (!isRmbBillingServer() || wallet.migrationRequired
    || (wallet.currency && wallet.currency !== "CNY"));
}

function isHistoricalLedger(entry) {
  return !isRmbBillingServer() || !!entry.historical || !!(entry.currency && entry.currency !== "CNY");
}

function formatLedgerAmount(entry) {
  const decimal = billingDecimalParts(entry.amount);
  if (!decimal) return "—";
  const historical = isHistoricalLedger(entry);
  const money = (amount) => historical
    ? t("billing.legacyAmount", { amount: formatLegacyAmount(amount) })
    : formatMoney(amount);
  const magnitude = decimal.integer + (decimal.fraction ? "." + decimal.fraction : "");
  if (entry.entryType === "USAGE_CHARGE" && ["PENDING", "REVIEW"].includes(entry.status)) {
    const reserved = t("member.billing.reservedAmount", { amount: money(magnitude) });
    return historical ? reserved + " · " + t("billing.legacyRecord") : reserved;
  }
  const negative = (entry.entryType === "USAGE_CHARGE" && entry.status !== "VOIDED")
    || (entry.entryType === "ADJUSTMENT" && entry.balanceBefore != null
      && entry.balanceAfter != null && compareDecimalAmounts(entry.balanceAfter, entry.balanceBefore) < 0);
  const signed = negative && !decimal.zero ? "-" + magnitude : magnitude;
  const amount = (!negative && !decimal.zero ? "+" : "") + money(signed);
  return historical ? amount + " · " + t("billing.legacyRecord") : amount;
}

function formatNum(value) {
  return number(value).toLocaleString(locale(), { maximumFractionDigits: 0 });
}

function formatCompact(value) {
  const amount = number(value);
  if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (amount >= 1_000) return (amount / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return formatNum(amount);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return t("member.time.today", { time });
  return date.toLocaleDateString(locale(), { month: "2-digit", day: "2-digit" }) + " " + time;
}

function humanStatus(status) {
  const value = String(status || "").toUpperCase();
  /* 值是词表 key，取词时再翻译：这样切语言后重新渲染即可得到新语言。 */
  const map = {
    OK: ["ok", "member.status.OK"],
    ABORTED: ["warn", "member.status.ABORTED"],
    FAIL: ["err", "member.status.FAIL"],
    FAILED: ["err", "member.status.FAILED"],
    ACTIVE: ["ok", "member.status.ACTIVE"],
    DISABLED: ["warn", "member.status.DISABLED"],
    EXPIRED: ["err", "member.status.EXPIRED"],
    EXHAUSTED: ["warn", "member.status.EXHAUSTED"],
  };
  const entry = map[value];
  if (entry) return [entry[0], t(entry[1])];
  return ["warn", value || t("member.status.UNKNOWN")];
}

function statusPill(status) {
  const statusInfo = humanStatus(status);
  return '<span class="member-status ' + statusInfo[0] + '">' + escapeHtml(statusInfo[1]) + "</span>";
}

/* 失败环节 → 成员可读的脱敏提示：只说「问题在哪一侧」，不透出上游报文/账号。
   成功调用返回空串，未知类别一律按服务端问题兜底。 */
const MEMBER_ERROR_CAT_KEYS = {
  CLIENT_REQUEST: "member.errorCat.client",
  QUOTA_OR_RATE_LIMIT: "member.errorCat.quota",
  STREAM_INTERRUPTED: "member.errorCat.stream",
  AUTH: "member.errorCat.server",
  UPSTREAM: "member.errorCat.server",
  GATEWAY: "member.errorCat.server",
  UNKNOWN: "member.errorCat.server",
};

function errorCatText(row) {
  if (!row || String(row.status || "").toUpperCase() === "OK") return "";
  const key = MEMBER_ERROR_CAT_KEYS[String(row.errorCategory || "").toUpperCase()];
  return key ? t(key) : "";
}

function formatLatency(value) {
  const ms = number(value);
  if (ms <= 0) return "—";
  return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " s";
}

/* occurredAt → 业务日 YYYY-MM-DD（用后端下发的时区，避免本机时区偏差） */
function businessDayText(value, zoneId) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const zone = zoneId || memberState.overview?.range?.zoneId || "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || "";
    return pick("year") + "-" + pick("month") + "-" + pick("day");
  } catch {
    return "";
  }
}

/* 失败徽标：可点击跳到该业务日的调用记录（未完整成功过滤），带请求编号用于定位闪烁 */
function failedPill(row) {
  const statusInfo = humanStatus(row.status);
  const cat = errorCatText(row);
  const tip = cat ? statusInfo[1] + " · " + cat : t("member.usage.viewFailed");
  return '<button type="button" class="member-status ' + statusInfo[0] + ' member-status-link"'
    + ' data-jump-usage data-jump-date="' + escapeHtml(businessDayText(row.occurredAt)) + '"'
    + ' data-jump-request="' + escapeHtml(row.requestId || "") + '"'
    + ' title="' + escapeHtml(tip) + '">' + escapeHtml(statusInfo[1]) + "</button>";
}

/* Tokens 拆分副行与悬浮明细：只有能确认输入/输出时才展示 */
function tokenSubText(row) {
  if (row.usageSource === "DEFERRED") return "";
  const prompt = number(row.promptTokens);
  const completion = number(row.completionTokens);
  if (!prompt && !completion) return "";
  return t("member.usage.tokSplit", { prompt: formatCompact(prompt), completion: formatCompact(completion) });
}

function tokenTitleText(row) {
  if (row.usageSource === "DEFERRED") return "";
  const prompt = number(row.promptTokens);
  const completion = number(row.completionTokens);
  if (!prompt && !completion) return "";
  let title = t("member.usage.tokTitle", { prompt: formatNum(prompt), completion: formatNum(completion) });
  const read = number(row.cacheReadTokens);
  const write = number(row.cacheWriteTokens);
  if (read || write) {
    title += " · " + t("member.usage.tokCache", { read: formatNum(read), write: formatNum(write) });
  }
  return title;
}

/* 从总览/趋势跳到指定业务日的调用记录；带 requestId 时渲染后闪烁定位那一行 */
function jumpToUsage(dateText, filter, requestId) {
  memberState.usageFilter = filter || "ALL";
  document.querySelectorAll("[data-usage-filter]").forEach((item) => {
    item.classList.toggle("active", item.dataset.usageFilter === memberState.usageFilter);
  });
  const input = $("#member-usage-date");
  if (input && dateText) input.value = dateText;
  memberState.highlightRequestId = requestId || "";
  setMemberView("usage");
}

function billingStatusPill(status) {
  const labels = {
    PENDING: ["warn", "member.billing.statusPending"],
    REVIEW: ["warn", "member.billing.statusReview"],
    POSTED: ["ok", "member.billing.statusPosted"],
    VOIDED: ["err", "member.billing.statusVoided"],
  };
  const entry = labels[String(status || "").toUpperCase()];
  return '<span class="member-status ' + (entry ? entry[0] : "warn") + '">'
    + escapeHtml(entry ? t(entry[1]) : (status || "—")) + "</span>";
}

function showToast(message, kind = "err") {
  const el = $("#member-toast");
  if (!el) return;
  el.textContent = message;
  el.className = "member-login-error" + (kind === "ok" ? " member-toast-ok" : "");
  el.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { el.hidden = true; }, 3600);
}

async function memberApi(path, options = {}) {
  const sessionAtStart = memberState.session;
  if (typeof scopedMemberKeyPath === "function") path = scopedMemberKeyPath(path);
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (sessionAtStart && sessionAtStart !== memberState.session && !["/api/member/login", "/api/member/logout", "/api/member/session"].includes(path.split("?")[0])) {
    throw new Error(t("keymgmt.sessionChanged"));
  }
  if (response.status === 401) {
    const message = errorText(body, "member.error.sessionExpired");
    showLogin(message);
    throw new Error(message || t("member.error.unauthenticated"));
  }
  if (!response.ok || body.success === false) {
    throw new Error(errorText(body, "member.error.requestFailed", { status: response.status }));
  }
  return body.data;
}

function showLogin(message = "") {
  if (typeof clearMemberKeyManagement === "function") clearMemberKeyManagement();
  memberState.session = null;
  memberState.overview = null; memberState.key = null; memberState.models = null;
  memberState.connect = null; memberState.usage = null; memberState.billing = null; memberState.trend = null;
  memberState.playground = { model:"",messages:[],busy:false,meta:null,sessionId:"" };
  $("#member-app").hidden = true;
  $("#member-login-page").hidden = false;
  const error = $("#member-login-error");
  error.textContent = message;
  error.hidden = !message;
  setTimeout(() => $("#member-login-form")?.username?.focus(), 30);
}

function showApp(session) {
  memberState.session = session;
  $("#member-login-page").hidden = true;
  $("#member-app").hidden = false;
  $("#member-rail-name").textContent = session.displayName || session.username || t("member.rail.memberFallback");
  $("#member-rail-username").textContent = session.username ? "@" + session.username : t("member.rail.usernameFallback");
  $("#member-rail-avatar").textContent = (session.displayName || session.username || "成").slice(0, 1).toUpperCase();
  // 速览卡常驻侧栏：先用缓存填一次，再静默拉总览，保证不进总览页也有数据。
  renderRailQuota(memberState.overview);
  refreshRailQuota();
  setMemberView(memberState.view || "overview");
  if (typeof loadMemberKeyManagement === "function") loadMemberKeyManagement().catch(error => showToast(error.message));
}

/* 侧栏速览独立取数：失败时保持占位符，不打断当前视图。 */
function refreshRailQuota() {
  if (memberState.overview) {
    renderRailQuota(memberState.overview);
    return;
  }
  memberApi("/api/member/overview")
    .then((data) => { memberState.overview = data; renderRailQuota(data); })
    .catch(() => {});
}

function setMemberView(view) {
  const allowed = ["overview", "key", "models", "playground", "billing", "connect", "usage"];
  const target = allowed.includes(view) ? view : "overview";
  if (target === "usage" && memberState.view !== "usage") memberState.usagePage = 0;
  memberState.view = target;
  allowed.forEach((name) => {
    const section = $("#member-view-" + name);
    if (section) section.hidden = name !== target;
  });
  document.querySelectorAll("[data-member-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.memberView === target);
  });
  const job = {
    overview: loadOverview,
    key: loadKey,
    models: loadModels,
    playground: loadPlayground,
    billing: loadBilling,
    connect: loadConnect,
    usage: loadUsage,
  }[target];
  job?.().catch((error) => showToast(error.message));
}

async function loadOverview() {
  const selection = memberState.keySelectionVersion;
  const [data, models, trend] = await Promise.all([
    memberApi("/api/member/overview"),
    memberApi("/api/member/models").catch(() => null),
    memberApi("/api/member/trend?days=7").catch(() => null),
  ]);
  if (selection !== memberState.keySelectionVersion) return;
  memberState.overview = data;
  memberState.key = data.key || memberState.key;
  if (models) memberState.models = models;
  memberState.trend = trend;
  memberState.billingCurrency = models?.currency || data.wallet?.currency || null;
  renderOverview(data);
  renderOverviewModels(models || memberState.models);
  renderTrend(trend);
}

/* 钱包余额文案：无钱包 / 旧币种 / 正常人民币三种情况统一在这里处理。
   Token 配额已废弃，余额是唯一需要向成员展示的额度信息。 */
function walletText(wallet) {
  const w = wallet || {};
  if (!w.hasWallet) return t("member.overview.walletNone");
  if (isLegacyWallet(w)) return t("billing.legacyAmount", { amount: formatLegacyAmount(w.balance) });
  return formatMoney(w.balance);
}

function renderOverview(data) {
  const key = data.key || {};
  const today = data.today || {};
  const recent = data.recent || [];
  const latest = recent[0];

  $("#member-welcome").textContent = t("member.overview.greeting", {
    name: data.member?.displayName || data.member?.username || t("member.rail.memberFallback"),
  });
  // 总览主数值 = 钱包余额：余额是唯一的调用限额，不再有 Token 额度进度。
  const heroWallet = data.wallet || {};
  $("#member-hero-balance").textContent = walletText(heroWallet);
  $("#member-hero-summary").textContent = heroWallet.hasWallet
    ? (isLegacyWallet(heroWallet) ? t("billing.legacyBalanceNote") : t("billing.currencyName"))
    : t("member.overview.walletSub");
  $("#member-hero-detail").textContent = t("member.overview.walletDetail");
  setStatus($("#member-service-status"), key.status, t("member.overview.keyEnabled"));
  setStatus($("#member-key-status"), key.status);
  $("#member-key-expires").textContent = key.expiresAt
    ? t("member.overview.expiresAt", { time: formatTime(key.expiresAt) })
    : t("member.overview.expiresNone");
  $("#member-today-calls").textContent = formatNum(today.calls);
  $("#member-today-tokens").textContent = formatCompact(today.totalTokens);
  const wallet = data.wallet || {};
  const walletEl = $("#member-wallet-balance");
  if (walletEl) walletEl.textContent = walletText(wallet);
  const walletSub = $("#member-wallet-sub");
  if (walletSub) {
    walletSub.textContent = wallet.hasWallet
      ? (isLegacyWallet(wallet) ? t("billing.legacyBalanceNote")
        : t("billing.currencyName") + (wallet.billingEnabled ? "" : " · " + t("member.overview.walletChargingOff")))
      : t("member.overview.walletSub");
  }
  if (latest) {
    const latestStatus = humanStatus(latest.status);
    const latestEl = $("#member-latest-status");
    latestEl.textContent = latestStatus[1];
    latestEl.className = "member-metric-value " + latestStatus[0];
    const cat = errorCatText(latest);
    $("#member-latest-time").textContent = formatTime(latest.occurredAt) + (cat ? " · " + cat : "");
    // 失败可行动：点击指标值直接跳到该次调用在调用记录里的位置。
    if (latestStatus[0] === "err") {
      latestEl.classList.add("member-link-value");
      latestEl.title = t("member.usage.viewFailed");
      latestEl.dataset.jumpUsage = "1";
      latestEl.dataset.jumpDate = businessDayText(latest.occurredAt);
      latestEl.dataset.jumpRequest = latest.requestId || "";
    } else {
      latestEl.classList.remove("member-link-value");
      delete latestEl.dataset.jumpUsage;
    }
  } else {
    $("#member-latest-status").textContent = t("member.overview.latestNone");
    $("#member-latest-status").className = "member-metric-value";
    $("#member-latest-time").textContent = t("member.overview.latestNever");
  }
  $("#member-quick-openai").textContent = location.origin + "/v1";
  renderQuickAccess(data);
  renderLowBalanceBanner(data);

  // 侧栏速览：复用总览同一份数据，不再发额外请求。
  renderRailQuota(data);

  const recentRoot = $("#member-recent-list");
  if (!recent.length) {
    recentRoot.innerHTML = '<div class="member-empty">' + escapeHtml(t("member.empty.records")) + "</div>";
  } else {
    recentRoot.innerHTML = recent.slice(0, 3).map((row) =>
      '<div class="member-activity"><span class="member-activity-main">' + escapeHtml(row.model || t("member.status.UNKNOWN"))
      + "</span>" + (String(row.status || "").toUpperCase() === "OK" ? statusPill(row.status) : failedPill(row)) + "</div>"
    ).join("");
  }
}

/* 低余额横幅：余额 ≤ manager.member.low-balance-threshold（后端下发）时提醒；余额用尽换更重的措辞。 */
function renderLowBalanceBanner(data) {
  const banner = $("#member-lowbalance");
  if (!banner) return;
  const wallet = data.wallet || {};
  const threshold = String(data.lowBalanceThreshold ?? "").trim();
  const enabled = wallet.hasWallet && !isLegacyWallet(wallet) && threshold !== "" && Number(threshold) >= 0;
  const show = enabled && wallet.balance != null && compareDecimalAmounts(wallet.balance, threshold) <= 0;
  banner.hidden = !show;
  if (!show) return;
  const empty = compareDecimalAmounts(wallet.balance, "0") <= 0;
  banner.className = "member-banner " + (empty ? "err" : "warn");
  $("#member-lowbalance-text").textContent = empty
    ? t("member.lowbalance.exhausted")
    : t("member.lowbalance.low", { amount: formatMoney(wallet.balance) });
}

/* 快速接入面板：推荐模型 = 记住的选择（接入配置页）> 目录第一个；并给出可执行 curl。 */
function renderQuickAccess(data) {
  const models = Array.isArray(memberState.models?.models) ? memberState.models.models : [];
  const stored = localStorage.getItem(MEMBER_MODEL_PREF_KEY) || "";
  const validStored = models.some((model) => memberPublicId(model) === stored);
  const quickModel = validStored ? stored : (models.length ? memberPublicId(models[0]) : "");
  $("#member-quick-model").textContent = quickModel || t("member.overview.chooseInSetup");
  const curlEl = $("#member-quick-curl");
  if (!curlEl) return;
  const base = location.origin + "/v1";
  const model = quickModel || "MODEL_ID";
  curlEl.textContent = "curl " + base + "/chat/completions \\\n"
    + '  -H "Authorization: Bearer sk-your-key" \\\n'
    + '  -H "Content-Type: application/json" \\\n'
    + '  -d \'{"model": ' + JSON.stringify(model) + ', "messages": [{"role": "user", "content": "Hello"}]}\'';
}

/* 速览卡是常驻侧栏的元素，但数据只随总览接口回来一次。
   把它单独抽出来，登录后无论先进哪个视图都能填上，
   切换视图时也靠它保持最新，不会退回占位符。 */
function renderRailQuota(data) {
  const remainingEl = $("#rail-wallet-balance");
  if (!remainingEl || !data) return;
  const today = data.today || {};
  remainingEl.textContent = walletText(data.wallet);
  $("#rail-quota-calls").textContent = formatNum(today.calls);
  $("#rail-quota-tokens").textContent = formatCompact(today.totalTokens);
}

/* 近 7 天趋势：纯 CSS 柱状图，成功（主题色）与未完整成功（红）堆叠；
   点柱子跳到该业务日的调用记录。 */
function renderTrend(data) {
  const root = $("#member-trend-chart");
  if (!root) return;
  const points = Array.isArray(data?.points) ? data.points : [];
  if (!points.length) {
    root.innerHTML = '<div class="member-empty">' + escapeHtml(t("member.trend.empty")) + "</div>";
    const total = $("#member-trend-total");
    if (total) total.textContent = "";
    return;
  }
  const totals = points.reduce((acc, point) => ({
    calls: acc.calls + number(point.calls),
    fails: acc.fails + number(point.fails),
    tokens: acc.tokens + number(point.totalTokens),
  }), { calls: 0, fails: 0, tokens: 0 });
  const total = $("#member-trend-total");
  if (total) {
    total.textContent = t("member.trend.total", { calls: formatNum(totals.calls), tokens: formatCompact(totals.tokens) });
  }
  const max = Math.max(1, ...points.map((point) => number(point.calls)));
  root.innerHTML = '<div class="member-trend-cols">' + points.map((point) => {
    const calls = number(point.calls);
    const fails = number(point.fails);
    const ok = Math.max(0, calls - fails);
    const okPct = Math.round((ok / max) * 100);
    const failPct = Math.round((fails / max) * 100);
    const tip = t("member.trend.tip", {
      date: point.date,
      calls: formatNum(calls),
      fails: formatNum(fails),
      tokens: formatCompact(point.totalTokens),
      cost: formatMoney(point.creditCost),
    });
    return '<button type="button" class="member-trend-col" data-jump-usage data-jump-filter="ALL"'
      + ' data-jump-date="' + escapeHtml(point.date) + '" title="' + escapeHtml(tip) + '">'
      + '<span class="member-trend-bars">'
      + (fails ? '<i class="bad" style="height:' + Math.max(failPct, 8) + '%"></i>' : "")
      + (ok ? '<i class="ok" style="height:' + Math.max(okPct, 5) + '%"></i>' : "")
      + (!calls ? '<i class="none"></i>' : "")
      + "</span>"
      + '<span class="member-trend-num">' + (calls ? formatNum(calls) : "·") + "</span>"
      + '<span class="member-trend-date">' + escapeHtml(String(point.date || "").slice(5).replace("-", "/")) + "</span>"
      + "</button>";
  }).join("") + "</div>";
}

function renderOverviewModels(data) {
  const root = $("#member-overview-models");
  if (!root) return;
  const models = Array.isArray(data?.models) ? data.models : [];
  if (!models.length) {
    root.innerHTML = '<div class="member-empty">' + escapeHtml(t("member.overview.modelsEmpty")) + "</div>";
    return;
  }
  root.innerHTML = '<div class="member-model-chips">' + models.slice(0, 8).map((model) => {
    const id = memberPublicId(model) || "—";
    const priced = isRmbBillingServer() && model.pricing ? "<em>" + escapeHtml(t("member.models.marked")) + "</em>" : "";
    return '<button type="button" class="member-model-chip" data-copy-value="' + escapeHtml(id)
      + '" title="' + escapeHtml(t("member.copy.tooltip")) + '">'
      + '<strong>' + escapeHtml(id) + "</strong>" + priced + "</button>";
  }).join("") + (models.length > 8
    ? '<button type="button" class="member-text-link" data-member-goto="models">'
      + escapeHtml(t("member.overview.more", { count: models.length - 8 })) + "</button>"
    : "") + "</div>";
}

async function loadModels() {
  const selection = memberState.keySelectionVersion;
  const data = await memberApi("/api/member/models");
  if (selection !== memberState.keySelectionVersion) return;
  memberState.models = data;
  memberState.billingCurrency = data.currency || null;
  const search = $("#member-models-search");
  if (search && memberState.modelsKeyword) search.value = memberState.modelsKeyword;
  renderModels();
}

function renderModels() {
  const data = memberState.models || {};
  const models = Array.isArray(data.models) ? data.models : [];
  const keyword = String($("#member-models-search")?.value || memberState.modelsKeyword || "").trim().toLowerCase();
  memberState.modelsKeyword = keyword;
  const filtered = models.filter((model) => {
    const searchable = [memberPublicId(model), model.name, model.description].join(" ").toLowerCase();
    return !keyword || searchable.includes(keyword);
  });
  const ready = isRmbBillingServer();
  const ratesReady = memberRatesReady(data.rateUnit);
  const priced = ratesReady ? models.filter((model) => model.pricing).length : 0;
  $("#member-models-count").textContent = formatNum(models.length);
  $("#member-models-scope").textContent = t("member.models.authorized");
  $("#member-models-priced").textContent = formatNum(priced);
  $("#member-models-currency").textContent = ready ? t("billing.currencyName") : t("billing.restartShort");
  $("#member-models-pricing-flag").textContent = !ratesReady ? t("billing.restartShort")
    : data.pricingEnabled ? t("member.models.chargingOn") : t("member.models.chargingOff");
  $("#member-models-sub").textContent = filtered.length === models.length
    ? t("member.models.countAll", { count: models.length })
    : t("member.models.countFiltered", { shown: filtered.length, total: models.length });

  const desktop = $("#member-models-list");
  const mobile = $("#member-models-mobile");
  const emptyRow = '<div class="member-empty">' + escapeHtml(t("member.noMatchModels")) + "</div>";
  if (!filtered.length) {
    desktop.innerHTML = '<tr><td colspan="8">' + emptyRow + "</td></tr>";
    mobile.innerHTML = emptyRow;
    return;
  }
  desktop.innerHTML = filtered.map((model) => {
    const id = memberPublicId(model) || "—";
    const efforts = (model.reasoningEfforts || model.reasoning_efforts || []).join(", ") || "—";
    const pricing = ratesReady ? model.pricing || null : null;
    return "<tr>"
      + '<td class="model-cell" title="' + escapeHtml(model.description || id) + '"><code>' + escapeHtml(id) + "</code>" + (model.name && model.name !== id ? '<div class="member-model-description">' + escapeHtml(model.name) + "</div>" : "") + "</td>"
      + "<td>" + escapeHtml(memberModelCapabilities(model)) + "</td>"
      + "<td>" + escapeHtml(efforts) + "</td>"
      + '<td class="num">' + (pricing ? escapeHtml(formatMoney(pricing.promptPer1m)) : "—") + "</td>"
      + '<td class="num">' + (pricing ? escapeHtml(formatMoney(pricing.completionPer1m)) : "—") + "</td>"
      + '<td class="num">' + (pricing ? escapeHtml(formatMoney(pricing.cacheReadPer1m)) : "—") + "</td>"
      + '<td class="num">' + (pricing ? escapeHtml(formatMoney(pricing.cacheWritePer1m)) : "—") + "</td>"
      + '<td><button type="button" class="member-text-link" data-copy-value="' + escapeHtml(id) + '">'
      + escapeHtml(t("member.copy.short")) + "</button></td>"
      + "</tr>";
  }).join("");
  mobile.innerHTML = filtered.map((model) => {
    const id = memberPublicId(model) || "—";
    const pricing = ratesReady ? model.pricing : null;
    return '<article class="member-panel member-record-card">'
      + '<div class="record-row"><strong>' + escapeHtml(id) + "</strong>"
      + '<button type="button" class="member-text-link" data-copy-value="' + escapeHtml(id) + '">'
      + escapeHtml(t("member.copy.short")) + "</button></div>"
      + '<div class="record-row"><span>' + escapeHtml(memberModelCapabilities(model)) + "</span>"
      + "<span>" + (pricing
        ? escapeHtml(t("member.models.mobileRates", { prompt: formatMoney(pricing.promptPer1m), completion: formatMoney(pricing.completionPer1m) }))
        : escapeHtml(t("member.models.unpriced"))) + "</span></div>"
      + (pricing ? '<div class="member-model-description">'
        + escapeHtml(t("member.models.mobileCacheRates", { read: formatMoney(pricing.cacheReadPer1m), write: formatMoney(pricing.cacheWritePer1m) }))
        + "</div>" : "")
      + '<div class="member-model-description">' + escapeHtml((model.reasoningEfforts || model.reasoning_efforts || []).join(", ")) + "</div></article>";
  }).join("");
}

/* ===== 模拟调用 =====
   网页代发的真实对话：走成员自己的 Key 与完整网关链路（计费、调用日志与 /v1 同路径），
   每次发送都按所选模型单价从钱包余额扣费。会话上下文只保存在浏览器里。 */
async function loadPlayground() {
  const selection = memberState.keySelectionVersion;
  if (!memberState.models) {
    try {
      const models = await memberApi("/api/member/models");
      if (selection !== memberState.keySelectionVersion) return;
      memberState.models = models;
      memberState.billingCurrency = memberState.models.currency || memberState.billingCurrency;
    } catch {
      if (selection !== memberState.keySelectionVersion) return;
      memberState.models = { models: [] };
    }
  }
  const models = pgModels();
  if (!models.some((model) => memberPublicId(model) === memberState.playground.model)) {
    const stored = localStorage.getItem(PG_MODEL_PREF_KEY) || "";
    const remembered = models.some((model) => memberPublicId(model) === stored);
    memberState.playground.model = remembered ? stored : (models.length ? memberPublicId(models[0]) : "");
  }
  renderPlayground();
}

function pgModels() {
  return Array.isArray(memberState.models?.models) ? memberState.models.models : [];
}

function renderPlayground() {
  renderPlaygroundFlag();
  renderPgModelPicker();
  renderPlaygroundLog();
  renderPlaygroundMeta();
  $("#btn-pg-send").disabled = !memberState.playground.model || memberState.playground.busy;
  $("#btn-pg-clear").disabled = memberState.playground.busy || !memberState.playground.messages.length;
}

function renderPlaygroundFlag() {
  const flag = $("#member-playground-flag");
  if (!flag) return;
  const data = memberState.models || {};
  if (!Array.isArray(data.models) || !data.models.length) {
    flag.className = "member-status warn";
    flag.textContent = t("member.playground.noModels");
    return;
  }
  const charging = data.pricingEnabled === true;
  flag.className = "member-status " + (charging ? "ok" : "warn");
  flag.textContent = charging ? t("member.playground.chargingOn") : t("member.playground.chargingOff");
}

function renderPgModelPicker() {
  const picker = $("#pg-model-picker");
  if (!picker) return;
  const keyword = picker.querySelector(".model-picker-search").value.trim().toLowerCase();
  const current = memberState.playground.model;
  picker.querySelector(".model-picker-value").textContent = current || t("member.playground.noModels");
  const filtered = pgModels().map(memberPublicId).filter((id) => id && id.toLowerCase().includes(keyword));
  const list = picker.querySelector(".model-picker-list");
  if (!filtered.length) {
    list.innerHTML = '<div class="model-picker-empty">' + escapeHtml(t("member.noMatchModels")) + "</div>";
    return;
  }
  list.innerHTML = filtered.map((id) => '<button type="button" role="option" class="model-picker-option' + (id === current ? " active" : "")
    + '" data-model="' + escapeHtml(id) + '" aria-selected="' + (id === current) + '">' + escapeHtml(id) + "</button>").join("");
}

function togglePgModelPicker(open) {
  const picker = $("#pg-model-picker");
  const panel = picker.querySelector(".model-picker-panel");
  panel.hidden = !open;
  picker.classList.toggle("open", open);
  picker.querySelector(".model-picker-trigger").setAttribute("aria-expanded", String(open));
  if (!open) return;
  picker.querySelector(".model-picker-search").value = "";
  renderPgModelPicker();
  picker.querySelector(".model-picker-search").focus();
  picker.querySelector(".model-picker-option.active")?.scrollIntoView({ block: "nearest" });
}

function bindPgModelPicker() {
  const picker = $("#pg-model-picker");
  if (!picker) return;
  picker.querySelector(".model-picker-trigger").addEventListener("click", () => togglePgModelPicker(picker.querySelector(".model-picker-panel").hidden));
  picker.querySelector(".model-picker-search").addEventListener("input", renderPgModelPicker);
  picker.querySelector(".model-picker-list").addEventListener("click", (event) => {
    const option = event.target.closest("[data-model]");
    if (!option) return;
    memberState.playground.model = option.dataset.model;
    localStorage.setItem(PG_MODEL_PREF_KEY, memberState.playground.model);
    togglePgModelPicker(false);
    renderPlayground();
  });
  document.addEventListener("click", (event) => {
    if (!picker.contains(event.target)) togglePgModelPicker(false);
  });
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") togglePgModelPicker(false);
  });
}

function renderPlaygroundLog() {
  const log = $("#member-playground-log");
  if (!log) return;
  const messages = memberState.playground.messages;
  if (!messages.length && !memberState.playground.busy) {
    log.innerHTML = '<div class="member-empty">' + escapeHtml(t("member.playground.empty")) + "</div>";
    return;
  }
  const bubbles = messages.map((message) => {
    const mine = message.role === "user";
    return '<div class="pg-msg ' + (mine ? "pg-user" : "pg-assistant")
      + '"><div class="pg-role">' + escapeHtml(mine ? t("member.playground.you") : t("member.playground.assistant"))
      + '</div><div class="pg-bubble">' + escapeHtml(message.content) + "</div></div>";
  }).join("");
  const pending = memberState.playground.busy
    ? '<div class="pg-msg pg-assistant"><div class="pg-role">' + escapeHtml(t("member.playground.assistant"))
      + '</div><div class="pg-bubble pg-pending">' + escapeHtml(t("member.playground.thinking")) + "</div></div>"
    : "";
  log.innerHTML = bubbles + pending;
  log.scrollTop = log.scrollHeight;
}

function renderPlaygroundMeta() {
  const meta = $("#member-playground-meta");
  const data = memberState.playground.meta;
  if (!meta) return;
  if (!data) {
    meta.hidden = true;
    meta.textContent = "";
    return;
  }
  const usage = data.usage || {};
  const parts = [
    t("member.playground.metaTokens", { tokens: formatCompact(usage.totalTokens) }),
    data.estimatedCost != null ? t("member.playground.metaCost", { amount: formatMoney(data.estimatedCost) }) : "",
    data.latencyMs != null ? t("member.playground.metaLatency", { time: formatLatency(data.latencyMs) }) : "",
  ].filter(Boolean);
  meta.textContent = parts.join(" · ") + (data.requestId ? " · " + data.requestId : "");
  meta.hidden = false;
}

async function sendPlayground() {
  const session = memberState.session;
  const conversation = memberState.playground;
  const input = $("#member-playground-text");
  const text = String(input?.value || "").trim();
  if (!text || memberState.playground.busy) return;
  if (!memberState.playground.model) {
    showToast(t("member.playground.modelRequired"));
    return;
  }
  const history = memberState.playground.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }));
  const messages = history.concat([{ role: "user", content: text }]);
  if (!memberState.playground.sessionId) {
    memberState.playground.sessionId = globalThis.crypto?.randomUUID?.()
      || "pg-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }
  memberState.playground.busy = true;
  memberState.playground.messages = messages;
  if (input) input.value = "";
  renderPlayground();
  try {
    const data = await memberApi("/api/member/playground", {
      method: "POST",
      body: JSON.stringify({ model: memberState.playground.model, messages,
        session_id: memberState.playground.sessionId, keyId: memberState.activeKeyId || undefined }),
    });
    if (session !== memberState.session || conversation !== memberState.playground) return;
    memberState.playground.messages.push({ role: "assistant", content: String(data.content || "") });
    memberState.playground.meta = data;
    // 余额与今日计数已变化：静默重取总览，刷新侧栏速览。
    memberApi("/api/member/overview")
      .then((overview) => { memberState.overview = overview; renderRailQuota(overview); })
      .catch(() => {});
  } catch (error) {
    // 失败的这轮不计入会话：把消息还回输入框，方便直接重试。
    if (session !== memberState.session || conversation !== memberState.playground) return;
    memberState.playground.messages = history;
    if (input) input.value = text;
    showToast(error.message);
  } finally {
    conversation.busy = false;
    if (session === memberState.session && conversation === memberState.playground) renderPlayground();
  }
}

function clearPlayground() {
  if (!memberState.playground.messages.length && !memberState.playground.meta) return;
  memberState.playground.messages = [];
  memberState.playground.meta = null;
  memberState.playground.sessionId = "";
  renderPlayground();
}

async function loadBilling() {
  const data = await memberApi("/api/member/billing");
  memberState.ledgerRows = Array.isArray(data.ledger) ? data.ledger.slice() : [];
  memberState.ledgerCursor = {
    before: data.ledgerNextBefore || null,
    lastId: data.ledgerNextLastId || null,
    hasMore: data.ledgerHasMore === true,
    loading: false,
  };
  memberState.billing = data;
  memberState.billingCurrency = data.status?.currency || null;
  renderBilling(data);
}

function renderBilling(data) {
  const wallet = data.wallet || {};
  const status = data.status || {};
  memberState.billingCurrency = status.currency || null;
  const ready = isRmbBillingServer();
  const ratesReady = memberRatesReady(status.rateUnit);
  const rates = ratesReady && Array.isArray(data.rates) ? data.rates : [];
  const ledger = Array.isArray(data.ledger) ? data.ledger : [];
  $("#member-billing-notice").textContent = !ready ? t("member.billing.restartRequired")
    : !ratesReady ? t("member.billing.rateRestartRequired")
    : t(status.enabled ? "member.billing.noticeEnabled" : "member.billing.noticeDisabled");
  const flag = $("#member-billing-flag");
  if (flag) {
    flag.className = "member-status " + (ratesReady && status.enabled ? "ok" : "warn");
    flag.textContent = !ratesReady ? t("billing.restartShort")
      : status.enabled ? t("member.billing.enabled") : t("member.billing.disabled");
  }
  $("#member-billing-balance").textContent = !wallet.hasWallet
    ? t("member.billing.noWallet")
    : isLegacyWallet(wallet)
      ? t("billing.legacyAmount", { amount: formatLegacyAmount(wallet.balance) })
      : formatMoney(wallet.balance);
  $("#member-billing-wallet-meta").textContent = wallet.hasWallet
    ? (isLegacyWallet(wallet) ? t("billing.legacyBalanceNote")
      : t("member.billing.walletSub", { currency: t("billing.currencyName") }))
    : t("member.billing.walletSubNone");
  const walletStatus = $("#member-billing-wallet-status");
  if (walletStatus) {
    walletStatus.className = "member-status " + (wallet.hasWallet ? "ok" : "warn");
    walletStatus.textContent = wallet.hasWallet ? t("member.billing.opened") : t("member.billing.noWallet");
  }

  $("#member-billing-rate-count").textContent = t("member.billing.rateCount", { count: rates.length });
  const rateBody = $("#member-billing-rates");
  const rateEmpty = $("#member-billing-rates-empty");
  if (!rates.length) {
    rateBody.innerHTML = "";
    if (rateEmpty) {
      rateEmpty.textContent = !ratesReady ? t("member.billing.ratesWaitingRestart")
        : t(status.enabled ? "member.billing.ratesEmptyEnabled" : "member.billing.ratesEmpty");
      rateEmpty.hidden = false;
    }
  } else {
    if (rateEmpty) rateEmpty.hidden = true;
    rateBody.innerHTML = rates.map((rate) =>
      "<tr><td><code>" + escapeHtml(rate.model) + "</code></td>"
      + '<td class="num">' + escapeHtml(formatMoney(rate.promptPer1m)) + "</td>"
      + '<td class="num">' + escapeHtml(formatMoney(rate.completionPer1m)) + "</td>"
      + '<td class="num">' + escapeHtml(formatMoney(rate.cacheReadPer1m)) + "</td>"
      + '<td class="num">' + escapeHtml(formatMoney(rate.cacheWritePer1m)) + "</td></tr>"
    ).join("");
  }

  /* 流水渲染读累积状态：切语言重渲不丢已加载的更多页 */
  renderLedgerRows(memberState.ledgerRows, { reset: true });
  updateLedgerMoreButton();
}

/* 流水类型 → 词表 key（取词时才翻译，切语言后重新渲染即可） */
function ledgerTypeLabel(entryType) {
  const typeLabel = {
    USAGE_CHARGE: "member.billing.typeUsage",
    TOP_UP: "member.billing.typeTopUp",
    ADJUSTMENT: "member.billing.typeAdjustment",
    REFUND: "member.billing.typeRefund",
  };
  return typeLabel[entryType] ? t(typeLabel[entryType]) : (entryType || "—");
}

function ledgerRowHtml(entry) {
  return '<tr><td class="model-cell" title="' + escapeHtml(entry.model || "") + '">'
    + escapeHtml(entry.model || "—") + "</td>"
    + "<td>" + escapeHtml(formatTime(entry.occurredAt)) + "</td>"
    + "<td>" + escapeHtml(ledgerTypeLabel(entry.entryType)) + "</td>"
    + "<td>" + billingStatusPill(entry.status) + "</td>"
    + '<td class="num">' + escapeHtml(formatLedgerAmount(entry)) + "</td>"
    + '<td class="num">' + (entry.balanceAfter == null ? "—" : escapeHtml(isHistoricalLedger(entry)
      ? t("billing.legacyAmount", { amount: formatLegacyAmount(entry.balanceAfter) })
      : formatMoney(entry.balanceAfter))) + "</td></tr>";
}

function renderLedgerRows(rows, options) {
  const ledgerBody = $("#member-billing-ledger");
  const ledgerEmpty = $("#member-billing-ledger-empty");
  if (!ledgerBody) return;
  if (!rows.length) {
    if (options?.reset) ledgerBody.innerHTML = "";
    if (ledgerEmpty) ledgerEmpty.hidden = false;
    return;
  }
  if (ledgerEmpty) ledgerEmpty.hidden = true;
  const html = rows.map(ledgerRowHtml).join("");
  if (options?.reset) ledgerBody.innerHTML = html;
  else ledgerBody.insertAdjacentHTML("beforeend", html);
}

function updateLedgerMoreButton() {
  const button = $("#member-billing-more");
  if (!button) return;
  const cursor = memberState.ledgerCursor;
  button.hidden = !cursor.hasMore;
  button.disabled = cursor.loading;
  button.textContent = t(cursor.loading ? "member.billing.ledgerLoading" : "member.billing.ledgerMore");
}

/* 游标续拉下一页（keyset）：只追加新行，不重绘整表；游标失效时静默回到首页语义 */
async function loadMoreLedger() {
  const cursor = memberState.ledgerCursor;
  if (!cursor.hasMore || cursor.loading) return;
  cursor.loading = true;
  updateLedgerMoreButton();
  try {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor.before && cursor.lastId) {
      params.set("before", cursor.before);
      params.set("lastId", cursor.lastId);
    }
    const page = await memberApi("/api/member/billing/ledger?" + params.toString());
    const entries = Array.isArray(page.entries) ? page.entries : [];
    memberState.ledgerRows = memberState.ledgerRows.concat(entries);
    cursor.hasMore = page.hasMore === true;
    cursor.before = page.nextBefore || null;
    cursor.lastId = page.nextLastId || null;
    renderLedgerRows(entries, { reset: false });
  } finally {
    cursor.loading = false;
    updateLedgerMoreButton();
  }
}

async function loadKey() {
  if (typeof loadMemberKeyManagement === "function") await loadMemberKeyManagement();
  const selection = memberState.keySelectionVersion;
  const key = await memberApi("/api/member/key");
  if (selection !== memberState.keySelectionVersion) return;
  memberState.key = key;
  memberState.billingCurrency = key.wallet?.currency || memberState.billingCurrency;
  renderKey(key);
}

function renderKey(key) {
  $("#member-key-identifier").textContent = key.identifier || "—";
  $("#member-key-models").textContent = Array.isArray(key.allowedModels)
    ? t("pool.allowedCount", { count: key.allowedModels.length }) : t("pool.allowAllShort");
  $("#member-key-expiry").textContent = key.expiresAt ? formatTime(key.expiresAt) : t("member.key.noExpiry");
  $("#member-key-rate").textContent = Number(key.rateLimitPerMinute) >= 0
    ? t("member.key.perMinute", { count: key.rateLimitPerMinute })
    : t("member.overview.unlimited");
  const status = humanStatus(key.status);
  $("#member-key-state").textContent = status[1];
  $("#member-key-state").style.color = key.status === "ACTIVE" ? "var(--accent-2)" : "";
  $("#member-key-page-status").className = "member-status " + status[0];
  $("#member-key-page-status").textContent = status[1];
  // Key 不再有独立额度，这里只展示计费依据——成员钱包余额。
  const walletEl = $("#member-key-wallet");
  if (walletEl) walletEl.textContent = walletText(key.wallet);
}

async function loadConnect() {
  const selection = memberState.keySelectionVersion;
  const data = await memberApi("/api/member/connect");
  if (selection !== memberState.keySelectionVersion) return;
  memberState.connect = data;
  renderConnect();
}

function renderConnect() {
  const data = memberState.connect || {};
  $("#member-connect-availability").textContent = t("member.models.authorized");
  const select = $("#member-model-select");
  const models = Array.isArray(data.models) ? data.models : [];
  // 回退顺序：本次已选 > 记住的选择（总览推荐模型同步用这份）> 后端推荐（目录第一个）。
  const remembered = localStorage.getItem(MEMBER_MODEL_PREF_KEY) || "";
  const prior = select.value || remembered || data.recommendedModel;
  select.innerHTML = models.length
    ? models.map((model) => '<option value="' + escapeHtml(memberPublicId(model)) + '">' + escapeHtml(memberPublicId(model)) + "</option>").join("")
    : '<option value="">' + escapeHtml(t("member.connect.noModels")) + "</option>";
  if (models.some((model) => memberPublicId(model) === prior)) select.value = prior;
  renderModelPicker();
  renderConfigSample();
  renderCcSwitchLink();
}

/* ===== CC Switch 一键接入 =====
   cc-switch 桌面端注册了 ccswitch:// 协议（v3.19+ 导入前会弹确认框）。
   服务端只存 keyHash，成员 Key 无法从后端还原，因此由成员在这里粘贴
   Key、浏览器本地拼装深度链接后唤起 CC Switch；Key 不回传服务器。
   claude 的 endpoint 是裸 origin（写入 ANTHROPIC_BASE_URL），
   其余客户端都吃 OpenAI 兼容 /v1：codex/grokbuild 写 base_url 或
   [models]（Responses/chat），opencode 写 baseURL，openclaw 写 baseUrl，
   hermes 写 base_url（api_mode 固定 chat_completions）。 */
function ccSwitchLink(app) {
  const data = memberState.connect || {};
  const key = String($("#member-ccswitch-key")?.value || "").trim();
  const endpoint = app === "claude" ? data.anthropicBaseUrl : data.openAiBaseUrl;
  if (!key || !endpoint) return "";
  const params = new URLSearchParams();
  params.set("resource", "provider");
  params.set("app", app);
  params.set("name", t("member.ccswitch.providerName", { host: location.host }));
  params.set("endpoint", endpoint);
  params.set("apiKey", key);
  if (app !== "claude") {
    const model = $("#member-model-select")?.value;
    if (model) params.set("model", model);
  }
  return "ccswitch://v1/import?" + params.toString();
}

function renderCcSwitchLink() {
  const link = ccSwitchLink(memberState.ccswitchApp);
  const pre = $("#member-ccswitch-link");
  if (pre) {
    pre.hidden = !link;
    pre.textContent = link || "";
  }
  $("#btn-copy-ccswitch-link").disabled = !link;
  document.querySelectorAll("[data-ccswitch-app]").forEach((button) => {
    button.disabled = !ccSwitchLink(button.dataset.ccswitchApp);
  });
}

function importCcSwitch(app) {
  const link = ccSwitchLink(app);
  if (!link) {
    $("#member-ccswitch-key")?.focus();
    showToast(t("member.ccswitch.needKey"));
    return;
  }
  memberState.ccswitchApp = app;
  renderCcSwitchLink();
  window.location.href = link;
  showToast(t("member.ccswitch.launchHint"), "ok");
}

function memberPublicId(model) { return model.publicId || model.id || ""; }

function memberModelCapabilities(model) {
  const labels = [];
  if (model.supportsImages || model.supports_images) labels.push(t("pool.images"));
  if (model.supportsTools || model.supports_tools) labels.push(t("pool.tools"));
  return labels.length ? labels.join(" · ") : t("pool.text");
}

function renderModelPicker() {
  const select = $("#member-model-select");
  const picker = $("#member-model-picker");
  const keyword = picker.querySelector(".model-picker-search").value.trim().toLowerCase();
  const ids = [...select.options].map((option) => option.value).filter(Boolean);
  picker.querySelector(".model-picker-value").textContent = select.value || t("member.connect.noModels");
  const filtered = ids.filter(id => id.toLowerCase().includes(keyword));
  const list = picker.querySelector(".model-picker-list");
  if (!filtered.length) {
    list.innerHTML = '<div class="model-picker-empty">' + escapeHtml(t("member.noMatchModels")) + "</div>";
    return;
  }
  list.innerHTML = filtered.map(id => '<button type="button" role="option" class="model-picker-option' + (id === select.value ? " active" : "") +
    '" data-model="' + escapeHtml(id) + '" aria-selected="' + (id === select.value) + '">' + escapeHtml(id) + "</button>").join("");
}

function toggleModelPicker(open) {
  const picker = $("#member-model-picker");
  const panel = picker.querySelector(".model-picker-panel");
  const search = picker.querySelector(".model-picker-search");
  panel.hidden = !open;
  picker.classList.toggle("open", open);
  picker.querySelector(".model-picker-trigger").setAttribute("aria-expanded", String(open));
  if (!open) return;
  search.value = "";
  renderModelPicker();
  search.focus();
  picker.querySelector(".model-picker-option.active")?.scrollIntoView({ block: "nearest" });
}

function bindModelPicker() {
  const picker = $("#member-model-picker");
  picker.querySelector(".model-picker-trigger").addEventListener("click", () => toggleModelPicker(picker.querySelector(".model-picker-panel").hidden));
  picker.querySelector(".model-picker-search").addEventListener("input", renderModelPicker);
  picker.querySelector(".model-picker-list").addEventListener("click", (event) => {
    const option = event.target.closest("[data-model]");
    if (!option) return;
    const select = $("#member-model-select");
    select.value = option.dataset.model;
    select.dispatchEvent(new Event("change"));
    toggleModelPicker(false);
  });
  document.addEventListener("click", (event) => {
    if (!picker.contains(event.target)) toggleModelPicker(false);
  });
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") toggleModelPicker(false);
  });
}

function renderConfigSample() {
  const data = memberState.connect || {};
  const model = $("#member-model-select").value;
  const protocol = memberState.protocol;
  const base = protocol === "anthropic" ? data.anthropicBaseUrl : protocol === "responses" ? data.responsesBaseUrl : data.openAiBaseUrl;
  const path = protocol === "anthropic" ? "/v1/messages" : protocol === "responses" ? "/v1/responses" : "/v1/chat/completions";
  $("#member-connect-url").textContent = base || "—";
  $("#member-connect-endpoint").textContent = path;
  const models = Array.isArray(data.models) ? data.models : [];
  const selected = models.find(item => memberPublicId(item) === model);
  $("#member-connect-capabilities").textContent = selected ? memberModelCapabilities(selected) + ((selected.reasoningEfforts || selected.reasoning_efforts || []).length ? " · " + t("pool.reasoning") + ": " + (selected.reasoningEfforts || selected.reasoning_efforts).join(", ") : "") : "";
  $("#btn-copy-connect-code").disabled = !model || !base;
  if (!model || !base) { $("#member-connect-code").textContent = t("member.connect.noModels"); return; }
  $("#member-connect-code").textContent = connectSampleText(protocol, base, model, memberState.sampleFormat);
}

/* 配置示例三种格式：
   env   —— CLI 工具环境变量（原版文案，保留）
   curl  —— 可直接执行的 HTTP 测试请求
   python—— OpenAI / Anthropic 官方 SDK 片段 */
function connectSampleText(protocol, base, model, format) {
  const quotedModel = JSON.stringify(model);
  const quotedBase = JSON.stringify(base);
  if (format === "env") {
    return protocol === "anthropic"
      ? 'ANTHROPIC_BASE_URL = ' + quotedBase + '\nANTHROPIC_API_KEY  = "sk-your-key"\nANTHROPIC_MODEL    = ' + quotedModel + '\n# POST /v1/messages'
      : 'base_url = ' + quotedBase + '\napi_key  = "sk-your-key"\nmodel    = ' + quotedModel + '\n# POST ' + (protocol === "responses" ? "/v1/responses" : "/v1/chat/completions") + (protocol === "responses" ? '\n# Responses API\n{ "model": ' + quotedModel + ', "input": "Hello" }' : '\n{ "model": ' + quotedModel + ', "messages": [{ "role": "user", "content": "Hello" }] }');
  }
  if (format === "python") {
    if (protocol === "anthropic") {
      return 'import anthropic\n\nclient = anthropic.Anthropic(\n    base_url = ' + quotedBase + ',\n    api_key = "sk-your-key",\n)\n\nmessage = client.messages.create(\n    model = ' + quotedModel + ',\n    max_tokens = 1024,\n    messages = [{"role": "user", "content": "Hello"}],\n)\nprint(message.content[0].text)';
    }
    if (protocol === "responses") {
      return 'from openai import OpenAI\n\nclient = OpenAI(\n    base_url = ' + quotedBase + ',\n    api_key = "sk-your-key",\n)\n\nresp = client.responses.create(\n    model = ' + quotedModel + ',\n    input = "Hello",\n)\nprint(resp.output_text)';
    }
    return 'from openai import OpenAI\n\nclient = OpenAI(\n    base_url = ' + quotedBase + ',\n    api_key = "sk-your-key",\n)\n\nresp = client.chat.completions.create(\n    model = ' + quotedModel + ',\n    messages = [{"role": "user", "content": "Hello"}],\n)\nprint(resp.choices[0].message.content)';
  }
  if (protocol === "anthropic") {
    return 'curl ' + base + '/v1/messages \\\n'
      + '  -H "x-api-key: sk-your-key" \\\n'
      + '  -H "anthropic-version: 2023-06-01" \\\n'
      + '  -H "Content-Type: application/json" \\\n'
      + '  -d \'{\n    "model": ' + quotedModel + ',\n    "max_tokens": 1024,\n    "messages": [{"role": "user", "content": "Hello"}]\n  }\'';
  }
  if (protocol === "responses") {
    return 'curl ' + base + '/v1/responses \\\n'
      + '  -H "Authorization: Bearer sk-your-key" \\\n'
      + '  -H "Content-Type: application/json" \\\n'
      + '  -d \'{ "model": ' + quotedModel + ', "input": "Hello" }\'';
  }
  return 'curl ' + base + '/v1/chat/completions \\\n'
    + '  -H "Authorization: Bearer sk-your-key" \\\n'
    + '  -H "Content-Type: application/json" \\\n'
    + '  -d \'{\n    "model": ' + quotedModel + ',\n    "messages": [{"role": "user", "content": "Hello"}]\n  }\'';
}

async function loadUsage(page = memberState.usagePage) {
  const date = $("#member-usage-date").value;
  const requestId = ++memberState.usageRequestId;
  const params = new URLSearchParams({ limit: "50", page: String(Math.max(0, page)), status: memberState.usageFilter });
  if (date) params.set("date", date);
  const data = await memberApi("/api/member/usage?" + params);
  if (requestId !== memberState.usageRequestId) return;
  if (!data.items?.length && data.pagination?.totalPages > 0 && page >= data.pagination.totalPages) {
    return loadUsage(data.pagination.totalPages - 1);
  }
  memberState.usage = data;
  memberState.usagePage = number(data.pagination?.page);
  renderUsage(data);
}

function renderUsage(data) {
  const summary = data.summary || {};
  const range = data.range || {};
  $("#member-usage-range").textContent = range.date
    ? t("member.usage.range", { date: range.date, zone: range.zoneId || "Asia/Shanghai" })
    : t("member.usage.rangeNone");
  $("#member-usage-calls").textContent = formatNum(summary.calls);
  $("#member-usage-tokens").textContent = formatCompact(summary.totalTokens);
  $("#member-usage-fails").textContent = formatNum(summary.fails);
  $("#member-usage-fails").className = "member-metric-value " + (number(summary.fails) ? "err" : "ok");
  renderUsageRows();
  renderUsagePagination(data.pagination || {});
}

function renderUsageRows() {
  const items = memberState.usage?.items || [];
  const desktop = $("#member-usage-list");
  const mobile = $("#member-usage-mobile");
  const emptyRow = '<div class="member-empty">' + escapeHtml(t("member.empty.recordsFiltered")) + "</div>";
  if (!items.length) {
    desktop.innerHTML = '<tr><td colspan="6">' + emptyRow + "</td></tr>";
    mobile.innerHTML = emptyRow;
    highlightUsageRow();
    return;
  }
  desktop.innerHTML = items.map((row) => {
    const copy = row.requestId
      ? '<button type="button" class="member-text-link" data-copy-value="' + escapeHtml(row.requestId) + '">'
        + escapeHtml(t("member.copy.short")) + "</button>"
      : "";
    const cat = errorCatText(row);
    const tokenMain = row.usageSource === "DEFERRED" ? t("member.usage.deferred") : formatCompact(row.totalTokens);
    const tokenSub = tokenSubText(row);
    const tokenTitle = tokenTitleText(row);
    return '<tr data-request-id="' + escapeHtml(row.requestId || "") + '"><td>' + escapeHtml(formatTime(row.occurredAt)) + "</td>"
      + '<td class="model-cell" title="' + escapeHtml(row.model || "") + '">' + escapeHtml(row.model || "—") + "</td>"
      + '<td class="token-cell"' + (tokenTitle ? ' title="' + escapeHtml(tokenTitle) + '"' : "") + ">"
        + escapeHtml(tokenMain) + (tokenSub ? '<div class="member-token-sub">' + escapeHtml(tokenSub) + "</div>" : "") + "</td>"
      + '<td class="num">' + escapeHtml(formatLatency(row.latencyMs)) + "</td>"
      + "<td>" + (String(row.status || "").toUpperCase() === "OK" ? statusPill(row.status) : failedPill(row))
        + (cat ? '<div class="member-error-cat">' + escapeHtml(cat) + "</div>" : "") + "</td>"
      + '<td><span class="request-id">' + escapeHtml(row.requestId || "—") + "</span> " + copy + "</td></tr>";
  }).join("");
  mobile.innerHTML = items.map((row) => {
    const copy = row.requestId
      ? '<button type="button" class="member-text-link" data-copy-value="' + escapeHtml(row.requestId) + '">'
        + escapeHtml(t("member.copy.requestId")) + "</button>"
      : "";
    const cat = errorCatText(row);
    const tokenMain = row.usageSource === "DEFERRED" ? t("member.usage.deferred") : formatCompact(row.totalTokens) + " Tokens";
    const tokenSub = tokenSubText(row);
    return '<article class="member-panel member-record-card" data-request-id="' + escapeHtml(row.requestId || "") + '">'
      + '<div class="record-row"><strong>' + escapeHtml(formatTime(row.occurredAt)) + "</strong>"
      + (String(row.status || "").toUpperCase() === "OK" ? statusPill(row.status) : failedPill(row)) + "</div>"
      + (cat ? '<div class="member-error-cat">' + escapeHtml(cat) + "</div>" : "")
      + '<div class="record-row"><span>' + escapeHtml(row.model || "—") + "</span><span>" + escapeHtml(tokenMain) + "</span></div>"
      + (tokenSub ? '<div class="record-row"><span>' + escapeHtml(tokenSub) + "</span><span>"
        + escapeHtml(formatLatency(row.latencyMs)) + "</span></div>" : "")
      + '<div class="record-row"><span class="request-id">' + escapeHtml(row.requestId || "—") + "</span>" + copy + "</div></article>";
  }).join("");
  highlightUsageRow();
}

/* 跳转定位：renderUsage 完成后闪烁带匹配 requestId 的那一行，只生效一次。 */
function highlightUsageRow() {
  const target = memberState.highlightRequestId;
  if (!target) return;
  memberState.highlightRequestId = "";
  const row = document.querySelector('[data-request-id="' + CSS.escape(target) + '"]');
  if (!row) return;
  row.classList.add("member-row-flash");
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => row.classList.remove("member-row-flash"), 2000);
}

function renderUsagePagination(pagination) {
  const root = $("#member-usage-pagination");
  const pages = number(pagination.totalPages);
  root.hidden = pages <= 1;
  if (root.hidden) return;
  $("#member-usage-page-info").textContent = t("member.usage.pageInfo", {
    page: number(pagination.page) + 1,
    pages,
    count: formatNum(pagination.totalItems),
  });
  $("#btn-member-usage-prev").disabled = !pagination.hasPrevious;
  $("#btn-member-usage-next").disabled = !pagination.hasNext;
}

function setStatus(element, status, fallback = "—") {
  if (!element) return;
  const value = status ? humanStatus(status) : ["warn", fallback];
  element.className = "member-status " + value[0];
  element.textContent = value[1];
}

async function copyText(value, button) {
  if (!value || value === "—") return;
  try {
    await navigator.clipboard.writeText(value);
    const old = button?.textContent;
    if (button) {
      button.textContent = t("member.copy.done");
      setTimeout(() => { button.textContent = old; }, 1300);
    }
    showToast(t("member.copy.toast"), "ok");
  } catch {
    showToast(t("member.copy.denied"));
  }
}

async function submitMemberLogin(event) {
  event.preventDefault();
  const form = $("#member-login-form");
  const error = $("#member-login-error");
  const submit = form.querySelector("button[type=submit]");
  const payload = { username: form.username.value.trim(), password: form.password.value };
  if (!payload.username || !payload.password) return;
  submit.disabled = true;
  try {
    const data = await memberApi("/api/member/login", { method: "POST", body: JSON.stringify(payload) });
    error.hidden = true;
    form.reset();
    showApp(data);
  } catch (err) {
    error.textContent = err.message || t("member.error.loginFailed");
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

/* 主题化确认弹窗（成员端简化版，替代浏览器原生 confirm）。
   返回 Promise<boolean>：确认 true / 取消或 Esc false。
   opts: { title?, okText?, cancelText?, danger? } —— danger=false 时确认键为主按钮样式。 */
function uiConfirm(message, opts = {}) {
  const dlg = document.getElementById("member-confirm");
  if (!dlg) return Promise.resolve(window.confirm(message));
  const textEl = document.getElementById("member-confirm-text");
  const titleEl = document.getElementById("member-confirm-title");
  const okBtn = document.getElementById("member-confirm-ok");
  const cancelBtn = document.getElementById("member-confirm-cancel");
  if (!textEl || !okBtn || !cancelBtn) return Promise.resolve(window.confirm(message));

  textEl.textContent = message;
  if (titleEl) titleEl.textContent = opts.title || t("member.dlg.confirmTitle");
  okBtn.textContent = opts.okText || t("member.dlg.confirm");
  okBtn.className = opts.danger === false ? "member-button primary" : "member-button danger";
  cancelBtn.textContent = opts.cancelText || t("member.dlg.cancel");

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

async function logout() {
  try {
    await memberApi("/api/member/logout", { method: "POST" });
  } catch {
    // The visual shell is still removed when the server is no longer reachable.
  }
  showLogin(t("member.logout.done"));
}

/* 退出登录先二次确认，防止侧栏/导航误触。 */
async function confirmLogout() {
  const ok = await uiConfirm(t("member.logout.confirm"), {
    title: t("member.logout.title"),
    okText: t("member.logout.title"),
    danger: false,
  });
  if (ok) await logout();
}

function bind() {
  if (typeof bindMemberKeyManagement === "function") bindMemberKeyManagement();
  $("#member-login-form").addEventListener("submit", submitMemberLogin);
  $("#member-billing-more")?.addEventListener("click", () => {
    loadMoreLedger().catch((error) => showToast(error.message));
  });
  $("#btn-member-logout").addEventListener("click", () => confirmLogout());
  $("#btn-member-logout-mobile").addEventListener("click", () => confirmLogout());
  // 窄屏侧栏隐藏，联系方式改由顶部导航的「联系我们」就地展开。
  document.querySelectorAll("[data-member-contact]").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = $("#member-contact-mobile");
      if (!panel) return;
      panel.hidden = !panel.hidden;
      button.classList.toggle("active", !panel.hidden);
      if (!panel.hidden) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });
  document.querySelectorAll("[data-member-view]").forEach((button) => {
    button.addEventListener("click", () => setMemberView(button.dataset.memberView));
  });
  document.addEventListener("click", (event) => {
    const goto = event.target.closest("[data-member-goto]");
    if (goto) setMemberView(goto.dataset.memberGoto);
  });
  // 失败徽标 / 趋势柱 / 最近一次调用：统一跳转调用记录（业务日 + 状态过滤 + 行定位）。
  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-jump-usage]");
    if (!el) return;
    jumpToUsage(el.dataset.jumpDate, el.dataset.jumpFilter || "OTHER", el.dataset.jumpRequest || "");
  });
  document.querySelectorAll("[data-member-protocol]").forEach((button) => {
    button.addEventListener("click", () => {
      memberState.protocol = button.dataset.memberProtocol;
      document.querySelectorAll("[data-member-protocol]").forEach((item) => {
        item.classList.toggle("active", item.dataset.memberProtocol === memberState.protocol);
      });
      renderConfigSample();
    });
  });
  document.querySelectorAll("[data-member-sample]").forEach((button) => {
    button.addEventListener("click", () => {
      memberState.sampleFormat = button.dataset.memberSample;
      document.querySelectorAll("[data-member-sample]").forEach((item) => {
        item.classList.toggle("active", item.dataset.memberSample === memberState.sampleFormat);
      });
      renderConfigSample();
    });
  });
  $("#member-model-select").addEventListener("change", () => {
    localStorage.setItem(MEMBER_MODEL_PREF_KEY, $("#member-model-select").value);
    renderModelPicker();
    renderConfigSample();
    renderCcSwitchLink();
  });
  bindModelPicker();
  $("#btn-copy-connect-code").addEventListener("click", (event) => copyText($("#member-connect-code").textContent, event.currentTarget));
  $("#member-ccswitch-key").addEventListener("input", renderCcSwitchLink);
  document.querySelectorAll("[data-ccswitch-app]").forEach((button) => {
    button.addEventListener("click", () => importCcSwitch(button.dataset.ccswitchApp));
  });
  $("#btn-copy-ccswitch-link").addEventListener("click", (event) => copyText($("#member-ccswitch-link").textContent, event.currentTarget));
  $("#btn-copy-key-identifier").addEventListener("click", (event) => copyText($("#member-key-identifier").textContent, event.currentTarget));
  // 充值弹窗：填充成员账号，关闭或跳转计费页。
  document.querySelectorAll("[data-member-topup]").forEach((button) => {
    button.addEventListener("click", () => {
      const account = $("#member-topup-account");
      if (account) account.textContent = memberState.session?.username ? "@" + memberState.session.username : "—";
      $("#member-topup")?.showModal();
    });
  });
  $("#btn-member-topup-close")?.addEventListener("click", () => $("#member-topup")?.close());
  $("#btn-member-topup-billing")?.addEventListener("click", () => {
    $("#member-topup")?.close();
    setMemberView("billing");
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-target],[data-copy-value]");
    if (!button) return;
    const target = button.dataset.copyTarget ? $("#" + button.dataset.copyTarget) : null;
    copyText(button.dataset.copyValue || target?.value || target?.textContent || "", button);
  });
  document.querySelectorAll("[data-usage-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      memberState.usageFilter = button.dataset.usageFilter;
      document.querySelectorAll("[data-usage-filter]").forEach((item) => {
        item.classList.toggle("active", item.dataset.usageFilter === memberState.usageFilter);
      });
      loadUsage(0).catch((error) => showToast(error.message));
    });
  });
  $("#member-usage-date").addEventListener("change", () => loadUsage(0).catch((error) => showToast(error.message)));
  $("#btn-member-usage-refresh").addEventListener("click", () => loadUsage().catch((error) => showToast(error.message)));
  $("#btn-member-usage-prev").addEventListener("click", () => loadUsage(memberState.usagePage - 1).catch((error) => showToast(error.message)));
  $("#btn-member-usage-next").addEventListener("click", () => loadUsage(memberState.usagePage + 1).catch((error) => showToast(error.message)));
  $("#btn-member-models-refresh")?.addEventListener("click", () => loadModels().catch((error) => showToast(error.message)));
  $("#member-models-search")?.addEventListener("input", () => renderModels());
  $("#member-playground-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sendPlayground();
  });
  // Enter 换行、Ctrl/⌘+Enter 发送：长问题可以分段输入。
  $("#member-playground-text").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      sendPlayground();
    }
  });
  $("#btn-pg-clear").addEventListener("click", clearPlayground);
  bindPgModelPicker();
}

/* 语言切换后，动态渲染的内容不会自己变（词表只重写带 data-i18n 的静态节点），
   所以这里按当前视图重新跑一遍渲染函数。按需只重渲染当前视图，不做无谓全量刷新。 */
function rerenderForLanguage() {
  if (!memberState.session) {
    // 未登录：只更新错误提示这类动态文本，登录页静态部分由 i18n.apply 处理
    return;
  }
  const renderers = {
    overview: () => {
      if (memberState.overview) renderOverview(memberState.overview);
      if (memberState.models) renderOverviewModels(memberState.models);
      renderTrend(memberState.trend);
    },
    key: () => { if (memberState.key) renderKey(memberState.key); },
    models: () => { if (memberState.models) renderModels(); },
    playground: () => renderPlayground(),
    billing: () => { if (memberState.billing) renderBilling(memberState.billing); },
    connect: () => { if (memberState.connect) renderConnect(); },
    usage: () => { if (memberState.usage) renderUsage(memberState.usage); },
  };
  renderers[memberState.view]?.();
  if (memberState.overview) renderRailQuota(memberState.overview);
}

(async function init() {
  bind();
  document.addEventListener("loean:langchange", rerenderForLanguage);
  // 调用记录页日期筛选默认业务日「今天」（Asia/Shanghai），与后端默认口径一致
  if (window.loeanDatePickers) window.loeanDatePickers.presetToday($("#member-usage-date"));
  try {
    const session = await memberApi("/api/member/session");
    if (session.authenticated) showApp(session);
    else showLogin();
  } catch {
    showLogin(t("member.error.unavailable"));
  }
})().catch((error) => showToast(error.message || String(error)));
