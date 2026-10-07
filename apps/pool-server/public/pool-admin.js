/* Admin-only account login and public model catalog. Loaded before app.js. */
const POOL_PLATFORMS = { WORKBUDDY: "WorkBuddy", TRAE: "Trae", CODEX: "Codex", ZCODE: "ZCode", MIMO: "MiMo", CURSOR: "Cursor", COPILOT: "GitHub Copilot", QODER: "Qoder CN", CLAUDE: "Claude", GEMINI: "Gemini", GROK: "Grok" };
/* CLAUDE 走托管 OAuth 授权对话框（授权链接 + 粘贴回调），不经 Node bridge。 */
const POOL_LOGIN_PLATFORMS = ["CURSOR", "COPILOT", "QODER", "CLAUDE"];
const poolState = { models: [], discovered: [], discoveredLoaded: false, discoveryStatus: null, discoveryStatusPolling: false, seenNoticeRevisions: {}, tab: "public", loaded: false, editId: null, loginAccount: null, loginTimer: null, loginGeneration: 0, loginJob: null, keySelection: null, keyReady: false, keyGeneration: 0, batchSelection: new Set(), batchPublishing: false };
const POOL_SYNC_PLATFORMS = { workbuddy: "WorkBuddy", qoder: "Qoder CN", trae: "Trae" };
const POOL_ADD_NOTICE_KEYS = { workbuddy: "loean-pool-workbuddy-add-notice-revision", qoder: "loean-pool-qoder-add-notice-revision", trae: "loean-pool-trae-add-notice-revision" };

function poolLoginPlatform(platform) { return POOL_LOGIN_PLATFORMS.includes(platform); }
function accountAuthSupported(platform) { return platform === "TRAE" || poolLoginPlatform(platform); }
function poolArray(data) { return Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : []; }
function poolEfforts(value) { return Array.isArray(value) ? value : String(value || "").split(/[\s,，]+/).filter(Boolean); }
const POOL_EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"];
function poolEffortChecksHtml(selected, includeNone) {
  const chosen = poolEfforts(selected);
  const values = [...new Set([...POOL_EFFORT_OPTIONS, ...(includeNone ? ["none"] : []), ...chosen])];
  return values.map(effort => `<label class="pool-effort"><input type="checkbox" value="${escapeHtml(effort)}" ${chosen.includes(effort) ? "checked" : ""} /><span>${escapeHtml(effort === "none" ? t("pool.effortNone") : effort)}</span></label>`).join("");
}
function poolCheckedEfforts(container) {
  return container ? [...container.querySelectorAll("input[type='checkbox']:checked")].map(input => input.value).filter(Boolean) : [];
}
function poolModelId(model) { return model.publicId || model.id || ""; }
function poolIsSelectionMode(model) {
  const name = String(model.upstreamModel || model.model || model.publicId || model.id || "").trim().toLowerCase().split("/").at(-1);
  return name === "auto" || name === "default";
}
function poolCapabilities(model) {
  const tags = [];
  const images = model.supportsImages ?? model.supports_images;
  const tools = model.supportsTools ?? model.supports_tools;
  const reportedEfforts = model.reasoningEfforts ?? model.reasoning_efforts;
  if (images === true) tags.push(t("pool.images"));
  if (model.platform === "TRAE" && model.verificationStatus !== "VERIFIED"
    && model.upstreamMultimodal === true) tags.push(t("pool.upstreamMultimodal"));
  if (tools === true) tags.push(t("pool.tools"));
  const efforts = poolEfforts(reportedEfforts);
  if (efforts.length) tags.push(t("pool.reasoning") + ": " + efforts.join(", "));
  const hasUnknown = !!model.platform && model.verificationStatus !== "VERIFIED"
    && (images == null || tools == null || reportedEfforts == null);
  if (!tags.length) return `<span class="muted-text">${escapeHtml(t(hasUnknown ? "pool.capabilitiesUnknown" : "pool.text"))}</span>`;
  const known = tags.map(label => `<span class="pill">${escapeHtml(label)}</span>`).join("");
  return hasUnknown ? known + `<span class="muted-text">${escapeHtml(t("pool.otherCapabilitiesUnknown"))}</span>` : known;
}

function renderPoolPlatformFilter(selector, sourcePlatforms) {
  const select = $(selector);
  if (!select) return;
  const selected = select.value;
  const platforms = [...new Set(sourcePlatforms.map(platform => String(platform || "").trim()).filter(Boolean))]
    .sort((left, right) => (POOL_PLATFORMS[left] || left).localeCompare(POOL_PLATFORMS[right] || right));
  select.innerHTML = [`<option value="">${escapeHtml(t("pool.allPlatforms"))}</option>`,
    ...platforms.map(platform => `<option value="${escapeHtml(platform)}">${escapeHtml(POOL_PLATFORMS[platform] || platform)}</option>`)
  ].join("");
  select.value = platforms.includes(selected) ? selected : "";
}

function renderDraftPlatformFilter() {
  renderPoolPlatformFilter("#pool-draft-platform", poolState.models
    .filter(model => !model.published)
    .flatMap(model => (model.routes || []).map(route => route.platform)));
}

function renderDiscoveredPlatformFilter() {
  renderPoolPlatformFilter("#pool-discovered-platform", poolState.discovered.map(model => model.platform));
}

function poolModelNames(value) { return Array.isArray(value) ? value.map(name => String(name || "").trim()).filter(Boolean) : []; }
function poolSyncStatuses(data = poolState.discoveryStatus) {
  return Object.entries(POOL_SYNC_PLATFORMS).map(([key, label]) => ({ key, label, status: data?.[key] || null }));
}
function renderPoolDiscoveryAlert() {
  const alert = $("#pool-discovery-alert");
  if (!alert) return;
  const lines = [];
  for (const { label, status } of poolSyncStatuses()) {
    if (status?.state === "failed") {
      lines.push(t("pool.discoveryFailedAt", {
        platform: label, time: formatTime(status.lastFailureAt || status.lastAttemptAt),
        message: status.error || t("pool.discoveryUnknownReason")
      }));
      continue;
    }
    const unavailable = poolModelNames(status?.unavailableModels);
    if (unavailable.length) lines.push(t("pool.discoveryRemoved", { platform: label, count: unavailable.length, models: unavailable.join("、") }));
    const affected = poolModelNames(status?.affectedPublicModels);
    if (unavailable.length && affected.length) lines.push(t("pool.discoveryAffected", { platform: label, models: affected.join("、") }));
  }
  alert.hidden = lines.length === 0;
  $("#pool-discovery-alert-title").textContent = lines.length ? t("pool.discoveryAttention") : "";
  $("#pool-discovery-alert-body").replaceChildren(...lines.map(line => {
    const item = document.createElement("div");
    item.textContent = line;
    return item;
  }));
}
function applyPoolDiscoveryStatus(data, { suppressAddedToast = false } = {}) {
  poolState.discoveryStatus = data || null;
  renderPoolDiscoveryAlert();
  const additions = [];
  for (const { key, label, status } of poolSyncStatuses()) {
    const added = poolModelNames(status?.noticeAdded);
    const revision = String(status?.noticeRevision || "");
    if (status?.state !== "ok" || !added.length || !revision) continue;
    let seen = poolState.seenNoticeRevisions[key] || "";
    try { seen ||= localStorage.getItem(POOL_ADD_NOTICE_KEYS[key]) || ""; } catch { /* Storage may be disabled. */ }
    if (!suppressAddedToast && seen !== revision) additions.push(t("pool.discoveryAdded", { platform: label, count: added.length, models: added.join("、") }));
    poolState.seenNoticeRevisions[key] = revision;
    try { localStorage.setItem(POOL_ADD_NOTICE_KEYS[key], revision); } catch { /* Keep the in-memory revision. */ }
  }
  if (additions.length) toast(additions.join(" · "), "ok");
}

async function loadPoolModels({ suppressAddedToast = false } = {}) {
  $("#pool-load-error").hidden = true;
  if (!poolState.loaded) {
    $("#pool-public-list").innerHTML = `<tr><td colspan="5" class="pool-empty">${escapeHtml(t("pool.loading"))}</td></tr>`;
    $("#pool-drafts-list").innerHTML = `<tr><td colspan="6" class="pool-empty">${escapeHtml(t("pool.loading"))}</td></tr>`;
  }
  const results = await Promise.allSettled([api("/api/models"), api("/api/models/discovered"), api("/api/models/discovery-status")]);
  if (results[0].status === "fulfilled") {
    poolState.models = poolArray(results[0].value).filter(model => !poolIsSelectionMode(model));
    const draftIds = new Set(poolState.models.filter(model => !model.published).map(model => String(model.id)));
    for (const id of poolState.batchSelection || []) if (!draftIds.has(id)) poolState.batchSelection.delete(id);
    poolState.loaded = true;
  }
  if (results[1].status === "fulfilled") {
    poolState.discovered = poolArray(results[1].value).filter(model => !poolIsSelectionMode(model)).map(model => model.verificationStatus === "VERIFIED" ? { ...model, modelVersion: model.verifiedModelVersion || model.modelVersion, supportsImages: model.verifiedSupportsImages === true, supportsTools: model.verifiedSupportsTools === true, reasoningEfforts: model.verifiedReasoningEfforts || [] } : model);
    poolState.discoveredLoaded = true;
  } else poolState.discoveredLoaded = false;
  if (results[2].status === "fulfilled") applyPoolDiscoveryStatus(results[2].value, { suppressAddedToast });
  else applyPoolDiscoveryStatus(null, { suppressAddedToast: true });
  renderPoolModels();
  const errors = results.filter(r => r.status === "rejected").map(r => r.reason.message);
  if (errors.length) {
    $("#pool-load-error").textContent = t("admin.load.failed", { message: errors.join(" · ") });
    $("#pool-load-error").hidden = false;
  }
  return { statusLoaded: results[2].status === "fulfilled" };
}

async function pollPoolDiscoveryStatus() {
  if (poolState.discoveryStatusPolling || state.view !== "models" || !state.admin.authenticated) return;
  poolState.discoveryStatusPolling = true;
  try {
    const previousAttempts = Object.fromEntries(poolSyncStatuses().map(({ key, status }) => [key, status?.lastAttemptAt || null]));
    const status = await api("/api/models/discovery-status");
    const changed = poolSyncStatuses(status).some(({ key, status: item }) => previousAttempts[key] !== (item?.lastAttemptAt || null));
    if (poolState.loaded && changed) await loadPoolModels();
    else applyPoolDiscoveryStatus(status);
  } catch (error) {
    applyPoolDiscoveryStatus(null, { suppressAddedToast: true });
    $("#pool-load-error").textContent = t("admin.load.failed", { message: error.message });
    $("#pool-load-error").hidden = false;
  } finally { poolState.discoveryStatusPolling = false; }
}

function poolPublicRouteHtml(route) {
  const unavailable = poolState.discoveredLoaded && ["WORKBUDDY", "QODER"].includes(route.platform)
    && !poolState.discovered.some(model => model.platform === route.platform
      && model.upstreamModel === route.upstreamModel && model.available !== false);
  const marker = route.enabled === false || unavailable ? "○" : "●";
  const note = unavailable ? ` · <span class="pool-route-unavailable">${escapeHtml(t("pool.routeUnavailable"))}</span>` : "";
  return `<div class="pool-meta">${marker} ${escapeHtml(POOL_PLATFORMS[route.platform] || route.platform)} · ${escapeHtml(route.upstreamModel)} · ${escapeHtml(t("pool.priorityValue", { priority: route.priority ?? 0 }))}${note}</div>`;
}

function poolExistingPublicModel(source) {
  const actualModel = source.upstreamModel || source.model || source.id || "";
  return poolState.models.find(model => (model.routes || []).some(route => route.platform === source.platform
    && route.upstreamModel === actualModel)) || null;
}

function poolDiscoveredRoute(source, enabled = true) {
  return {
    platform: source.platform,
    upstreamModel: source.upstreamModel || source.model || source.id || "",
    priority: 0,
    enabled,
    supportsImages: !!(source.supportsImages ?? source.supports_images),
    supportsTools: !!(source.supportsTools ?? source.supports_tools),
    reasoningEfforts: poolEfforts(source.reasoningEfforts ?? source.reasoning_efforts)
  };
}

function poolDiscoveredBackupRoute(source, existing) {
  const priorities = (existing.routes || []).map(route => Number(route.priority))
    .filter(priority => Number.isSafeInteger(priority) && priority >= 0);
  return { ...poolDiscoveredRoute(source, !existing.published), priority: Math.max(-1, ...priorities) + 1 };
}

function poolVisibleDrafts() {
  const keyword = ($("#pool-model-search")?.value || "").trim().toLowerCase();
  const platform = $("#pool-draft-platform")?.value || "";
  return poolState.models.filter(model => !model.published
    && [poolModelId(model), model.name, model.description].join(" ").toLowerCase().includes(keyword)
    && (!platform || (model.routes || []).some(route => route.platform === platform)));
}

function updatePoolBatchControls(visibleDraftIds = null) {
  const button = $("#btn-pool-batch-publish");
  const selectAll = $("#pool-select-all-drafts");
  const visible = visibleDraftIds || [...$("#pool-drafts-list").querySelectorAll("[data-pool-select-draft]")].map(input => String(input.value));
  const selected = visible.filter(id => poolState.batchSelection.has(id)).length;
  button.disabled = poolState.batchPublishing || poolState.batchSelection.size === 0;
  button.textContent = t(poolState.batchSelection.size ? "pool.batchPublishCount" : "pool.batchPublish", { count: poolState.batchSelection.size });
  selectAll.disabled = poolState.batchPublishing || visible.length === 0;
  selectAll.checked = visible.length > 0 && selected === visible.length;
  selectAll.indeterminate = selected > 0 && selected < visible.length;
}

async function submitPoolBatchPublish() {
  const visibleIds = new Set(poolVisibleDrafts().map(model => String(model.id)));
  const ids = [...poolState.batchSelection].filter(id => visibleIds.has(id));
  if (!ids.length || poolState.batchPublishing) return;
  poolState.batchPublishing = true;
  updatePoolBatchControls();
  const error = $("#pool-load-error");
  error.hidden = true;
  try {
    await api("/api/models/batch-publish", { method: "POST", body: JSON.stringify({ modelIds: ids }) });
    poolState.batchSelection.clear();
    await loadPoolModels();
    toast(t("pool.batchPublished", { count: ids.length }), "ok");
  } catch (failure) {
    error.textContent = t("pool.batchPublishFailed", { message: failure.message });
    error.hidden = false;
  } finally {
    poolState.batchPublishing = false;
    updatePoolBatchControls();
  }
}

async function generateMissingDiscoveredDrafts() {
  const button = $("#btn-pool-generate-drafts");
  if (button.disabled) return;
  button.disabled = true;
  const error = $("#pool-load-error");
  error.hidden = true;
  try {
    const createdDrafts = poolArray(await api("/api/models/drafts/from-discovered", { method: "POST" }));
    await loadPoolModels();
    if (createdDrafts.length) setPoolTab("drafts");
    toast(t("pool.draftsGenerated"), "ok");
  } catch (failure) {
    error.textContent = t("pool.draftGenerationFailed", { message: failure.message });
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function poolModelRow(model, draft) {
  const routes = [...(model.routes || [])].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
  const selection = draft ? `<td class="pool-select-col"><input type="checkbox" data-pool-select-draft value="${escapeHtml(model.id)}" aria-label="${escapeHtml(t("pool.selectDraft", { model: poolModelId(model) }))}" ${poolState.batchSelection.has(String(model.id)) ? "checked" : ""} /></td>` : "";
  return `<tr data-model-id="${escapeHtml(model.id)}">${selection}<td><div class="cell-title">${escapeHtml(model.name || poolModelId(model))}</div><code>${escapeHtml(poolModelId(model))}</code><div class="pool-meta">${escapeHtml(model.description || "")}</div></td>
    <td><div class="pool-capabilities">${poolCapabilities(model)}</div><div class="pool-meta">${escapeHtml([model.modelVersion, model.contextWindow ? t("pool.contextValue", { count: formatNum(model.contextWindow) }) : ""].filter(Boolean).join(" · "))}</div></td>
    <td>${routes.map(poolPublicRouteHtml).join("") || "—"}</td>
    <td>${statusPill(draft ? "warn" : "ok", t(draft ? "pool.draft" : "pool.published"))}</td>
    <td><div class="row-actions"><button class="row-btn" data-pool-act="edit">${escapeHtml(t("admin.keys.act.edit"))}</button><button class="row-btn" data-pool-act="publish">${escapeHtml(t(draft ? "pool.publish" : "pool.unpublish"))}</button><button class="row-btn danger" data-pool-act="delete">${escapeHtml(t("admin.accounts.act.del"))}</button></div></td></tr>`;
}

function renderPoolModels() {
  const keyword = ($("#pool-model-search")?.value || "").trim().toLowerCase();
  renderPoolDiscoveryAlert();
  renderDraftPlatformFilter();
  renderDiscoveredPlatformFilter();
  const selectedDraftPlatform = $("#pool-draft-platform")?.value || "";
  const selectedDiscoveredPlatform = $("#pool-discovered-platform")?.value || "";
  const models = poolState.models.filter(m => [poolModelId(m), m.name, m.description].join(" ").toLowerCase().includes(keyword));
  const publicModels = models.filter(model => model.published);
  const drafts = poolVisibleDrafts();
  const visibleDraftIds = new Set(drafts.map(model => String(model.id)));
  for (const id of poolState.batchSelection) if (!visibleDraftIds.has(id)) poolState.batchSelection.delete(id);
  const publishedCount = poolState.models.filter(model => model.published).length;
  $("#pool-model-count").textContent = t("pool.count", { total: poolState.models.length, published: publishedCount, drafts: poolState.models.length - publishedCount });
  $("#pool-public-list").innerHTML = publicModels.length ? publicModels.map(model => poolModelRow(model, false)).join("")
    : `<tr><td colspan="5" class="pool-empty">${escapeHtml(t(keyword ? "member.noMatchModels" : "pool.publicEmpty"))}</td></tr>`;
  $("#pool-drafts-list").innerHTML = drafts.length ? drafts.map(model => poolModelRow(model, true)).join("")
    : `<tr><td colspan="6" class="pool-empty">${escapeHtml(t(keyword || selectedDraftPlatform ? "member.noMatchModels" : "pool.draftsEmpty"))}</td></tr>`;
  updatePoolBatchControls([...visibleDraftIds]);
  const discovered = poolState.discovered.map((m, index) => ({ ...m, _index: index })).filter(m =>
    (!selectedDiscoveredPlatform || m.platform === selectedDiscoveredPlatform)
      && [m.upstreamModel, m.model, m.id, m.name, m.platform].join(" ").toLowerCase().includes(keyword));
  $("#pool-discovered-list").innerHTML = discovered.length ? discovered.map(model => {
    const existing = poolExistingPublicModel(model);
    const actualModel = model.upstreamModel || model.model || model.id || "";
    const sameName = existing ? null : poolState.models.find(configured => poolModelId(configured) === actualModel);
    const action = existing
      ? `<button class="row-btn primary" data-pool-edit-existing="${escapeHtml(existing.id)}">${escapeHtml(t("pool.editExisting"))}</button>`
      : sameName
        ? `<button class="row-btn primary" data-pool-add-route-existing="${escapeHtml(sameName.id)}" data-pool-source-index="${model._index}">${escapeHtml(t(sameName.published ? "pool.addPendingRouteToExisting" : "pool.addRouteToExisting"))}</button>`
        : `<button class="row-btn primary" data-pool-import="${model._index}">${escapeHtml(t("pool.createFromDiscovered"))}</button>`;
    return `<tr><td>${platformPill(model.platform)}</td><td><code>${escapeHtml(model.upstreamModel || model.model || model.id || "—")}</code><div class="pool-meta">${escapeHtml(model.name || "")}</div>${model.availableModes?.length ? `<div class="pool-meta">${escapeHtml(t("pool.availableModes", { modes: model.availableModes.join(" / ") }))}</div>` : ""}<div class="pool-meta">${escapeHtml(t(model.catalogSource === "static_reference" ? "pool.staticCandidate" : model.available === false ? "pool.discoveryUnavailable" : "pool.discoveryAvailable"))}${model.catalogSource === "static_reference" ? "" : " · " + escapeHtml(formatTime(model.lastSeenAt))}</div><div class="pool-meta">${escapeHtml(t(model.verificationStatus === "VERIFIED" ? "pool.verified" : model.verificationStatus === "INVALIDATED" ? "pool.invalidated" : "pool.unverified"))} · ${escapeHtml(model.verificationSource || "—")} ${escapeHtml(model.verifiedAt ? formatTime(model.verifiedAt) : "")}${model.verificationInvalidatedAt ? " · " + escapeHtml(formatTime(model.verificationInvalidatedAt)) : ""}</div></td><td><div class="pool-capabilities">${poolCapabilities(model)}</div></td><td><button class="row-btn" data-pool-verify="${model._index}">${escapeHtml(t("pool.verify"))}</button>${action}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="pool-empty">${escapeHtml(t(keyword || selectedDiscoveredPlatform ? "member.noMatchModels" : "pool.discoveredEmpty"))}</td></tr>`;
  setPoolTab(poolState.tab);
}

function setPoolTab(tab) {
  poolState.tab = tab;
  $("#pool-public-panel").hidden = tab !== "public";
  $("#pool-drafts-panel").hidden = tab !== "drafts";
  $("#pool-discovered-panel").hidden = tab !== "discovered";
  $("#pool-draft-platform-filter").hidden = tab !== "drafts";
  $("#pool-discovered-platform-filter").hidden = tab !== "discovered";
  if ($("#pool-diagnostics-panel")) $("#pool-diagnostics-panel").hidden = tab !== "diagnostics";
  if ($("#pool-model-search")) $("#pool-model-search").hidden = tab === "diagnostics";
  document.querySelectorAll("[data-pool-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.poolTab === tab);
    button.setAttribute("aria-selected", String(button.dataset.poolTab === tab));
  });
  if (tab === "diagnostics" && typeof activateModelDiagnostics === "function") activateModelDiagnostics();
  else if (typeof stopModelDiagnostics === "function") stopModelDiagnostics();
}

function poolRouteHtml(route = {}) {
  return `<fieldset class="pool-route" data-route-id="${escapeHtml(route.id || "")}"><div class="pool-route-head"><strong data-i18n="pool.route">${escapeHtml(t("pool.route"))}</strong><button type="button" class="row-btn danger" data-remove-route data-i18n="pool.removeRoute">${escapeHtml(t("pool.removeRoute"))}</button></div>
    <div class="pool-form-grid"><label><span data-i18n="admin.th.platform">${escapeHtml(t("admin.th.platform"))}</span><select data-route-field="platform">${Object.entries(POOL_PLATFORMS).map(([value, label]) => `<option value="${value}" ${value === route.platform ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label><span data-i18n="pool.actualModel">${escapeHtml(t("pool.actualModel"))}</span><input data-route-field="upstreamModel" value="${escapeHtml(route.upstreamModel || "")}" required maxlength="256" list="pool-upstream-options" /></label>
    <label><span data-i18n="pool.priority">${escapeHtml(t("pool.priority"))}</span><input data-route-field="priority" type="number" min="0" step="1" value="${Number.isFinite(Number(route.priority)) ? Number(route.priority) : 0}" required /></label>
    <label class="pool-wide"><span data-i18n="pool.routeEfforts">${escapeHtml(t("pool.routeEfforts"))}</span><div class="pool-checks pool-effort-checks" data-route-field="reasoningEfforts">${poolEffortChecksHtml(route.reasoningEfforts, true)}</div></label></div>
    <div class="pool-checks"><label><input type="checkbox" data-route-field="enabled" ${route.enabled !== false ? "checked" : ""} /><span data-i18n="admin.dlg.enabled">${escapeHtml(t("admin.dlg.enabled"))}</span></label><label><input type="checkbox" data-route-field="supportsImages" ${route.supportsImages ? "checked" : ""} /><span data-i18n="pool.images">${escapeHtml(t("pool.images"))}</span></label><label><input type="checkbox" data-route-field="supportsTools" ${route.supportsTools ? "checked" : ""} /><span data-i18n="pool.tools">${escapeHtml(t("pool.tools"))}</span></label></div></fieldset>`;
}

function poolQoderChoices() {
  const routes = [...$("#pool-routes").querySelectorAll(".pool-route")]
    .filter(row => row.querySelector('[data-route-field="platform"]').value === "QODER"
      && row.querySelector('[data-route-field="enabled"]').checked);
  if (!routes.length) return null;
  const discovered = routes.map(row => poolState.discovered.find(model => model.platform === "QODER"
    && model.upstreamModel === row.querySelector('[data-route-field="upstreamModel"]').value.trim()
    && model.available !== false));
  if (discovered.some(model => !model)) return { efforts: [], windows: [], incomplete: true };
  const effortSets = discovered.map((model, index) => {
    const routeEfforts = poolCheckedEfforts(routes[index].querySelector('[data-route-field="reasoningEfforts"]'));
    return poolEfforts(model.reasoningEfforts)
      .filter(effort => routeEfforts.includes(effort) && (effort !== "none" || model.supportsDisabledReasoning === true));
  });
  const windowSets = discovered.map(model => (model.availableContextWindows || [])
    .map(Number).filter(window => Number.isSafeInteger(window) && window > 0));
  return {
    efforts: effortSets[0].filter(effort => effortSets.every(list => list.includes(effort))),
    windows: [...new Set(windowSets[0].filter(window => windowSets.every(list => list.includes(window))))].sort((a, b) => a - b),
    incomplete: false
  };
}

function poolQoderSelect(select, values, selected, label) {
  const current = String(selected || "");
  select.innerHTML = `<option value="">${escapeHtml(t("pool.qoderFollowDefault"))}</option>`
    + values.map(value => `<option value="${escapeHtml(String(value))}">${escapeHtml(label(value))}</option>`).join("");
  if (current && !values.map(String).includes(current)) {
    select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(current)}" disabled>${escapeHtml(t("pool.qoderUnavailableChoice", { value: current }))}</option>`);
  }
  select.value = current;
}

function renderPoolQoderDefaults(selectedEffort, selectedContext) {
  const section = $("#pool-qoder-defaults");
  const effort = formField($("#form-pool-model"), "defaultReasoningEffort");
  const context = formField($("#form-pool-model"), "defaultContextWindow");
  const currentEffort = selectedEffort === undefined ? effort.value : selectedEffort;
  const currentContext = selectedContext === undefined ? context.value : selectedContext;
  const choices = poolQoderChoices();
  section.hidden = !choices;
  if (!choices) {
    poolQoderSelect(effort, [], currentEffort, String);
    poolQoderSelect(context, [], currentContext, String);
    return;
  }
  poolQoderSelect(effort, choices.efforts, currentEffort, value => value === "none" ? t("pool.qoderReasoningOff") : value);
  poolQoderSelect(context, choices.windows, currentContext, value => `${formatNum(value)} Tokens`);
  $("#pool-qoder-defaults-hint").textContent = choices.incomplete ? t("pool.qoderUnknownModel")
    : !choices.efforts.length || !choices.windows.length ? t("pool.qoderSomeOptionsUnknown") : "";
}

function openPoolModel(model = null) {
  poolState.editId = model?.id || null;
  const form = $("#form-pool-model");
  form.reset();
  for (const name of ["publicId", "name", "description", "modelVersion", "contextWindow", "maxOutputTokens", "sortOrder"]) formField(form, name).value = model?.[name] ?? (name === "sortOrder" ? 0 : "");
  formField(form, "publicId").value = model?.publicId || "";
  for (const name of ["published", "supportsImages", "supportsTools"]) formField(form, name).checked = !!model?.[name];
  $("[data-public-efforts]").innerHTML = poolEffortChecksHtml(model?.reasoningEfforts, false);
  $("#pool-model-title").textContent = t(model?.id ? (model.published ? "pool.editModel" : "pool.editDraft") : "pool.newModel");
  $("#pool-model-error").hidden = true;
  $("#pool-routes").innerHTML = (model?.routes || [{}]).map(poolRouteHtml).join("");
  $("#pool-upstream-options").innerHTML = [...new Set(poolState.discovered.map(m => m.upstreamModel || m.model || m.id).filter(Boolean))].map(id => `<option value="${escapeHtml(id)}"></option>`).join("");
  renderPoolQoderDefaults(model?.defaultReasoningEffort || "", model?.defaultContextWindow || "");
  $("#dlg-pool-model").showModal();
}

function openPoolVerification(model) {
  poolState.verifyId = model.id;
  const form = $("#form-pool-verify");
  form.reset();
  form.verifiedModelVersion.value = model.verifiedModelVersion || model.modelVersion || "";
  const versionUnknown = !String(model.modelVersion || "").trim();
  form.verifiedModelVersion.required = !versionUnknown;
  const versionLabel = $("#pool-verify-version-label");
  versionLabel.dataset.i18n = versionUnknown ? "pool.versionOptional" : "pool.version";
  versionLabel.textContent = t(versionLabel.dataset.i18n);
  const verifyHint = $("#pool-verify-hint");
  verifyHint.dataset.i18n = versionUnknown ? "pool.verifyUnknownVersionHint" : "pool.verifyHint";
  verifyHint.textContent = t(verifyHint.dataset.i18n);
  form.verificationSource.value = model.verificationSource || "";
  $("#pool-verify-efforts").innerHTML = poolEffortChecksHtml(model.reasoningEfforts, false);
  form.supportsImages.checked = model.verificationStatus === "VERIFIED" && !!model.supportsImages;
  form.supportsTools.checked = model.verificationStatus === "VERIFIED" && !!model.supportsTools;
  $("#pool-verify-name").textContent = (POOL_PLATFORMS[model.platform] || model.platform) + " · " + model.upstreamModel;
  $("#pool-verify-error").hidden = true;
  $("#dlg-pool-verify").showModal();
}

async function submitPoolModel(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {};
  for (const name of ["publicId", "name", "description", "modelVersion"]) payload[name] = formField(form, name).value.trim();
  for (const name of ["contextWindow", "maxOutputTokens", "sortOrder"]) payload[name] = formField(form, name).value === "" ? (name === "sortOrder" ? 0 : null) : Number(formField(form, name).value);
  for (const name of ["published", "supportsImages", "supportsTools"]) payload[name] = formField(form, name).checked;
  payload.reasoningEfforts = poolCheckedEfforts(form.querySelector("[data-public-efforts]"));
  const qoderDefaults = $("#pool-qoder-defaults");
  const qoderEffort = formField(form, "defaultReasoningEffort");
  const qoderContext = formField(form, "defaultContextWindow");
  payload.defaultReasoningEffort = qoderDefaults.hidden ? null : qoderEffort.value || null;
  payload.defaultContextWindow = qoderDefaults.hidden || !qoderContext.value ? null : Number(qoderContext.value);
  payload.routes = [...form.querySelectorAll(".pool-route")].map(row => {
    const route = {};
    if (row.dataset.routeId) route.id = row.dataset.routeId;
    row.querySelectorAll("[data-route-field]").forEach(field => {
      if (field.tagName === "DIV") return;
      route[field.dataset.routeField] = field.type === "checkbox" ? field.checked : field.value.trim();
    });
    route.priority = Number(route.priority);
    route.reasoningEfforts = poolCheckedEfforts(row.querySelector('[data-route-field="reasoningEfforts"]'));
    return route;
  });
  const error = $("#pool-model-error");
  error.hidden = true;
  if (!qoderDefaults.hidden && [qoderEffort, qoderContext].some(select => select.selectedOptions[0]?.disabled)) {
    error.textContent = t("pool.qoderUnsupportedDefault"); error.hidden = false; return;
  }
  if (!payload.publicId || /\s/.test(payload.publicId)) { error.textContent = t("pool.invalidId"); error.hidden = false; return; }
  if (payload.published && !payload.routes.some(route => route.enabled)) { error.textContent = t("pool.needRoute"); error.hidden = false; return; }
  const enabledRoutes = payload.routes.filter(route => route.enabled);
  const exactNamedRoutes = enabledRoutes.every(route => payload.publicId === route.upstreamModel);
  if (payload.published && !payload.modelVersion && !exactNamedRoutes) {
    error.textContent = t("pool.unknownVersionRequiresExactRoute"); error.hidden = false; return;
  }
  const missingEfforts = payload.reasoningEfforts.filter(effort =>
    !enabledRoutes.some(route => route.reasoningEfforts.includes(effort)));
  if (payload.published && missingEfforts.length) {
    error.textContent = t("pool.missingRoutesForEfforts", { efforts: missingEfforts.join(", ") });
    error.hidden = false;
    return;
  }
  const button = $("#btn-pool-model-save");
  button.disabled = true;
  try {
    await api(poolState.editId ? `/api/models/${encodeURIComponent(poolState.editId)}` : "/api/models", { method: poolState.editId ? "PUT" : "POST", body: JSON.stringify(payload) });
    $("#dlg-pool-model").close();
    toast(t("pool.saved"), "ok");
    await loadPoolModels();
    setPoolTab(payload.published ? "public" : "drafts");
  } catch (err) { error.textContent = err.message; error.hidden = false; }
  finally { button.disabled = false; }
}

async function prepareKeyModels(key) {
  const generation = ++poolState.keyGeneration;
  poolState.keyReady = false;
  $("#pool-key-mode").disabled = true;
  poolState.keySelection = Array.isArray(key.allowedModels) ? [...key.allowedModels] : null;
  $("#pool-key-mode").value = poolState.keySelection === null ? "all" : "selected";
  $("#pool-key-models").innerHTML = `<div class="hint">${escapeHtml(t("pool.loading"))}</div>`;
  $("#pool-key-error").hidden = true;
  try {
    const models = poolArray(await api("/api/models"));
    if (generation !== poolState.keyGeneration) return;
    poolState.models = models;
    poolState.keyReady = true;
    $("#pool-key-mode").disabled = false;
    renderKeyModels();
  } catch (error) {
    if (generation !== poolState.keyGeneration) return;
    $("#pool-key-error").textContent = error.message;
    $("#pool-key-error").hidden = false;
    $("#pool-key-models").innerHTML = "";
  }
}

function renderKeyModels() {
  const selected = poolState.keySelection || [];
  const choices = poolState.models.filter(model => model.published && !poolIsSelectionMode(model));
  $("#pool-key-models").innerHTML = choices.length ? choices.map(model => {
    const id = poolModelId(model);
    return `<label><input type="checkbox" value="${escapeHtml(id)}" ${selected.includes(id) ? "checked" : ""} /><span>${escapeHtml(model.name || id)} <code>${escapeHtml(id)}</code></span></label>`;
  }).join("") : `<p class="hint">${escapeHtml(t("pool.publicEmpty"))}</p>`;
  $("#pool-key-models").hidden = $("#pool-key-mode").value === "all";
}

function readKeyModels() {
  if (!poolState.keyReady) return undefined;
  return $("#pool-key-mode").value === "all" ? null : [...$("#pool-key-models").querySelectorAll("input:checked")].map(input => input.value);
}

function stopAccountAuthPoll() { clearTimeout(poolState.loginTimer); poolState.loginTimer = null; }
function accountAuthJob(data = poolState.loginJob) { return data?.login || data?.job || data || {}; }
function cancelTraeAuthJob(accountId, jobId) {
  return api(`/api/accounts/${encodeURIComponent(accountId)}/auth/cancel?jobId=${encodeURIComponent(jobId)}`, { method: "POST" });
}
function abandonTraeAuthDialog() {
  const account = poolState.loginAccount;
  if (account?.platform !== "TRAE") return;
  const job = accountAuthJob();
  stopAccountAuthPoll();
  ++poolState.loginGeneration;
  if (["STARTING", "PENDING"].includes(String(job.status || "").toUpperCase()) && job.id) {
    cancelTraeAuthJob(account.id, job.id).catch(error =>
      toast(t("pool.traeCancelFailed", { message: error.message }), "err"));
  }
  // If /login has not returned an id yet, its stale response cancels that exact job.
}
function safeAuthUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}

function renderAccountAuth(data) {
  const job = accountAuthJob(data);
  poolState.loginJob = data;
  const trae = poolState.loginAccount?.platform === "TRAE";
  const claude = poolState.loginAccount?.platform === "CLAUDE";
  const status = String(job.status || "").toUpperCase();
  const complete = data?.authenticated === true || ["SUCCESS", "COMPLETED", "AUTHENTICATED", "SUCCEEDED"].includes(status);
  const terminal = complete || ["FAILED", "ERROR", "CANCELLED", "CANCELED", "EXPIRED"].includes(status);
  // CLAUDE 登录响应直接携带 authorizeUrl（无 jobId 包装）
  const waitingUrl = safeAuthUrl(job.url) || (claude ? safeAuthUrl(job.authorizeUrl) : "");
  const fallback = t(complete ? (trae ? "pool.traeAuthComplete" : "pool.authComplete") : terminal ? "pool.authStopped" : "pool.authWaiting");
  $("#pool-auth-message").textContent = trae && !terminal
    ? t(status === "STARTING" ? "pool.traeAuthStarting" : "pool.traeAuthWaiting")
    : data?.message || job.message || fallback;
  $("#pool-auth-message").classList.toggle("error", terminal && !complete);
  const link = $("#pool-auth-link");
  link.hidden = trae || !waitingUrl || terminal;
  link.href = waitingUrl || "#";
  link.textContent = waitingUrl ? t("pool.openAuth") + " ↗ " + waitingUrl : "";
  $("#pool-auth-code-wrap").hidden = trae || !job.userCode || terminal;
  $("#pool-auth-code").textContent = job.userCode || "";
  $("#btn-pool-auth-cancel").hidden = terminal;
  $("#pool-auth-input-wrap").hidden = trae || terminal;
  $("#btn-pool-auth-retry").hidden = !terminal || complete;
  return { terminal, complete };
}

function renderAccountAuthCopy() {
  const trae = poolState.loginAccount?.platform === "TRAE";
  $("#pool-auth-title").textContent = t(trae ? "pool.traeAuthTitle" : "pool.authTitle", { name: poolState.loginAccount.name });
  $("#pool-auth-hint").textContent = t(trae ? "pool.traeAuthHint" : "pool.authHint",
    { name: poolState.loginAccount.name });
}

async function finishAccountAuth() {
  const account = poolState.loginAccount;
  if (account?.platform === "TRAE") {
    try {
      const refreshed = await refreshOneCredit(account.id, null, account.name);
      if (refreshed?.credentialStatus === "EXPIRED") {
        renderAccountAuth({ status: "EXPIRED", message: t("pool.traeAuthExpired") });
      }
      return;
    } catch (error) {
      toast(error.message, "err");
    }
  }
  await loadAccounts();
}

async function pollAccountAuth(generation) {
  if (generation !== poolState.loginGeneration || !$("#dlg-pool-auth").open) return;
  try {
    const data = await api(`/api/accounts/${encodeURIComponent(poolState.loginAccount.id)}/auth/status`);
    if (generation !== poolState.loginGeneration) return;
    const result = renderAccountAuth(data);
    if (result.complete) { await finishAccountAuth(); return; }
    if (result.terminal) return;
  } catch (error) {
    if (generation !== poolState.loginGeneration) return;
    $("#pool-auth-message").textContent = error.message;
    $("#pool-auth-message").classList.add("error");
    $("#btn-pool-auth-retry").hidden = false;
    return;
  }
  poolState.loginTimer = setTimeout(() => pollAccountAuth(generation), 2000);
}

async function startAccountAuth(account) {
  stopAccountAuthPoll();
  poolState.loginAccount = account;
  const generation = ++poolState.loginGeneration;
  renderAccountAuthCopy();
  $("#pool-auth-input").value = "";
  renderAccountAuth({ status: "STARTING", message: t("pool.authStarting") });
  $("#btn-pool-auth-cancel").disabled = true;
  if (!$("#dlg-pool-auth").open) $("#dlg-pool-auth").showModal();
  try {
    const job = await api(`/api/accounts/${encodeURIComponent(account.id)}/auth/login`, { method: "POST" });
    if (generation !== poolState.loginGeneration) {
      if (account.platform === "TRAE" && job?.id) {
        await cancelTraeAuthJob(account.id, job.id).catch(error =>
          toast(t("pool.traeCancelFailed", { message: error.message }), "err"));
      }
      return;
    }
    const result = renderAccountAuth(job);
    if (result.complete) await finishAccountAuth();
    else if (!result.terminal) poolState.loginTimer = setTimeout(() => pollAccountAuth(generation), 2000);
  } catch (error) {
    if (generation !== poolState.loginGeneration) return;
    renderAccountAuth({ status: "FAILED", message: error.message });
  } finally {
    if (generation === poolState.loginGeneration) $("#btn-pool-auth-cancel").disabled = false;
  }
}

function bindPoolUI() {
  if (typeof bindModelDiagnostics === "function") bindModelDiagnostics();
  $("#btn-pool-model-new").addEventListener("click", () => openPoolModel());
  $("#btn-pool-model-refresh").addEventListener("click", () => loadPoolModels());
  $("#pool-model-search").addEventListener("input", renderPoolModels);
  $("#pool-draft-platform").addEventListener("change", renderPoolModels);
  $("#pool-discovered-platform").addEventListener("change", renderPoolModels);
  $("#pool-drafts-list").addEventListener("change", event => {
    const checkbox = event.target.closest("[data-pool-select-draft]");
    if (!checkbox) return;
    if (checkbox.checked) poolState.batchSelection.add(String(checkbox.value));
    else poolState.batchSelection.delete(String(checkbox.value));
    updatePoolBatchControls();
  });
  $("#pool-select-all-drafts").addEventListener("change", event => {
    for (const checkbox of $("#pool-drafts-list").querySelectorAll("[data-pool-select-draft]")) {
      checkbox.checked = event.target.checked;
      if (checkbox.checked) poolState.batchSelection.add(String(checkbox.value));
      else poolState.batchSelection.delete(String(checkbox.value));
    }
    updatePoolBatchControls();
  });
  $("#btn-pool-batch-publish").addEventListener("click", submitPoolBatchPublish);
  $("#btn-pool-generate-drafts").addEventListener("click", generateMissingDiscoveredDrafts);
  document.querySelectorAll("[data-pool-tab]").forEach(button => button.addEventListener("click", () => setPoolTab(button.dataset.poolTab)));
  $("#btn-pool-model-sync").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    let syncError = null;
    try { await api("/api/models/sync", { method: "POST" }); }
    catch (error) { syncError = error; }
    try {
      const refresh = await loadPoolModels({ suppressAddedToast: true });
      const statuses = poolSyncStatuses().filter(({ status }) => status && status.state !== "never");
      const failed = statuses.filter(({ status }) => status.state === "failed");
      if (syncError || failed.length) {
        const messages = failed.map(({ label, status }) => t("pool.discoverySyncFailed", { platform: label, message: status.error || t("pool.discoveryUnknownReason") }));
        if (syncError) messages.unshift(syncError.message);
        toast(messages.join(" · "), "err");
      } else if (!refresh.statusLoaded || !statuses.length) {
        toast(t("pool.discoveryStatusUnavailable"), "err");
      } else {
        toast(statuses.map(({ label, status }) => t("pool.discoverySyncStats", {
          platform: label, added: poolModelNames(status.added).length,
          removed: poolModelNames(status.removed).length,
          unchanged: Number(status.unchangedCount || 0)
        })).join(" · "), "ok");
      }
    } catch (error) { toast(error.message, "err"); }
    finally { $("#btn-pool-model-sync").disabled = false; }
  });
  setInterval(pollPoolDiscoveryStatus, 60000);
  $("#form-pool-model").addEventListener("submit", submitPoolModel);
  $("#btn-pool-route-add").addEventListener("click", () => {
    $("#pool-routes").insertAdjacentHTML("beforeend", poolRouteHtml({ priority: $("#pool-routes").children.length * 10 }));
    renderPoolQoderDefaults();
  });
  $("#pool-routes").addEventListener("click", event => {
    if (event.target.closest("[data-remove-route]")) {
      event.target.closest(".pool-route").remove();
      renderPoolQoderDefaults();
    }
  });
  $("#pool-routes").addEventListener("change", event => {
    if (event.target.closest("[data-route-field]")) renderPoolQoderDefaults();
  });
  const handleConfiguredModelAction = async event => {
    const button = event.target.closest("[data-pool-act]");
    if (!button) return;
    const model = poolState.models.find(m => String(m.id) === button.closest("[data-model-id]").dataset.modelId);
    if (!model) return;
    if (button.dataset.poolAct === "edit") { openPoolModel(model); return; }
    try {
      if (button.dataset.poolAct === "delete") {
        if (!(await uiConfirm(t(model.published ? "pool.confirmDelete" : "pool.confirmDeleteDraft", { model: poolModelId(model) })))) return;
        await api(`/api/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
      } else {
        await api(`/api/models/${encodeURIComponent(model.id)}`, { method: "PUT", body: JSON.stringify({ ...model, published: !model.published }) });
      }
      await loadPoolModels();
      if (button.dataset.poolAct === "publish") setPoolTab(model.published ? "drafts" : "public");
    } catch (error) { toast(error.message, "err"); }
  };
  $("#pool-public-list").addEventListener("click", handleConfiguredModelAction);
  $("#pool-drafts-list").addEventListener("click", handleConfiguredModelAction);
  $("#form-pool-verify").addEventListener("submit", async event => {
    event.preventDefault();const form = event.currentTarget;
    const button = event.submitter;button.disabled = true;$("#pool-verify-error").hidden = true;
    try {
      await api(`/api/models/discovered/${encodeURIComponent(poolState.verifyId)}`, { method: "PATCH", body: JSON.stringify({ verifiedModelVersion: form.verifiedModelVersion.value.trim(), supportsImages: form.supportsImages.checked, supportsTools: form.supportsTools.checked, reasoningEfforts: poolCheckedEfforts($("#pool-verify-efforts")), verificationSource: form.verificationSource.value.trim() }) });
      $("#dlg-pool-verify").close();await loadPoolModels();
    } catch(error) { $("#pool-verify-error").textContent = error.message;$("#pool-verify-error").hidden = false; }
    finally { button.disabled = false; }
  });
  $("#pool-discovered-list").addEventListener("click", event => {
    const verify = event.target.closest("[data-pool-verify]");
    if(verify) {
      openPoolVerification(poolState.discovered[Number(verify.dataset.poolVerify)]);return;
    }
    const edit = event.target.closest("[data-pool-edit-existing]");
    if (edit) {
      const existing = poolState.models.find(model => String(model.id) === edit.dataset.poolEditExisting);
      if (existing) openPoolModel(existing);
      return;
    }
    const addRoute = event.target.closest("[data-pool-add-route-existing]");
    if (addRoute) {
      const existing = poolState.models.find(model => String(model.id) === addRoute.dataset.poolAddRouteExisting);
      const source = poolState.discovered[Number(addRoute.dataset.poolSourceIndex)];
      if (existing && source) openPoolModel({ ...existing, routes: [...(existing.routes || []), poolDiscoveredBackupRoute(source, existing)] });
      return;
    }
    const button = event.target.closest("[data-pool-import]");
    if (!button) return;
    const source = poolState.discovered[Number(button.dataset.poolImport)];
    const actualModel = source.upstreamModel || source.model || source.id || "";
    const route = poolDiscoveredRoute(source);
    openPoolModel({ publicId: !/[\s/@]/.test(actualModel) ? actualModel : "",
      name: source.name || actualModel, modelVersion: source.modelVersion || "", contextWindow: source.contextWindow, maxOutputTokens: source.maxOutputTokens,
      ...route, routes: [route], published: false });
  });
  $("#pool-key-mode").addEventListener("change", () => { $("#pool-key-models").hidden = $("#pool-key-mode").value === "all"; });
  $("#pool-key-models").addEventListener("change", () => { poolState.keySelection = readKeyModels(); });
  $("#btn-pool-auth-input").addEventListener("click", async event => {
    const input = $("#pool-auth-input");
    if (!input.value.trim()) return;
    event.currentTarget.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(poolState.loginAccount.id)}/auth/input`, { method: "POST", body: JSON.stringify({ text: input.value.trim() }) });
      input.value = "";
      toast(t("pool.authInputSent"), "ok");
      stopAccountAuthPoll();
      pollAccountAuth(poolState.loginGeneration);
    } catch (error) { toast(error.message, "err"); }
    finally { $("#btn-pool-auth-input").disabled = false; }
  });
  $("#btn-pool-auth-retry").addEventListener("click", () => startAccountAuth(poolState.loginAccount));
  $("#btn-pool-auth-cancel").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    const account = poolState.loginAccount;
    const job = accountAuthJob();
    stopAccountAuthPoll();
    const generation = ++poolState.loginGeneration;
    try {
      if (account.platform === "TRAE") {
        if (job.id) await cancelTraeAuthJob(account.id, job.id);
        // With no id yet, the stale /login response cancels its own job.
      } else {
        await api(`/api/accounts/${encodeURIComponent(account.id)}/auth/cancel`, { method: "POST" });
      }
      if (generation === poolState.loginGeneration) {
        renderAccountAuth({ status: "CANCELLED", message: t("pool.authCancelled") });
      }
    }
    catch (error) {
      if (generation === poolState.loginGeneration) {
        $("#pool-auth-message").textContent = error.message;
        $("#btn-pool-auth-retry").hidden = false;
      }
    }
    finally {
      if (generation === poolState.loginGeneration) $("#btn-pool-auth-cancel").disabled = false;
    }
  });
  const authDialog = $("#dlg-pool-auth");
  authDialog.addEventListener("click", event => {
    if (event.target.closest?.("[data-close-dlg]")) abandonTraeAuthDialog();
  }, true);
  authDialog.addEventListener("cancel", abandonTraeAuthDialog);
  authDialog.addEventListener("close", () => {
    if (authDialog.open) return;
    stopAccountAuthPoll();
    ++poolState.loginGeneration;
  });
  $("#btn-pool-code-copy").addEventListener("click", event => copyText($("#pool-auth-code").textContent, event.currentTarget, t("member.copy.done")));
  document.addEventListener("loean:langchange", () => {
    if (state.view === "models") renderPoolModels();
    if ($("#dlg-pool-auth").open) { renderAccountAuthCopy(); renderAccountAuth(poolState.loginJob); }
    if ($("#dlg-key-edit").open && poolState.keyReady) renderKeyModels();
    if ($("#dlg-pool-model").open) {
      $("#pool-model-title").textContent = t(poolState.editId ? (formField($("#form-pool-model"), "published").checked ? "pool.editModel" : "pool.editDraft") : "pool.newModel");
      renderPoolQoderDefaults();
    }
  });
}
