import type { BridgeClient } from "../../bridge/client.ts";
import { useT } from "../../i18n/index.ts";

export interface MailPageProps {
	client: BridgeClient;
	connected: boolean;
	cwd: string;
	sidebarCollapsed?: boolean;
	onUnreadChange?: (count: number) => void;
}

export function MailPage(_props: MailPageProps): React.JSX.Element {
	const t = useT();
	return <main className="owl-main-frame" aria-label={t("mail.title")}><p role="status">{t("mail.loading")}</p></main>;
}
