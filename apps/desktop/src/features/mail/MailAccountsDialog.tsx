import { useState } from "react";
import type { MailAccount } from "../../../../../packages/coding-agent/src/core/mail/types.ts";
import { useT } from "../../i18n/index.ts";
import { MailDialog } from "./MailDialog.tsx";

export function MailAccountsDialog({ accounts, busy, connected, onClose, onAdd, onRename, onReconnect, onDisconnect }: {
	accounts: MailAccount[];
	busy: boolean;
	connected: boolean;
	onClose: () => void;
	onAdd: () => void;
	onRename: (account: MailAccount, label: string) => void;
	onReconnect: (account: MailAccount) => void;
	onDisconnect: (account: MailAccount) => void;
}): React.JSX.Element {
	const t = useT();
	const [labels, setLabels] = useState<Record<string, string>>({});
	return <MailDialog title={t("mail.manageAccounts")} onClose={onClose} busy={busy}>
		<div className="owl-mail-manage-accounts">{accounts.map((account) => <div className="owl-mail-manage-account" key={account.id}>
			<div className="owl-mail-manage-heading"><span className="owl-mail-account-avatar" aria-hidden="true">{(account.label || account.email).slice(0, 1)}</span><div><strong>{account.email}</strong><small className={account.status === "connected" ? "" : "owl-mail-warning"}>{t(`mail.${account.status}`)} · {t(account.capabilities.send ? "mail.canSend" : "mail.readOnly")}</small></div></div>
			<label className="owl-mail-rename"><span className="sr-only">{t("mail.accountLabel")} · {account.email}</span><input value={labels[account.id] ?? account.label} maxLength={60} onChange={(event) => setLabels((current) => ({ ...current, [account.id]: event.target.value }))} disabled={busy} /><button type="button" className="owl-mail-button" disabled={busy || !connected || !(labels[account.id] ?? account.label).trim() || (labels[account.id] ?? account.label).trim() === account.label} onClick={() => onRename(account, (labels[account.id] ?? account.label).trim())}>{t("mail.rename")}</button></label>
			<div className="owl-mail-manage-actions"><button type="button" className="owl-mail-link-button" onClick={() => onReconnect(account)} disabled={busy || !connected}>{t("mail.reconnect")}</button><button type="button" className="owl-mail-link-button is-danger" onClick={() => onDisconnect(account)} disabled={busy || !connected}>{t("mail.disconnect")}</button></div>
		</div>)}</div>
		<div className="owl-mail-dialog-actions"><button type="button" className="owl-mail-button" onClick={onAdd} disabled={busy || !connected}>+ {t("mail.addAccount")}</button><button type="button" className="owl-mail-button is-primary" onClick={onClose} disabled={busy}>{t("mail.done")}</button></div>
	</MailDialog>;
}
