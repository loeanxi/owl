import { useId, useState } from "react";
import type { MailAccount, MailDraft } from "../../../../../packages/coding-agent/src/core/mail/types.ts";
import { ChatStream } from "../../components/ChatStream.tsx";
import { useT } from "../../i18n/index.ts";
import { mailThreadKey } from "./mail-model.ts";
import type { MailSource, useMailAgent } from "./useMailAgent.ts";

export function MailAgentPanel({ agent, accounts, connected, draftBusy, onClose, onAsk, onUseCurrent, onSource, onSave, onPreview, onAuthorize, onStop }: {
	agent: ReturnType<typeof useMailAgent>;
	accounts: MailAccount[];
	connected: boolean;
	draftBusy: "save" | "preview" | undefined;
	onClose: () => void;
	onAsk: (prompt: string) => Promise<void>;
	onUseCurrent?: () => void;
	onSource: (source: MailSource) => void;
	onSave: (draft: MailDraft) => void;
	onPreview: (draft: MailDraft) => void;
	onAuthorize: (account: MailAccount) => void;
	onStop: () => void;
}): React.JSX.Element {
	const t = useT();
	const [prompt, setPrompt] = useState("");
	const formId = useId();
	const active = agent.active;
	const draft = active?.draft;
	const sender = draft ? accounts.find((account) => account.id === draft.accountId) : undefined;
	const senderEmail = sender?.email ?? active?.accounts.find((account) => account.id === draft?.accountId)?.email ?? "";
	const draftLocked = Boolean(draftBusy);
	const busy = agent.submitting || active?.running;
	const submit = async (): Promise<void> => {
		const value = prompt.trim();
		if (!value || busy || !connected) return;
		setPrompt("");
		try { await onAsk(value); }
		catch { setPrompt((current) => current || value); }
	};
	return <aside className="owl-mail-agent" aria-label={t("mail.openAgent")}>
		<div className="owl-mail-agent-heading"><span className="owl-mail-agent-mark" aria-hidden="true">✦</span><h2>{t("mail.viewAgent")}</h2><button type="button" className="owl-mail-icon-button" onClick={onClose} aria-label={t("mail.closeAgent")}>×</button></div>
		{agent.sessions.length > 0 && <label className="owl-mail-conversation-picker"><span>{t("mail.conversations")}</span><select value={active?.id ?? ""} onChange={(event) => agent.select(event.target.value)} disabled={agent.submitting || draftLocked}>{agent.sessions.map((session, index) => <option value={session.id} key={session.id}>{t("mail.conversation", { n: index + 1 })} · {session.sources[0]?.subject || session.accounts.map((account) => account.label || account.email).join(", ")}</option>)}</select></label>}
		{active && <div className="owl-mail-agent-context">
			<div className="owl-mail-eyebrow">{t("mail.agentContext")}</div>
			<strong>{active.context.mode === "threads" ? t("mail.contextThreads", { threads: active.context.threads?.length ?? 0, accounts: active.context.accountIds.length }) : t("mail.contextAccounts", { accounts: active.context.accountIds.length })}</strong>
			<div className="owl-mail-source-accounts">{active.accounts.map((account) => <span key={account.id} title={account.email}>{account.email}</span>)}</div>
			{active.sources.length > 0 && <details><summary>{t("mail.source")} ({active.sources.length})</summary><div className="owl-mail-sources">{active.sources.map((source) => <button type="button" className="owl-mail-source" key={mailThreadKey(source)} onClick={() => onSource(source)}><span>{active.accounts.find((account) => account.id === source.accountId)?.label}</span>{source.subject || t("mail.noSubject")}</button>)}</div></details>}
			<p>{t("mail.contextFixed")}</p>
			{active.excluded.length > 0 && <p className="owl-mail-warning">{t("mail.excludedAccounts", { accounts: active.excluded.join(", ") })}</p>}
			{onUseCurrent && <button type="button" className="owl-mail-link-button" disabled={busy || !connected || draftLocked} onClick={onUseCurrent}>{t("mail.useCurrentMail")}</button>}
		</div>}
		<div className="owl-mail-agent-content">
			{!active?.entries.length ? <div className="owl-mail-agent-empty"><span className="owl-mail-agent-empty-mark" aria-hidden="true">✦</span><h3>{t("mail.agentIntro")}</h3><p>{t("mail.agentIntroHint")}</p>{["mail.promptSummary", "mail.promptTasks", "mail.promptReply"].map((key, index) => <button type="button" className="owl-mail-button" key={key} onClick={() => void onAsk(t(key as "mail.promptSummary" | "mail.promptTasks" | "mail.promptReply")).catch(() => {})} disabled={busy || !connected}>{t((["mail.summarize", "mail.tasks", "mail.reply"] as const)[index])}<span aria-hidden="true">→</span></button>)}</div> : <ChatStream entries={active.entries} activity={!connected ? "disconnected" : active.running || agent.submitting ? "working" : "idle"} />}
			{active?.error && <p role="alert" className="owl-mail-error">{active.error}</p>}
		</div>
		{draft && <details open className="owl-mail-draft" key={`${active.id}-${draft.threadId ?? ""}`}>
			<summary>{t("mail.draft")} <span>{senderEmail}</span></summary>
			<div className="owl-mail-draft-scroll">
				<div className="owl-mail-draft-from"><span>{t("mail.from")}</span><strong>{senderEmail}</strong><p>{t("mail.draftSenderFixed")}</p></div>
				{(["to", "cc", "bcc", "subject"] as const).map((field) => <label key={field} className="owl-mail-draft-field"><span>{t(`mail.${field}`)}</span><input type="text" value={draft[field] ?? ""} disabled={draftLocked} onChange={(event) => agent.editDraft(field, event.target.value)} /></label>)}
				<label className="owl-mail-body-label"><span className="sr-only">{t("mail.body")}</span><textarea className="owl-mail-draft-body" value={draft.body} disabled={draftLocked} onChange={(event) => agent.editDraft("body", event.target.value)} /></label>
				{active.pendingDraft && <div className="owl-mail-draft-notice"><p>{t("mail.newDraft")}</p><button type="button" className="owl-mail-link-button" disabled={draftLocked} onClick={agent.adoptDraft}>{t("mail.adoptDraft")}</button></div>}
				{sender?.status !== "connected" ? <p className="owl-mail-draft-notice">{t("mail.draftRetained")}</p> : !sender.capabilities.compose || !sender.capabilities.send ? <div className="owl-mail-draft-notice"><p>{t("mail.permissionHint", { email: senderEmail })}</p><button type="button" className="owl-mail-link-button" onClick={() => onAuthorize(sender)} disabled={draftLocked || !connected}>{t("mail.enableSend")}</button></div> : null}
			</div>
			<div className="owl-mail-draft-actions"><button type="button" className="owl-mail-button" onClick={() => onSave(draft)} disabled={draftLocked || !connected || !sender}>{t(draftBusy === "save" ? "mail.saving" : "mail.saveDraft")}</button><button type="button" className="owl-mail-button is-primary" onClick={() => onPreview(draft)} disabled={draftLocked || !connected || !sender || !draft.to.trim() || !draft.body.trim()}>{t(draftBusy === "preview" ? "mail.preparing" : "mail.previewSend")}</button></div>
		</details>}
		<form className="owl-mail-agent-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
			<label className="sr-only" htmlFor={formId}>{t("mail.agentPlaceholder")}</label><textarea id={formId} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("mail.agentPlaceholder")} disabled={!connected || agent.submitting} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
			<div className="owl-mail-composer-actions"><span>{t("mail.contextFixed")}</span>{active?.running ? <button type="button" className="owl-mail-button" onClick={onStop} disabled={!connected}>{t("mail.stop")}</button> : <button type="submit" className="owl-mail-send-prompt" aria-label={t("mail.ask")} disabled={busy || !connected || !prompt.trim()}>↑</button>}</div>
		</form>
	</aside>;
}
