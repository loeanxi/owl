import type {
	MailAccount,
	MailAuthStart,
	MailPermission,
	MailSettings,
} from "../../../../../packages/coding-agent/src/core/mail/types.ts";
import { useT } from "../../i18n/index.ts";
import { MailDialog } from "./MailDialog.tsx";

export function MailConnectionDialog({
	settings,
	target,
	permission,
	pending,
	busy,
	error,
	onClose,
	onFile,
	onStart,
	onOpen,
	onConsole,
}: {
	settings?: MailSettings;
	target?: MailAccount;
	permission: MailPermission;
	pending?: MailAuthStart;
	busy: boolean;
	error?: string;
	onClose: () => void;
	onFile: (file: File) => void;
	onStart: () => void;
	onOpen: () => void;
	onConsole: () => void;
}): React.JSX.Element {
	const t = useT();
	return (
		<MailDialog
			title={permission === "send" ? t("mail.enableSend") : t("mail.connectTitle")}
			onClose={onClose}
			busy={busy}
		>
			<ol className="owl-mail-connect-steps">
				<li className={!settings?.configured ? "is-active" : ""}>
					<span>1</span>
					{t("mail.configureStep")}
				</li>
				<li className={settings?.configured ? "is-active" : ""}>
					<span>2</span>
					{t("mail.authorizeStep")}
				</li>
			</ol>
			{pending ? (
				<div className="owl-mail-auth-waiting">
					<span className="owl-mail-spinner" aria-hidden="true" />
					<h3>{t("mail.authWaiting")}</h3>
					<p>{t("mail.authWaitingHint")}</p>
					<button type="button" className="owl-mail-button" onClick={onOpen} disabled={busy}>
						{t("mail.openAuth")}
					</button>
				</div>
			) : (
				<>
					{!settings?.configured && (
						<>
							<p>{t("mail.configureHint")}</p>
							<button type="button" className="owl-mail-link-button" onClick={onConsole}>
								{t("mail.googleConsole")} ↗
							</button>
						</>
					)}
					{settings?.configured && (
						<div className="owl-mail-dialog-callout">
							<strong>{t("mail.clientConfigured")}</strong>
						</div>
					)}
					<label className="owl-mail-client-file">
						<span>{t(settings?.configured ? "mail.replaceClient" : "mail.chooseClient")}</span>
						<input
							type="file"
							accept=".json,application/json"
							disabled={busy}
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (file) onFile(file);
								event.target.value = "";
							}}
						/>
					</label>
					<p className="owl-mail-small-print">{t("mail.clientPrivacy")}</p>
					<div className="owl-mail-dialog-callout">
						{t(permission === "send" ? "mail.authSendHint" : "mail.authReadHint", { email: target?.email ?? "" })}
					</div>
					{permission === "read" && <p className="owl-mail-small-print">{t("mail.onboardPermission")}</p>}
				</>
			)}
			{error && (
				<p className="owl-mail-error" role="alert">
					{error}
				</p>
			)}
			<div className="owl-mail-dialog-actions">
				<button type="button" className="owl-mail-button" onClick={onClose} disabled={busy}>
					{t("mail.cancel")}
				</button>
				{!pending && (
					<button
						type="button"
						className="owl-mail-button is-primary"
						onClick={onStart}
						disabled={busy || !settings?.configured}
					>
						{t(busy ? "mail.busy" : "mail.connectGoogle")}
					</button>
				)}
			</div>
		</MailDialog>
	);
}
