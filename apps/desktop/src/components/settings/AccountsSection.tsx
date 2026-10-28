/**
 * 设置页「账号」分区：应用用户账号（一个账号一份 agentDir 数据空间）。
 * 切换 = 桥写注册表 + 壳重启桥进程（switchAccountBridge），完成后整页 reload
 * 重连新桥；数据目录不同，会话 / 设置 / 模型凭据随之隔离。
 */

import { useCallback, useEffect, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import { switchAccountBridge } from "../../bridge/native.ts";
import type { DesktopAccountInfo } from "../../bridge/protocol.ts";
import { useT } from "../../i18n/index.ts";
import { SectionHeader, SettingRow } from "./settings-widgets.tsx";

interface AccountListResult {
	accounts: DesktopAccountInfo[];
	account: DesktopAccountInfo | null;
	nextId: string;
	runningId: string | null;
}

/** 短路径展示：用户目录折叠成 ~，一眼能看出账号目录差异。 */
function shortPath(path: string): string {
	return path.replace(/^([A-Za-z]:)?[\\/](Users|home)[\\/][^\\/]+/, "~");
}

export function AccountsSection({ client }: { client: BridgeClient }): React.JSX.Element {
	const t = useT();
	const [status, setStatus] = useState<AccountListResult | null>(null);
	const [newName, setNewName] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [passwordFor, setPasswordFor] = useState<DesktopAccountInfo | null>(null);
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		const response = await client.request<AccountListResult>({ type: "account.list" });
		if (response.ok && response.result) setStatus(response.result);
		else setError(response.error ?? t("common.operationFailed"));
	}, [client, t]);

	useEffect(() => {
		void load();
	}, [load]);

	const create = async () => {
		if (!newName.trim() || busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await client.request({
				type: "account.create",
				name: newName.trim(),
				...(newPassword ? { password: newPassword } : {}),
			});
			if (!response.ok) setError(response.error ?? t("common.operationFailed"));
			else {
				setNewName("");
				setNewPassword("");
			}
			await load();
		} finally {
			setBusy(false);
		}
	};

	/** 切换：注册表落盘 → 壳重启桥（新 OWL_CODING_AGENT_DIR）→ reload 重连。 */
	const doSwitch = async (account: DesktopAccountInfo, pwd?: string) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await client.request({
				type: "account.switch",
				accountId: account.id,
				...(pwd ? { password: pwd } : {}),
			});
			if (!response.ok) {
				setError(response.error ?? t("common.operationFailed"));
				return;
			}
			setPasswordFor(null);
			setPassword("");
			await switchAccountBridge(account.dataDir);
			window.location.reload();
		} catch (switchError) {
			// 注册表已切但桥没起来：下次启动应用仍会落新账号目录
			setError(t("settings.accounts.restartFailed", { error: String(switchError) }));
		} finally {
			setBusy(false);
		}
	};

	const onSwitchClick = (account: DesktopAccountInfo) => {
		// 有密码的账号先让桥校验密码（account.switch 带 password），免密的直接切
		if (account.hasPassword) {
			setPasswordFor(account);
			setPassword("");
			return;
		}
		void doSwitch(account);
	};

	return (
		<>
			<SectionHeader title={t("settings.accounts.title")} desc={t("settings.accounts.desc")} />
			{error && <p className="text-xs text-red-400">{error}</p>}
			{(status?.accounts ?? []).map((account) => {
				const running = status?.runningId === account.id;
				return (
					<SettingRow
						key={account.id}
						title={`${account.name}${running ? ` · ${t("settings.accounts.currentTag")}` : ""}`}
						desc={shortPath(account.dataDir)}
					>
						{running ? (
							<span className="text-xs text-owl-muted">{t("settings.accounts.inUse")}</span>
						) : (
							<button
								type="button"
								className="owl-settings-input px-3 py-1 text-xs"
								disabled={busy}
								onClick={() => onSwitchClick(account)}
							>
								{t("settings.accounts.switchTo")}
							</button>
						)}
					</SettingRow>
				);
			})}
			{passwordFor && (
				<SettingRow
					title={t("settings.accounts.passwordTitle", { name: passwordFor.name })}
					desc={t("settings.accounts.passwordDesc")}
				>
					<div className="flex items-center gap-2">
						<input
							type="password"
							className="owl-settings-input w-40 text-xs"
							value={password}
							autoFocus
							onChange={(event) => setPassword(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void doSwitch(passwordFor, password);
							}}
						/>
						<button
							type="button"
							className="owl-settings-input px-3 py-1 text-xs"
							disabled={busy}
							onClick={() => void doSwitch(passwordFor, password)}
						>
							{t("settings.accounts.confirmSwitch")}
						</button>
						<button
							type="button"
							className="owl-settings-input px-3 py-1 text-xs"
							onClick={() => setPasswordFor(null)}
						>
							{t("common.cancel")}
						</button>
					</div>
				</SettingRow>
			)}
			<SettingRow title={t("settings.accounts.createTitle")} desc={t("settings.accounts.createDesc")}>
				<div className="flex items-center gap-2">
					<input
						type="text"
						className="owl-settings-input w-32 text-xs"
						placeholder={t("settings.accounts.namePlaceholder")}
						value={newName}
						onChange={(event) => setNewName(event.target.value)}
					/>
					<input
						type="password"
						className="owl-settings-input w-32 text-xs"
						placeholder={t("settings.accounts.passwordPlaceholder")}
						value={newPassword}
						onChange={(event) => setNewPassword(event.target.value)}
					/>
					<button
						type="button"
						className="owl-settings-input px-3 py-1 text-xs"
						disabled={busy || !newName.trim()}
						onClick={() => void create()}
					>
						{t("settings.accounts.create")}
					</button>
				</div>
			</SettingRow>
		</>
	);
}
