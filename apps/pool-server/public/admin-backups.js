/* Read-only operational status, restricted to the administrator surface. */
let adminBackupStatus = null;
function renderAdminBackupStatus(snapshot = adminBackupStatus) {
  adminBackupStatus = snapshot;
  const target = $("#overview-backup-status");
  if (!target) return;
  if (!snapshot) { target.textContent = t("backup.unavailable"); return; }
  const stateKey = ["NEVER_RUN", "DISABLED", "RUNNING", "SUCCESS", "PARTIAL", "FAILED"].includes(snapshot.state) ? snapshot.state : "NEVER_RUN";
  target.classList.toggle("error", ["PARTIAL", "FAILED"].includes(stateKey));
  target.innerHTML = `<strong>${escapeHtml(t("backup.state." + stateKey))}</strong><p class="hint">${escapeHtml(t("backup.lastSuccess", {
    time: snapshot.lastSuccessfulAt ? formatTime(snapshot.lastSuccessfulAt) : "—" }))}</p>`
    + (snapshot.credentials || []).map(item => `<div class="pool-meta">${escapeHtml(item.directory)} · ${escapeHtml(t("backup.archive." + item.state))}
      · ${escapeHtml(t("backup.files", { count: item.archivedFiles ?? 0, skipped: item.skippedFiles ?? 0 }))}</div>`).join("")
    + ((snapshot.issues || []).length ? `<p class="hint">${escapeHtml(t("backup.issues", { count: snapshot.issues.length }))}</p>` : "");
}
async function refreshAdminBackupStatus() {
  try { renderAdminBackupStatus(await api("/api/backups/status")); }
  catch { renderAdminBackupStatus(null); }
}
function bindAdminBackupStatus() {
  $("#overview-backup-refresh")?.addEventListener("click", refreshAdminBackupStatus);
  document.addEventListener("loean:langchange", () => renderAdminBackupStatus());
}
