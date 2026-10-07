/* Administrator-only, explicit upstream checks; no automatic inference requests. */
const diagnosticState = { accounts: [], discovered: [], runs: [], latest: [], selected: null,
  loaded: false, active: false, loading: false, submitting: false, generation: 0, loadEpoch: 0, timer: null, modelTimer: null };
const DIAGNOSTIC_CASES = ["TEXT", "STREAM", "TOOLS", "TOOL_CONTINUATION", "IMAGE", "LONG_CONTEXT"];
const DIAGNOSTIC_ACTIVE = new Set(["QUEUED", "RUNNING"]);

function diagnosticError(message = "") {
  const node = $("#diagnostic-error");
  if (node) { node.textContent = message; node.hidden = !message; }
}
function diagnosticLabel(value) { return t("diagnostic.status." + (value || "NOT_TESTED")); }
function diagnosticBadge(status) {
  const safe = ["QUEUED", "PENDING", "RUNNING", "PASSED", "FAILED", "NOT_TESTED", "CANCELLED", "TIMED_OUT"].includes(status) ? status : "NOT_TESTED";
  return `<span class="diagnostic-badge diagnostic-${safe.toLowerCase()}">${escapeHtml(diagnosticLabel(safe))}</span>`;
}
function diagnosticNumber(value) { return value == null ? "—" : String(value); }
function diagnosticAccount() { return diagnosticState.accounts.find(account => account.id === $("#diagnostic-account")?.value); }
function diagnosticModel() { return $("#diagnostic-model")?.value.trim() || ""; }
function diagnosticQuery() {
  const query = new URLSearchParams({ limit: "20" });
  if ($("#diagnostic-account")?.value) query.set("accountId", $("#diagnostic-account").value);
  if (diagnosticModel()) query.set("upstreamModel", diagnosticModel());
  return query;
}

function renderDiagnosticModelOptions() {
  const account = diagnosticAccount();
  const models = diagnosticState.discovered.filter(model => model.platform === account?.platform);
  const names = [...new Set(models.map(model => model.upstreamModel).filter(Boolean))].sort();
  $("#diagnostic-model-options").innerHTML = names.map(name => `<option value="${escapeHtml(name)}"></option>`).join("");
  $("#diagnostic-account-note").textContent = account
    ? t(account.enabled ? "diagnostic.accountReady" : "diagnostic.accountDisabled", { platform: POOL_PLATFORMS[account.platform] || account.platform })
    : t("diagnostic.chooseAccount");
}

function renderDiagnosticResults() {
  const selected = diagnosticState.selected;
  const cases = selected?.cases || diagnosticState.latest;
  $("#diagnostic-result-title").textContent = selected ? t("diagnostic.runResults") : t("diagnostic.latestResults");
  $("#diagnostic-run-summary").textContent = selected
    ? t("diagnostic.runSummary", { account: selected.accountName || selected.accountId, model: selected.upstreamModel,
      status: diagnosticLabel(selected.status), time: formatTime(selected.createdAt) })
    : t("diagnostic.latestHint");
  $("#diagnostic-results").innerHTML = DIAGNOSTIC_CASES.map(type => {
    const item = cases.find(row => row.caseType === type);
    const status = item?.status || "NOT_TESTED";
    const stale = item?.checkedAt != null && item.isCurrent === false && !["NOT_TESTED", "PENDING", "RUNNING"].includes(status);
    return `<article class="diagnostic-result"><div class="diagnostic-result-head"><strong>${escapeHtml(t("diagnostic.case." + type))}</strong>${diagnosticBadge(status)}</div>
      ${stale ? `<p class="diagnostic-stale">${escapeHtml(t("diagnostic.stale"))}</p>` : ""}
      <p class="hint">${escapeHtml(item?.reason || t(["IMAGE", "LONG_CONTEXT"].includes(type) ? "diagnostic.separateCheck" : "diagnostic.notChecked"))}</p>
      <div class="pool-meta">${escapeHtml(item?.checkedAt ? formatTime(item.checkedAt) : "—")}${item?.durationMs != null ? " · " + escapeHtml(String(item.durationMs)) + " ms" : ""}</div>
      <div class="pool-meta">${escapeHtml(t("diagnostic.tokens", { input: diagnosticNumber(item?.inputTokens), output: diagnosticNumber(item?.outputTokens) }))}</div></article>`;
  }).join("");
  const cancel = $("#diagnostic-cancel");
  cancel.hidden = !selected || !DIAGNOSTIC_ACTIVE.has(selected.status);
  cancel.disabled = diagnosticState.submitting;
  $("#diagnostic-start").disabled = diagnosticState.submitting || !diagnosticAccount()?.enabled || !diagnosticModel()
    || !!diagnosticState.runs.find(run => run.accountId === diagnosticAccount()?.id && DIAGNOSTIC_ACTIVE.has(run.status));
  $("#diagnostic-history").innerHTML = diagnosticState.runs.length ? diagnosticState.runs.map(run =>
    `<tr><td>${escapeHtml(formatTime(run.createdAt))}</td><td>${escapeHtml(run.accountName || run.accountId)}</td><td><code>${escapeHtml(run.upstreamModel)}</code></td>
      <td>${diagnosticBadge(run.status)}${run.isCurrent === false && !DIAGNOSTIC_ACTIVE.has(run.status) ? `<div class="pool-meta">${escapeHtml(t("diagnostic.historical"))}</div>` : ""}</td>
      <td><button type="button" class="row-btn" data-diagnostic-run="${escapeHtml(run.id)}">${escapeHtml(t("diagnostic.details"))}</button></td></tr>`).join("")
    : `<tr><td colspan="5" class="pool-empty">${escapeHtml(t("diagnostic.empty"))}</td></tr>`;
}

async function refreshDiagnosticRuns() {
  const generation = diagnosticState.generation;
  const query = diagnosticQuery();
  const tasks = [api("/api/model-diagnostics/runs?" + query)];
  const hasSelection = query.has("accountId") && query.has("upstreamModel");
  tasks.push(hasSelection ? api("/api/model-diagnostics/latest?" + query) : Promise.resolve([]));
  const selectedId = diagnosticState.selected?.id;
  if (selectedId) tasks.push(api("/api/model-diagnostics/runs/" + encodeURIComponent(selectedId)));
  const [runs, latest, selected] = await Promise.all(tasks);
  if (generation !== diagnosticState.generation || !diagnosticState.active) return;
  diagnosticState.runs = poolArray(runs);
  diagnosticState.latest = poolArray(latest);
  if (selectedId && diagnosticState.selected?.id === selectedId) diagnosticState.selected = selected;
  renderDiagnosticResults();
}

function scheduleDiagnosticPoll() {
  clearTimeout(diagnosticState.timer);
  if (!diagnosticState.active || !state.admin.authenticated || state.view !== "models") return;
  if (!diagnosticState.runs.some(run => DIAGNOSTIC_ACTIVE.has(run.status)) && !DIAGNOSTIC_ACTIVE.has(diagnosticState.selected?.status)) return;
  diagnosticState.timer = setTimeout(async () => {
    try { await refreshDiagnosticRuns(); diagnosticError(); }
    catch (failure) { diagnosticError(failure.message); }
    finally { scheduleDiagnosticPoll(); }
  }, 2000);
}

async function activateModelDiagnostics() {
  if (diagnosticState.active && diagnosticState.loaded) { scheduleDiagnosticPoll(); return; }
  diagnosticState.active = true;
  if (diagnosticState.loading) return;
  const loadEpoch = ++diagnosticState.loadEpoch;
  diagnosticState.generation++;
  diagnosticState.loading = true;
  diagnosticError();
  try {
    const [accounts, discovered] = await Promise.all([api("/api/accounts"), api("/api/models/discovered")]);
    if (loadEpoch !== diagnosticState.loadEpoch || !diagnosticState.active) return;
    diagnosticState.accounts = poolArray(accounts);
    diagnosticState.discovered = poolArray(discovered);
    const select = $("#diagnostic-account"), previous = select.value;
    select.innerHTML = `<option value="">${escapeHtml(t("diagnostic.chooseAccount"))}</option>` + diagnosticState.accounts.map(account =>
      `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${escapeHtml(POOL_PLATFORMS[account.platform] || account.platform)}${account.enabled ? "" : " · " + escapeHtml(t("diagnostic.disabled"))}</option>`).join("");
    if (diagnosticState.accounts.some(account => account.id === previous)) select.value = previous;
    renderDiagnosticModelOptions();
    diagnosticState.loaded = true;
    await refreshDiagnosticRuns();
  } catch (failure) { if (loadEpoch === diagnosticState.loadEpoch) diagnosticError(failure.message); }
  finally { if (loadEpoch === diagnosticState.loadEpoch) diagnosticState.loading = false; scheduleDiagnosticPoll(); }
}

function stopModelDiagnostics() {
  diagnosticState.active = false;
  diagnosticState.loading = false;
  diagnosticState.generation++;
  diagnosticState.loadEpoch++;
  clearTimeout(diagnosticState.timer);
  clearTimeout(diagnosticState.modelTimer);
}

function diagnosticTargetChanged(delay = 0) {
  const generation = ++diagnosticState.generation;
  diagnosticState.selected = null;
  diagnosticState.latest = [];
  clearTimeout(diagnosticState.modelTimer);
  renderDiagnosticResults();
  diagnosticState.modelTimer = setTimeout(() => {
    if (generation !== diagnosticState.generation || !diagnosticState.active) return;
    refreshDiagnosticRuns().then(scheduleDiagnosticPoll).catch(failure => diagnosticError(failure.message));
  }, delay);
}

function bindModelDiagnostics() {
  const template = $("#model-diagnostic-panel-template");
  $("#view-models").append(template.content.cloneNode(true));
  template.remove();
  const tab = document.createElement("button");
  tab.type = "button"; tab.className = "subtab"; tab.dataset.poolTab = "diagnostics";
  tab.dataset.i18n = "diagnostic.tab"; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", "false");
  tab.textContent = t("diagnostic.tab");
  $(".pool-tabs").append(tab);
  window.loeanI18n?.apply($("#pool-diagnostics-panel"));
  renderDiagnosticResults();
  $("#diagnostic-account").addEventListener("change", () => {
    $("#diagnostic-model").value = "";
    renderDiagnosticModelOptions(); diagnosticTargetChanged();
  });
  $("#diagnostic-model").addEventListener("input", () => diagnosticTargetChanged(250));
  $("#diagnostic-model").addEventListener("change", () => diagnosticTargetChanged());
  $("#diagnostic-refresh").addEventListener("click", () => {
    diagnosticState.loaded = false;
    activateModelDiagnostics();
  });
  $("#diagnostic-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (diagnosticState.submitting) return;
    const cases = [...$("#diagnostic-form").querySelectorAll("[name=diagnosticCase]:checked")].map(input => input.value);
    if (!cases.length) { diagnosticError(t("diagnostic.chooseCases")); return; }
    const generation = diagnosticState.generation;
    diagnosticState.submitting = true; diagnosticError(); renderDiagnosticResults();
    try {
      const run = await api("/api/model-diagnostics/runs", { method: "POST", body: JSON.stringify({
        accountId: $("#diagnostic-account").value, upstreamModel: diagnosticModel(), cases,
        confirmSpend: true, timeoutSeconds: Number($("#diagnostic-timeout").value) }) });
      if (generation !== diagnosticState.generation) return;
      diagnosticState.selected = run;
      await refreshDiagnosticRuns();
    } catch (failure) { if (generation === diagnosticState.generation) diagnosticError(failure.message); }
    finally { diagnosticState.submitting = false; renderDiagnosticResults(); scheduleDiagnosticPoll(); }
  });
  $("#diagnostic-cancel").addEventListener("click", async () => {
    const selected = diagnosticState.selected;
    if (!selected || diagnosticState.submitting) return;
    diagnosticState.submitting = true; renderDiagnosticResults();
    try {
      const run = await api("/api/model-diagnostics/runs/" + encodeURIComponent(selected.id) + "/cancel", { method: "POST" });
      if (diagnosticState.selected?.id === selected.id) diagnosticState.selected = run;
      await refreshDiagnosticRuns();
    } catch (failure) { diagnosticError(failure.message); }
    finally { diagnosticState.submitting = false; renderDiagnosticResults(); scheduleDiagnosticPoll(); }
  });
  $("#diagnostic-history").addEventListener("click", async event => {
    const button = event.target.closest("[data-diagnostic-run]");
    if (!button) return;
    const generation = ++diagnosticState.generation;
    try {
      const run = await api("/api/model-diagnostics/runs/" + encodeURIComponent(button.dataset.diagnosticRun));
      if (generation !== diagnosticState.generation) return;
      diagnosticState.selected = run; renderDiagnosticResults(); scheduleDiagnosticPoll();
    } catch (failure) { diagnosticError(failure.message); }
  });
  document.addEventListener("loean:langchange", () => { if (diagnosticState.loaded) { renderDiagnosticModelOptions(); renderDiagnosticResults(); } });
}
