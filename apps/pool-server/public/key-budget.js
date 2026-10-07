/* Shared editor for CNY limits. Monetary values stay decimal strings throughout the UI. */
(function () {
  const state = { epoch: 0, options: null, data: null, busy: false };
  const periods = ["total", "daily", "weekly"];
  const money = value => value == null ? t("budget.unlimited") : "¥ " + String(value);
  function dialog() { return document.getElementById("key-budget-dialog"); }
  function ensure() {
    if (dialog()) return;
    const node = document.createElement("dialog");
    node.id = "key-budget-dialog"; node.className = "key-budget-dialog";
    node.innerHTML = `<form id="key-budget-form"><h3 id="key-budget-title"></h3><p id="key-budget-description" class="key-ui-note"></p>
      <div class="key-ui-table-wrap"><table class="key-ui-table"><thead><tr><th>${escapeHtml(t("budget.period"))}</th><th>${escapeHtml(t("budget.limit"))}</th><th>${escapeHtml(t("budget.used"))}</th><th>${escapeHtml(t("budget.available"))}</th></tr></thead><tbody id="key-budget-summary"></tbody></table></div>
      <p id="key-budget-root" class="key-ui-note"></p><p id="key-budget-reset" class="key-ui-note"></p>
      <div class="key-ui-grid">${periods.map(period => `<label>${escapeHtml(t("budget.edit." + period))}<input type="text" inputmode="decimal" name="${period}" maxlength="24" pattern="[0-9]+(\\.[0-9]{1,6})?" /></label>`).join("")}</div>
      <p class="key-ui-note">${escapeHtml(t("budget.help"))}</p><p class="key-ui-note">${escapeHtml(t("budget.settlement"))}</p>
      <p id="key-budget-error" class="key-ui-error" role="alert" hidden></p>
      <div class="key-ui-actions"><button type="button" data-budget-close>${escapeHtml(t("keymgmt.cancel"))}</button><button id="key-budget-save" type="submit">${escapeHtml(t("budget.save"))}</button></div></form>`;
    document.body.append(node);
    node.querySelector("[data-budget-close]").addEventListener("click", () => node.close());
    node.addEventListener("close", () => { state.epoch++; state.options = null; state.data = null; state.busy = false; });
    node.querySelector("form").addEventListener("submit", save);
  }
  function error(message = "") {
    const target = dialog().querySelector("#key-budget-error"); target.textContent = message; target.hidden = !message;
  }
  function render(data) {
    state.data = data;
    const node = dialog();
    node.querySelector("#key-budget-description").textContent = t(data.scope === "ROOT_POOL" ? "budget.rootScope" : "budget.keyScope");
    node.querySelector("#key-budget-summary").innerHTML = periods.map(period => `<tr><td>${escapeHtml(t("budget.period." + period))}</td>
      <td>${escapeHtml(money(data.effectiveLimits?.[period]))}</td><td>${escapeHtml(money(data.usage?.[period] ?? "0"))}</td><td>${escapeHtml(money(data.available?.[period]))}</td></tr>`).join("");
    node.querySelector("#key-budget-root").textContent = data.rootBudget ? t("budget.parentRemaining", {
      total: money(data.rootBudget.remaining?.total), daily: money(data.rootBudget.remaining?.daily), weekly: money(data.rootBudget.remaining?.weekly) }) : "";
    node.querySelector("#key-budget-reset").textContent = t("budget.reset", { zone: data.zoneId || "", daily: data.dailyResetAt || "—", weekly: data.weeklyResetAt || "—" });
    const values = state.options.mode === "member" ? data.memberLimits : data.adminLimits;
    for (const period of periods) { const input = node.querySelector(`[name="${period}"]`); input.value = values?.[period] ?? ""; input.disabled = !data.editable; }
    node.querySelector("#key-budget-save").hidden = !data.editable;
    node.querySelector(".key-ui-grid").hidden = !data.editable;
    node.querySelector("#key-budget-save").disabled = state.busy;
  }
  async function open(options) {
    ensure(); state.options = options; state.data = null; state.busy = false;
    const epoch = ++state.epoch, node = dialog();
    node.querySelector("#key-budget-title").textContent = t("budget.title", { name: options.name || "Key" });
    node.querySelector("#key-budget-summary").innerHTML = "";
    node.querySelector("#key-budget-root").textContent = "";
    node.querySelector("#key-budget-description").textContent = t("budget.loading");
    node.querySelector("#key-budget-save").hidden = true;
    for (const input of node.querySelectorAll("input")) { input.value = ""; input.disabled = true; }
    error(); if (!node.open) node.showModal();
    try { const data = await options.api(options.path); if (epoch === state.epoch) render(data); }
    catch (failure) { if (epoch === state.epoch) error(failure.message); }
  }
  async function save(event) {
    event.preventDefault();
    if (state.busy || !state.data?.editable || !state.options) return;
    const options = state.options, epoch = state.epoch, body = {};
    for (const period of periods) {
      const value = dialog().querySelector(`[name="${period}"]`).value.trim();
      if (value && !/^\d+(?:\.\d{1,6})?$/.test(value)) { error(t("budget.invalid")); return; }
      body[period] = value || null;
    }
    state.busy = true; error(); dialog().querySelector("#key-budget-save").disabled = true;
    try {
      const data = await options.api(options.path, { method: "PUT", body: JSON.stringify(body) });
      if (epoch !== state.epoch) return;
      render(data); options.saved?.(data); dialog().close();
    } catch (failure) { if (epoch === state.epoch) error(failure.message); }
    finally { if (epoch === state.epoch) { state.busy = false; dialog().querySelector("#key-budget-save").disabled = false; } }
  }
  window.keyBudgetUi = { open, close: () => dialog()?.close() };
})();
