/* Member-owned keys; plaintext is shown once and never saved in browser storage. */
const memberKeysUi = { items: [], rootKeyId: null, maxKeys: 20, epoch: 0, busy: false, concurrency: null };
function memberKeyLabel(key) { return `${key.name} · ${key.identifier || key.keyPrefix || ""}`; }
function memberKeyStatus(key) {
  return t(key.revoked ? "keymgmt.revoked" : key.expired ? "keymgmt.expired" : !key.enabled ? "keymgmt.paused" : !key.usable ? "keymgmt.unavailable" : "keymgmt.active");
}
function memberKeyError(message = "") { const node = $("#member-keys-error"); if (node) { node.textContent = message; node.hidden = !message; } }
function renderMemberKeys() {
  const selector = $("#member-active-key");
  selector.innerHTML = memberKeysUi.items.filter(key => !key.revoked || key.id === memberState.activeKeyId).map(key => `<option value="${escapeHtml(key.id)}">${escapeHtml(memberKeyLabel(key))}${key.usable ? "" : " · " + escapeHtml(memberKeyStatus(key))}</option>`).join("");
  selector.value = memberState.activeKeyId || "";
  const usage = $("#member-usage-key-filter");
  if (usage) {
    usage.innerHTML = `<option value="">${escapeHtml(t("keymgmt.allKeys"))}</option>` + memberKeysUi.items.map(key => `<option value="${escapeHtml(key.id)}">${escapeHtml(memberKeyLabel(key))}</option>`).join("");
    usage.value = memberState.usageKeyId || "";
  }
  const concurrency = memberKeysUi.concurrency;
  $("#member-concurrency-summary").textContent = concurrency ? t("keymgmt.concurrencySummary", {
    limit: concurrency.effective === 0 ? t("budget.unlimited") : concurrency.effective,
    active: concurrency.active, waiting: concurrency.waiting }) : t("keymgmt.selectionHint");
  const showRevoked = $("#member-show-revoked").checked;
  const visible = memberKeysUi.items.filter(key => showRevoked || !key.revoked);
  $("#member-keys-list").innerHTML = visible.length ? visible.map(key => `<tr data-member-key-id="${escapeHtml(key.id)}">
    <td><strong>${escapeHtml(key.name)}</strong><div class="key-ui-note">${escapeHtml(key.identifier || "—")}</div>${key.isRoot ? `<div class="key-ui-note">${escapeHtml(t("keymgmt.rootKey"))}</div>` : ""}</td>
    <td><span class="member-key-list-state">${escapeHtml(memberKeyStatus(key))}</span></td>
    <td>${escapeHtml(key.allowedModels == null ? t("keymgmt.inheritedModels") : t("keymgmt.modelCount", { count: key.allowedModels.length }))}<div class="key-ui-note">${escapeHtml(key.rateLimitPerMinute == null || key.rateLimitPerMinute <= 0 ? t("budget.unlimited") : t("keymgmt.rpmValue", { count: key.rateLimitPerMinute }))}</div><div class="key-ui-note">${escapeHtml(key.expiresAt ? formatTime(key.expiresAt) : t("keymgmt.noExpiry"))}</div></td>
    <td><div class="member-key-list-actions"><button type="button" data-member-key-action="usage">${escapeHtml(t("keymgmt.usage"))}</button><button type="button" data-member-key-action="budget">${escapeHtml(t("keymgmt.budget"))}</button>
      ${!key.isRoot && !key.revoked ? `<button type="button" data-member-key-action="edit">${escapeHtml(t("keymgmt.edit"))}</button><button type="button" data-member-key-action="toggle">${escapeHtml(t(key.enabled ? "keymgmt.pause" : "keymgmt.enable"))}</button><button type="button" data-member-key-action="rotate">${escapeHtml(t("keymgmt.rotate"))}</button><button type="button" data-member-key-action="revoke">${escapeHtml(t("keymgmt.revoke"))}</button>` : ""}</div></td></tr>`).join("")
    : `<tr><td colspan="4">${escapeHtml(t("keymgmt.empty"))}</td></tr>`;
  const count = memberKeysUi.items.filter(key => !key.revoked).length;
  $("#member-keys-count").textContent = t("keymgmt.count", { count, max: memberKeysUi.maxKeys });
  $("#member-key-new").disabled = memberKeysUi.busy || !memberKeysUi.rootKeyId || count >= memberKeysUi.maxKeys;
}
async function loadMemberKeyManagement() {
  const epoch = ++memberKeysUi.epoch;
  const [data, concurrency] = await Promise.all([memberApi("/api/member/keys"), memberApi("/api/member/concurrency").catch(() => null)]);
  if (epoch !== memberKeysUi.epoch || !memberState.session) return;
  memberKeysUi.items = data.items || []; memberKeysUi.rootKeyId = data.rootKeyId; memberKeysUi.maxKeys = data.maxKeys || 20;
  memberKeysUi.concurrency = concurrency;
  if (!memberState.activeKeyId)
    memberState.activeKeyId = data.rootKeyId || memberKeysUi.items.find(key => key.usable)?.id || memberKeysUi.items.find(key => !key.revoked)?.id || "";
  renderMemberKeys(); memberKeyError();
}
function clearMemberKeyManagement() {
  memberKeysUi.epoch++; memberKeysUi.items = []; memberKeysUi.rootKeyId = null; memberKeysUi.concurrency = null;
  memberState.activeKeyId = ""; memberState.usageKeyId = ""; memberState.keySelectionVersion++;
  $("#member-key-editor")?.close(); $("#member-key-secret-dialog")?.close(); window.keyBudgetUi?.close();
  if ($("#member-keys-list")) $("#member-keys-list").innerHTML = "";
}
function memberKeyLocalDate(value) {
  if (!value) return "";
  const date = new Date(value); if (Number.isNaN(date.getTime())) return "";
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function openMemberKeyEditor(key = null) {
  if (memberKeysUi.busy) return;
  const form = $("#member-key-form"); form.reset(); form.dataset.keyId = key?.id || "";
  form.elements.namedItem("name").value = key?.name || "";
  form.elements.namedItem("models").value = (key?.requestedAllowedModels || []).join("\n");
  form.elements.namedItem("allowedIps").value = key?.requestedAllowedIps || "";
  form.elements.namedItem("rateLimitPerMinute").value = key?.requestedRateLimitPerMinute ?? "";
  form.elements.namedItem("expiresAt").value = memberKeyLocalDate(key?.requestedExpiresAt);
  $("#member-key-editor-title").textContent = t(key ? "keymgmt.editTitle" : "keymgmt.createTitle");
  $("#member-key-editor-error").hidden = true; $("#member-key-editor").showModal();
}
function showMemberKeySecret(result) {
  $("#member-new-key-name").textContent = result.key?.name || "Key";
  $("#member-new-key-plaintext").value = result.plaintext || "";
  $("#member-key-secret-dialog").showModal();
}
function scopedMemberKeyPath(path) {
  const [pathname, search = ""] = path.split("?", 2);
  if (!["/api/member/key", "/api/member/models", "/api/member/connect", "/api/member/usage"].includes(pathname)) return path;
  const keyId = pathname === "/api/member/usage" ? memberState.usageKeyId : memberState.activeKeyId;
  const params = new URLSearchParams(search);
  if (keyId && !params.has("keyId")) params.set("keyId", keyId);
  return pathname + (params.size ? "?" + params : "");
}
function bindMemberKeyManagement() {
  const bar = document.createElement("section"); bar.className = "member-key-selector";
  bar.innerHTML = `<label>${escapeHtml(t("keymgmt.currentKey"))}<select id="member-active-key"></select></label><p class="key-ui-note" id="member-concurrency-summary">${escapeHtml(t("keymgmt.selectionHint"))}</p>`;
  $(".member-main").prepend(bar);
  const legacy = $("#member-view-key .member-key-grid"); if (legacy) legacy.hidden = true;
  const panel = document.createElement("article"); panel.className = "member-panel";
  panel.innerHTML = `<div class="member-key-list-head"><div><h2>${escapeHtml(t("keymgmt.myKeys"))}</h2><p class="key-ui-note" id="member-keys-count"></p></div><div class="key-ui-actions"><button id="member-keys-refresh" type="button">${escapeHtml(t("member.refresh"))}</button><button id="member-key-new" type="button">${escapeHtml(t("keymgmt.create"))}</button></div></div>
    <p class="key-ui-note">${escapeHtml(t("keymgmt.sharedWallet"))}</p><p class="key-ui-note">${escapeHtml(t("keymgmt.rootHint"))}</p>
    <label class="key-ui-note"><input type="checkbox" id="member-show-revoked" /> ${escapeHtml(t("keymgmt.showRevoked"))}</label><p id="member-keys-error" class="key-ui-error" hidden role="alert"></p>
    <div class="key-ui-table-wrap"><table class="key-ui-table"><thead><tr><th>${escapeHtml(t("keymgmt.name"))}</th><th>${escapeHtml(t("keymgmt.state"))}</th><th>${escapeHtml(t("keymgmt.constraints"))}</th><th>${escapeHtml(t("keymgmt.actions"))}</th></tr></thead><tbody id="member-keys-list"></tbody></table></div>`;
  $("#member-view-key").append(panel);
  const usageLabel = document.createElement("label"); usageLabel.className = "member-key-selector";
  usageLabel.innerHTML = `${escapeHtml(t("keymgmt.usageFilter"))}<select id="member-usage-key-filter"></select>`;
  $("#member-view-usage .member-page-head").after(usageLabel);
  const editor = document.createElement("dialog"); editor.id = "member-key-editor"; editor.className = "member-key-editor";
  editor.innerHTML = `<form id="member-key-form"><h3 id="member-key-editor-title"></h3><label>${escapeHtml(t("keymgmt.name"))}<input name="name" required maxlength="64" /></label>
    <label>${escapeHtml(t("keymgmt.models"))}<textarea name="models" rows="3" maxlength="4096"></textarea></label><p class="key-ui-note">${escapeHtml(t("keymgmt.modelsHint"))}</p>
    <label>${escapeHtml(t("keymgmt.ips"))}<input name="allowedIps" maxlength="500" /></label><label>${escapeHtml(t("keymgmt.rpm"))}<input name="rateLimitPerMinute" type="number" min="1" max="2147483647" /></label>
    <label>${escapeHtml(t("keymgmt.expires"))}<input name="expiresAt" type="datetime-local" /></label><p class="key-ui-note">${escapeHtml(t("keymgmt.inheritHint"))}</p>
    <p id="member-key-editor-error" class="key-ui-error" role="alert" hidden></p><div class="key-ui-actions"><button type="button" data-key-editor-close>${escapeHtml(t("keymgmt.cancel"))}</button><button type="submit" id="member-key-save">${escapeHtml(t("keymgmt.save"))}</button></div></form>`;
  document.body.append(editor);
  const secret = document.createElement("dialog"); secret.id = "member-key-secret-dialog"; secret.className = "member-key-editor";
  secret.innerHTML = `<h3>${escapeHtml(t("keymgmt.secretTitle"))}</h3><p id="member-new-key-name"></p><p class="key-ui-note">${escapeHtml(t("keymgmt.secretHint"))}</p><input id="member-new-key-plaintext" class="member-key-secret" readonly autocomplete="off" spellcheck="false" aria-label="API Key" /><div class="key-ui-actions"><button type="button" id="member-new-key-copy">${escapeHtml(t("keymgmt.copy"))}</button><button type="button" id="member-new-key-close">${escapeHtml(t("keymgmt.saved"))}</button></div>`;
  document.body.append(secret);
  editor.querySelector("[data-key-editor-close]").addEventListener("click", () => editor.close());
  secret.addEventListener("close", () => { $("#member-new-key-plaintext").value = ""; });
  $("#member-new-key-close").addEventListener("click", () => secret.close());
  $("#member-new-key-copy").addEventListener("click", event => copyText($("#member-new-key-plaintext").value, event.currentTarget));
  $("#member-key-new").addEventListener("click", () => openMemberKeyEditor());
  $("#member-show-revoked").addEventListener("change", renderMemberKeys);
  $("#member-keys-refresh").addEventListener("click", () => loadMemberKeyManagement().catch(error => memberKeyError(error.message)));
  $("#member-active-key").addEventListener("change", () => {
    if (memberState.playground.busy) { $("#member-active-key").value = memberState.activeKeyId; showToast(t("keymgmt.waitCall")); return; }
    memberState.activeKeyId = $("#member-active-key").value; memberState.keySelectionVersion++;
    memberState.models = null; memberState.connect = null; memberState.key = null;
    memberState.playground = { model:"",messages:[],busy:false,meta:null,sessionId:"" };
    setMemberView(memberState.view);
  });
  $("#member-usage-key-filter").addEventListener("change", () => { memberState.usageKeyId = $("#member-usage-key-filter").value; loadUsage(0).catch(error => showToast(error.message)); });
  $("#member-key-form").addEventListener("submit", saveMemberSelfKey);
  $("#member-keys-list").addEventListener("click", handleMemberKeyAction);
  document.addEventListener("loean:langchange", () => { if (memberState.session) renderMemberKeys(); });
}
async function saveMemberSelfKey(event) {
  event.preventDefault(); if (memberKeysUi.busy) return;
  const form = event.currentTarget, id = form.dataset.keyId, session = memberState.session;
  const value = name => form.elements.namedItem(name).value.trim();
  const expires = value("expiresAt");
  const body = { name:value("name"), allowedModels:value("models") ? value("models").split(/[\s,，]+/).filter(Boolean) : null,
    allowedIps:value("allowedIps") || null, rateLimitPerMinute:value("rateLimitPerMinute") ? Number(value("rateLimitPerMinute")) : null,
    expiresAt:expires ? new Date(expires).toISOString() : null };
  memberKeysUi.busy = true; $("#member-key-save").disabled = true;
  try {
    const result = await memberApi("/api/member/keys" + (id ? "/" + encodeURIComponent(id) : ""), {method:id ? "PATCH" : "POST",body:JSON.stringify(body)});
    if (!session || session !== memberState.session) return;
    $("#member-key-editor").close(); if (!id) showMemberKeySecret(result);
    memberState.models = null; memberState.connect = null; memberState.key = null;
    await loadMemberKeyManagement();
  } catch (error) { const node=$("#member-key-editor-error");node.textContent=error.message;node.hidden=false; }
  finally { memberKeysUi.busy=false;$("#member-key-save").disabled=false;renderMemberKeys(); }
}
async function handleMemberKeyAction(event) {
  const button = event.target.closest("[data-member-key-action]"); if (!button || memberKeysUi.busy) return;
  const id = button.closest("[data-member-key-id]").dataset.memberKeyId;
  const key = memberKeysUi.items.find(item => item.id === id); if (!key) return;
  const action = button.dataset.memberKeyAction;
  if (action === "usage") { memberState.usageKeyId=id;$("#member-usage-key-filter").value=id;setMemberView("usage");return; }
  if (action === "budget") { window.keyBudgetUi.open({name:key.name,mode:"member",api:memberApi,path:"/api/member/keys/"+encodeURIComponent(id)+"/budget"});return; }
  if (action === "edit") { openMemberKeyEditor(key); return; }
  if (key.isRoot || key.revoked) return;
  if (["rotate","revoke"].includes(action) && !await uiConfirm(t("keymgmt.confirm." + action, {name:key.name}), {danger:true})) return;
  const session=memberState.session; memberKeysUi.busy=true; memberKeyError();
  try {
    const endpoint="/api/member/keys/"+encodeURIComponent(id);
    if (action === "rotate") { const result=await memberApi(endpoint+"/rotate",{method:"POST"});if(session&&session===memberState.session)showMemberKeySecret(result); }
    else if (action === "revoke") await memberApi(endpoint,{method:"DELETE"});
    else if (action === "toggle") await memberApi(endpoint,{method:"PATCH",body:JSON.stringify({enabled:!key.enabled})});
    memberState.models = null; memberState.connect = null; memberState.key = null;
    if (session === memberState.session) await loadMemberKeyManagement();
  } catch(error) { memberKeyError(error.message); }
  finally { memberKeysUi.busy=false;renderMemberKeys(); }
}
