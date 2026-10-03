import { useCallback, useEffect, useRef, useState } from "react";
import type {
	MailAccount,
	MailAgentContext,
	MailAuthStart,
	MailAuthStatus,
	MailDraft,
	MailFolder,
	MailPermission,
	MailRequest,
	MailSendConfirmation,
	MailSettings,
	MailThread,
	MailThreadList,
	MailThreadRef,
} from "../../../../../packages/coding-agent/src/core/mail/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";
import { IconSearch } from "../../components/icons.tsx";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import { MailAccountsDialog } from "./MailAccountsDialog.tsx";
import { MailAgentPanel } from "./MailAgentPanel.tsx";
import { MailConnectionDialog } from "./MailConnectionDialog.tsx";
import { MailDialog } from "./MailDialog.tsx";
import { mailThreadKey, mergeMailPage, readableAccounts, summaryRef, threadContext } from "./mail-model.ts";
import { useMailAgent } from "./useMailAgent.ts";
import type { MailScopeDetails, MailSource } from "./useMailAgent.ts";
import "./mail.css";

export interface MailPageProps {
	client: BridgeClient;
	connected: boolean;
	cwd: string;
	sidebarCollapsed?: boolean;
	onUnreadChange?: (count: number) => void;
	model?: { provider: string; model: string };
	thinkingLevel?: string;
}

const EMPTY_LIST: MailThreadList = { threads: [], nextPageTokens: {}, errors: [] };
const FOLDERS: MailFolder[] = ["inbox", "unread", "starred", "sent", "drafts"];
const FOLDER_SEARCH: Record<MailFolder, string> = {
	inbox: "in:inbox",
	unread: "is:unread",
	starred: "is:starred",
	sent: "in:sent",
	drafts: "in:drafts",
};

function MailGlyph({ kind = "mail" }: { kind?: string }): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path
				d={
					kind === "starred"
						? "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"
						: kind === "sent"
							? "m21 3-7 18-4-7-7-4 18-7Zm0 0L10 14"
							: kind === "drafts"
								? "M8 3H5v18h14V7l-4-4H8Zm6 0v5h5M8 12h8M8 16h6"
								: "M3 6h18v13H3V6Zm0 0 9 7 9-7"
				}
			/>
			{kind === "unread" && <circle cx="20" cy="5" r="3" fill="currentColor" stroke="var(--owl-ui-canvas)" />}
		</svg>
	);
}

function displayDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleString(getUiLanguage() === "zh" ? "zh-CN" : "en-US", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

export function MailPage({
	client,
	connected,
	cwd,
	sidebarCollapsed = false,
	onUnreadChange,
	model,
	thinkingLevel,
}: MailPageProps): React.JSX.Element {
	const t = useT();
	const [accounts, setAccounts] = useState<MailAccount[]>([]);
	const [settings, setSettings] = useState<MailSettings>();
	const [initialLoading, setInitialLoading] = useState(true);
	const [scope, setScope] = useState("all");
	const [folder, setFolder] = useState<MailFolder>("inbox");
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [revision, setRevision] = useState(0);
	const [list, setList] = useState<MailThreadList>(EMPTY_LIST);
	const [listLoading, setListLoading] = useState(false);
	const [listError, setListError] = useState<string>();
	const [selected, setSelected] = useState<MailThreadRef>();
	const [checked, setChecked] = useState<MailThreadRef[]>([]);
	const [loadedThread, setThread] = useState<MailThread>();
	const [threadLoading, setThreadLoading] = useState(false);
	const [threadError, setThreadError] = useState<string>();
	const [panel, setPanel] = useState<"list" | "reader" | "agent">("reader");
	const [agentOpen, setAgentOpen] = useState(true);
	const [notice, setNotice] = useState<string>();
	const [error, setError] = useState<string>();
	const [managing, setManaging] = useState(false);
	const [manageBusy, setManageBusy] = useState(false);
	const [disconnecting, setDisconnecting] = useState<MailAccount>();
	const [connection, setConnection] = useState<{ accountId?: string; permission: MailPermission }>();
	const [auth, setAuth] = useState<MailAuthStart>();
	const [authBusy, setAuthBusy] = useState(false);
	const [authError, setAuthError] = useState<string>();
	const [draftBusy, setDraftBusy] = useState<"save" | "preview">();
	const [confirmation, setConfirmation] = useState<{ preview: MailSendConfirmation; sessionId: string }>();
	const [sendBusy, setSendBusy] = useState(false);
	const [sendError, setSendError] = useState<string>();
	const [clock, setClock] = useState(Date.now());
	const accountMenu = useRef<HTMLDetailsElement>(null);
	const mounted = useRef(true);
	const listGeneration = useRef(0);
	const listLock = useRef(false);
	const authGeneration = useRef(0);
	const mutationLock = useRef(false);
	const sendUsed = useRef(new Set<string>());
	const caches = useRef(new Map<string, MailThread>());
	const agent = useMailAgent(client, connected, cwd, model, thinkingLevel);
	const scopedAccounts = scope === "all" ? accounts : accounts.filter((account) => account.id === scope);
	const available = readableAccounts(scopedAccounts);
	const thread =
		selected && loadedThread?.accountId === selected.accountId && loadedThread.id === selected.threadId
			? loadedThread
			: undefined;
	const accountStamp = JSON.stringify(
		accounts.map((account) => [account.id, account.status, account.capabilities.read]),
	);
	const currentAccount = accounts.find((account) => account.id === scope);
	const selectedAccount = accounts.find((account) => account.id === thread?.accountId);
	const selectedKey = selected ? mailThreadKey(selected) : "";

	const request = useCallback(
		async <T,>(payload: MailRequest): Promise<T> => {
			try {
				const result = await client.request<T>({ type: "mail.request", request: payload });
				if (!result.ok) throw new Error(result.error ?? t("mail.error"));
				return result.result as T;
			} catch (failure) {
				if (failure instanceof Error && /^(bridge not connected|bridge disconnected)$/i.test(failure.message)) throw new Error(t("mail.offline"));
				throw failure;
			}
		},
		[client, t],
	);

	const loadAccounts = useCallback(async (): Promise<void> => {
		const result = await request<MailAccount[]>({ action: "accounts" });
		if (mounted.current) setAccounts(result);
	}, [request]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			authGeneration.current++;
		};
	}, []);
	useEffect(() => {
		const closeOutside = (event: PointerEvent): void => {
			if (event.target instanceof Node && !accountMenu.current?.contains(event.target) && accountMenu.current)
				accountMenu.current.open = false;
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && accountMenu.current?.open) {
				accountMenu.current.open = false;
				event.preventDefault();
			}
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, []);
	useEffect(() => {
		let alive = true;
		if (!connected) {
			setInitialLoading(false);
			return;
		}
		setInitialLoading(true);
		void Promise.allSettled([
			request<MailAccount[]>({ action: "accounts" }),
			request<MailSettings>({ action: "settings" }),
		]).then(([accountResult, settingsResult]) => {
			if (!alive) return;
			if (accountResult.status === "fulfilled") setAccounts(accountResult.value);
			else setError(accountResult.reason instanceof Error ? accountResult.reason.message : t("mail.error"));
			if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
			else setError(settingsResult.reason instanceof Error ? settingsResult.reason.message : t("mail.error"));
			setInitialLoading(false);
		});
		return () => {
			alive = false;
		};
	}, [connected, request, t]);

	useEffect(() => {
		onUnreadChange?.(accounts.reduce((sum, account) => sum + (account.unreadCount ?? 0), 0));
	}, [accounts, onUnreadChange]);
	useEffect(() => {
		if (scope !== "all" && !accounts.some((account) => account.id === scope)) setScope("all");
	}, [accounts, scope]);
	useEffect(() => {
		const timer = setTimeout(() => {
			if (search.trim() !== query) {
				setSelected(undefined);
				setQuery(search.trim());
			}
		}, 350);
		return () => clearTimeout(timer);
	}, [search, query]);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(undefined), 6500);
		return () => clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		const generation = ++listGeneration.current;
		listLock.current = false;
		setList(EMPTY_LIST);
		setChecked([]);
		setListError(undefined);
		if (!connected || available.length === 0) {
			setListLoading(false);
			return;
		}
		setListLoading(true);
		void request<MailThreadList>({
			action: "threads.list",
			accountIds: available.map((account) => account.id),
			folder,
			...(query ? { query } : {}),
			maxResults: 25,
		})
			.then((result) => {
				if (!mounted.current || generation !== listGeneration.current) return;
				setList(result);
				setSelected((current) => current ?? (result.threads[0] ? summaryRef(result.threads[0]) : undefined));
				void loadAccounts().catch(() => {});
			})
			.catch((failure: unknown) => {
				if (mounted.current && generation === listGeneration.current)
					setListError(failure instanceof Error ? failure.message : t("mail.error"));
			})
			.finally(() => {
				if (mounted.current && generation === listGeneration.current) setListLoading(false);
			});
	}, [connected, scope, folder, query, accountStamp, revision, request, loadAccounts, t]);

	useEffect(() => {
		let alive = true;
		setThreadError(undefined);
		if (!selected) {
			setThread(undefined);
			setThreadLoading(false);
			return;
		}
		const cached = caches.current.get(selectedKey);
		setThread(cached);
		if (!connected) {
			setThreadLoading(false);
			return;
		}
		setThreadLoading(true);
		void request<MailThread>({ action: "thread.get", accountId: selected.accountId, threadId: selected.threadId })
			.then((result) => {
				if (!alive) return;
				caches.current.set(selectedKey, result);
				setThread(result);
			})
			.catch((failure: unknown) => {
				if (alive) setThreadError(failure instanceof Error ? failure.message : t("mail.error"));
				void loadAccounts().catch(() => {});
			})
			.finally(() => {
				if (alive) setThreadLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [selectedKey, connected, revision, request, loadAccounts, t]);

	useEffect(() => {
		if (!auth) return;
		const generation = authGeneration.current;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let alive = true;
		const poll = async (): Promise<void> => {
			if (Date.now() >= Date.parse(auth.expiresAt)) {
				setAuth(undefined);
				setAuthError(t("mail.authExpired"));
				void request({ action: "auth.cancel", authId: auth.authId }).catch(() => {});
				return;
			}
			try {
				const state = await request<MailAuthStatus>({ action: "auth.status", authId: auth.authId });
				if (!alive || generation !== authGeneration.current) return;
				if (state.state === "complete" && state.account) {
					setAuth(undefined);
					setConnection(undefined);
					setNotice(t("mail.accountAdded", { email: state.account.email }));
					await loadAccounts();
					setRevision((current) => current + 1);
					return;
				}
				if (state.state !== "pending") {
					setAuth(undefined);
					setAuthError(state.error ?? t("mail.authFailed"));
					return;
				}
				if (Date.now() >= Date.parse(auth.expiresAt)) {
					setAuth(undefined);
					setAuthError(t("mail.authExpired"));
					void request({ action: "auth.cancel", authId: auth.authId }).catch(() => {});
					return;
				}
				timer = setTimeout(() => void poll(), 1500);
			} catch (failure) {
				if (!alive || generation !== authGeneration.current) return;
				setAuthError(failure instanceof Error ? failure.message : t("mail.authFailed"));
				timer = setTimeout(() => void poll(), 3500);
			}
		};
		void poll();
		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
		};
	}, [auth, request, loadAccounts, t]);

	useEffect(() => {
		if (!confirmation) return;
		setClock(Date.now());
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [confirmation]);

	async function refresh(): Promise<void> {
		setError(undefined);
		try {
			await loadAccounts();
			setRevision((current) => current + 1);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t("mail.error"));
		}
	}

	async function loadMore(): Promise<void> {
		if (listLock.current || listLoading || !connected) return;
		const accountIds = Object.keys(list.nextPageTokens);
		if (!accountIds.length) return;
		const generation = listGeneration.current;
		listLock.current = true;
		setListLoading(true);
		setListError(undefined);
		try {
			const page = await request<MailThreadList>({
				action: "threads.list",
				accountIds,
				folder,
				...(query ? { query } : {}),
				pageTokens: list.nextPageTokens,
				maxResults: 25,
			});
			if (generation === listGeneration.current && mounted.current)
				setList((current) => mergeMailPage(current, page));
		} catch (failure) {
			if (generation === listGeneration.current)
				setListError(failure instanceof Error ? failure.message : t("mail.error"));
		} finally {
			if (generation === listGeneration.current && mounted.current) {
				listLock.current = false;
				setListLoading(false);
			}
		}
	}

	function chooseScope(id: string): void {
		setScope(id);
		setSelected(undefined);
		setPanel("reader");
		if (accountMenu.current) accountMenu.current.open = false;
	}
	function chooseFolder(value: MailFolder): void {
		setFolder(value);
		setSearch("");
		setQuery("");
		setSelected(undefined);
		setPanel("list");
	}
	function chooseThread(ref: MailThreadRef): void {
		setSelected(ref);
		setPanel("reader");
	}
	function openSource(source: MailSource): void {
		setScope(source.accountId);
		setSelected(source);
		setPanel("reader");
	}
	function beginConnection(accountId?: string, permission: MailPermission = "read"): void {
		setManaging(false);
		setDisconnecting(undefined);
		setAuthError(undefined);
		setConnection({ accountId, permission });
		if (accountMenu.current) accountMenu.current.open = false;
	}
	function closeConnection(): void {
		authGeneration.current++;
		if (auth) void request({ action: "auth.cancel", authId: auth.authId }).catch(() => {});
		setAuth(undefined);
		setConnection(undefined);
		setAuthError(undefined);
	}
	async function openUrl(target: string): Promise<void> {
		const response = await client.request({ type: "open.external", action: "url", target });
		if (!response.ok) throw new Error(response.error ?? t("mail.error"));
	}
	async function importClient(file: File): Promise<void> {
		if (mutationLock.current) return;
		mutationLock.current = true;
		setAuthBusy(true);
		setAuthError(undefined);
		try {
			if (file.size > 1024 * 1024) throw new Error(t("mail.invalidFile"));
			const content = await file.text();
			try {
				JSON.parse(content);
			} catch {
				throw new Error(t("mail.invalidFile"));
			}
			const result = await request<MailSettings>({ action: "configure", clientJson: content });
			setSettings(result);
		} catch (failure) {
			setAuthError(failure instanceof Error ? failure.message : t("mail.invalidFile"));
		} finally {
			mutationLock.current = false;
			setAuthBusy(false);
		}
	}
	async function startAuth(): Promise<void> {
		if (!connection || mutationLock.current) return;
		mutationLock.current = true;
		setAuthBusy(true);
		setAuthError(undefined);
		const generation = ++authGeneration.current;
		try {
			const result = await request<MailAuthStart>({ action: "auth.start", ...connection });
			if (generation !== authGeneration.current) return;
			setAuth(result);
			await openUrl(result.authorizationUrl);
		} catch (failure) {
			if (generation === authGeneration.current)
				setAuthError(failure instanceof Error ? failure.message : t("mail.authFailed"));
		} finally {
			mutationLock.current = false;
			setAuthBusy(false);
		}
	}

	function scopeDetails(context: MailAgentContext): MailScopeDetails {
		const refs = context.threads ?? [];
		return {
			accounts: accounts
				.filter((account) => context.accountIds.includes(account.id))
				.map(({ id, email, label }) => ({ id, email, label })),
			sources: refs.map((ref) => ({
				...ref,
				subject:
					list.threads.find((item) => item.id === ref.threadId && item.accountId === ref.accountId)?.subject ??
					(thread?.id === ref.threadId && thread.accountId === ref.accountId ? thread.subject : ""),
			})),
			excluded: scopedAccounts
				.filter(
					(account) =>
						!context.accountIds.includes(account.id) &&
						(account.status !== "connected" || !account.capabilities.read),
				)
				.map((account) => account.email),
		};
	}
	function selectionContext(): MailAgentContext {
		if (checked.length) return threadContext(checked);
		if (selected) return threadContext([selected]);
		return { mode: "accounts", accountIds: available.map((account) => account.id) };
	}
	async function ask(prompt: string, context?: MailAgentContext): Promise<void> {
		setError(undefined);
		setAgentOpen(true);
		setPanel("agent");
		const fixed = context ?? (agent.active ? undefined : selectionContext());
		if (fixed && !fixed.accountIds.length) {
			const failure = new Error(t("mail.noAvailableAccount"));
			setError(failure.message);
			throw failure;
		}
		try {
			await agent.ask(prompt, fixed, fixed ? scopeDetails(fixed) : undefined);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t("mail.agentFailed"));
			throw failure;
		}
	}
	function quickAction(action: "summary" | "tasks" | "reply", refs = selected ? [selected] : checked): void {
		const context = threadContext(refs);
		if (!refs.length) return;
		void ask(
			t(action === "summary" ? "mail.promptSummary" : action === "tasks" ? "mail.promptTasks" : "mail.promptReply"),
			context,
		).catch(() => {});
	}
	async function useCurrent(): Promise<void> {
		if (!selected) return;
		const context = threadContext([selected]);
		setError(undefined);
		try {
			await agent.start(context, scopeDetails(context));
			setAgentOpen(true);
			setPanel("agent");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t("mail.agentFailed"));
		}
	}

	async function renameAccount(account: MailAccount, label: string): Promise<void> {
		if (mutationLock.current) return;
		mutationLock.current = true;
		setManageBusy(true);
		setError(undefined);
		try {
			await request({ action: "rename", accountId: account.id, label });
			await loadAccounts();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t("mail.error"));
		} finally {
			mutationLock.current = false;
			setManageBusy(false);
		}
	}
	async function disconnectAccount(): Promise<void> {
		if (!disconnecting || mutationLock.current) return;
		mutationLock.current = true;
		setManageBusy(true);
		setError(undefined);
		try {
			await request({ action: "disconnect", accountId: disconnecting.id });
			await loadAccounts();
			setDisconnecting(undefined);
			setScope("all");
			setSelected(undefined);
			setRevision((current) => current + 1);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t("mail.error"));
		} finally {
			mutationLock.current = false;
			setManageBusy(false);
		}
	}
	function draftPermission(draft: MailDraft): boolean {
		const account = accounts.find((entry) => entry.id === draft.accountId);
		if (!account) {
			setError(t("mail.draftRetained"));
			return false;
		}
		if (account.status !== "connected" || !account.capabilities.compose || !account.capabilities.send) {
			beginConnection(account.id, "send");
			return false;
		}
		return true;
	}
	async function saveDraft(draft: MailDraft): Promise<void> {
		if (mutationLock.current || !agent.active || !draftPermission(draft)) return;
		mutationLock.current = true;
		setDraftBusy("save");
		setError(undefined);
		const sessionId = agent.active.id;
		try {
			const result = await request<MailDraft>({ action: "draft.save", draft });
			agent.markSaved(sessionId, result, draft);
			setNotice(
				t("mail.savedDraft", { email: accounts.find((account) => account.id === draft.accountId)?.email ?? "" }),
			);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t("mail.error"));
			void loadAccounts().catch(() => {});
		} finally {
			mutationLock.current = false;
			setDraftBusy(undefined);
		}
	}
	async function previewSend(draft: MailDraft): Promise<void> {
		if (mutationLock.current || !agent.active || !draftPermission(draft)) return;
		mutationLock.current = true;
		setDraftBusy("preview");
		setError(undefined);
		setSendError(undefined);
		const sessionId = agent.active.id;
		try {
			const preview = await request<MailSendConfirmation>({ action: "send.prepare", draft });
			setConfirmation({ preview, sessionId });
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t("mail.error"));
			void loadAccounts().catch(() => {});
		} finally {
			mutationLock.current = false;
			setDraftBusy(undefined);
		}
	}
	async function confirmSend(): Promise<void> {
		if (!confirmation || sendBusy || sendUsed.current.has(confirmation.preview.confirmationId)) return;
		const preview = confirmation.preview;
		if (Date.now() >= Date.parse(preview.expiresAt)) {
			setSendError(t("mail.confirmExpired"));
			return;
		}
		sendUsed.current.add(preview.confirmationId);
		setSendBusy(true);
		setSendError(undefined);
		try {
			await request({ action: "send.confirm", confirmationId: preview.confirmationId });
			agent.markSent(confirmation.sessionId, preview.draft);
			setConfirmation(undefined);
			setNotice(t("mail.sent", { email: preview.accountEmail }));
			setRevision((current) => current + 1);
		} catch (failure) {
			setSendError(`${failure instanceof Error ? failure.message : t("mail.error")} ${t("mail.sendUnknown")}`);
		} finally {
			setSendBusy(false);
		}
	}

	const agentDisabled = !connected || agent.submitting || Boolean(agent.active?.running);
	const accountSelector = (
		<details className="owl-mail-account-switcher" ref={accountMenu}>
			<summary aria-label={t("mail.accountPicker")}>
				<span className="owl-mail-google-mark" aria-hidden="true">
					G
				</span>
				<span>
					<strong>{currentAccount?.label || t("mail.allAccounts")}</strong>
					<small>{currentAccount?.email || t("mail.accountsCount", { n: accounts.length })}</small>
				</span>
				<span aria-hidden="true">⌄</span>
			</summary>
			<div className="owl-mail-account-menu">
				<div className="owl-mail-eyebrow">{t("mail.accountScope")}</div>
				<button type="button" className={scope === "all" ? "is-active" : ""} onClick={() => chooseScope("all")}>
					<span className="owl-mail-account-avatar" aria-hidden="true">
						∑
					</span>
					<span>
						<strong>{t("mail.allAccounts")}</strong>
						<small>{t("mail.accountsCount", { n: accounts.length })}</small>
					</span>
				</button>
				{accounts.map((account) => (
					<button
						type="button"
						key={account.id}
						className={scope === account.id ? "is-active" : ""}
						onClick={() => chooseScope(account.id)}
					>
						<span className="owl-mail-account-avatar" aria-hidden="true">
							{(account.label || account.email).slice(0, 1)}
						</span>
						<span>
							<strong>{account.label || account.email}</strong>
							<small>{account.email}</small>
							<small className={account.status === "connected" ? "" : "owl-mail-warning"}>
								{t(`mail.${account.status}`)} ·{" "}
								{t(account.capabilities.send ? "mail.canSend" : "mail.readOnly")}
							</small>
						</span>
					</button>
				))}
				<button
					type="button"
					className="owl-mail-add-account"
					onClick={() => beginConnection()}
					disabled={!connected}
				>
					+ {t("mail.addAccount")}
				</button>
			</div>
		</details>
	);

	return (
		<div className={`owl-mail-workspace${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
			<aside
				id="owl-mail-sidebar"
				className="owl-mail-sidebar"
				hidden={sidebarCollapsed}
				aria-label={t("mail.title")}
			>
				<div className="owl-mail-brand">
					<strong>owl</strong>
					<span>{t("mail.local")}</span>
				</div>
				<div className="owl-mail-account-card">
					{accountSelector}
					<div className="owl-mail-account-status">
						<span className="owl-mail-dot" />
						<span>
							{currentAccount
								? t(`mail.${currentAccount.status}`)
								: t("mail.accountsCount", { n: readableAccounts(accounts).length })}
						</span>
						<button type="button" className="owl-mail-link-button" onClick={() => setManaging(true)}>
							{t("mail.manageAccounts")}
						</button>
					</div>
				</div>
				<div className="owl-mail-eyebrow">{t("mail.folders")}</div>
				<nav aria-label={t("mail.folders")}>
					{FOLDERS.map((value) => (
						<button
							type="button"
							key={value}
							className={`owl-mail-folder${folder === value ? " is-active" : ""}`}
							aria-current={folder === value ? "page" : undefined}
							onClick={() => chooseFolder(value)}
						>
							<MailGlyph kind={value} />
							<span>{t(`mail.folder.${value}`)}</span>
							{value === "unread" &&
								scopedAccounts.length > 0 &&
								scopedAccounts.every((account) => account.unreadCount !== undefined) && (
									<small>{scopedAccounts.reduce((sum, account) => sum + (account.unreadCount ?? 0), 0)}</small>
								)}
						</button>
					))}
				</nav>
				<div className="owl-mail-side-capability">
					<strong>{t("mail.agentCapability")}</strong>
					<p>{t("mail.agentCapabilityHint")}</p>
					<button
						type="button"
						className="owl-mail-link-button"
						onClick={() => beginConnection()}
						disabled={!connected}
					>
						+ {t("mail.addAccount")}
					</button>
				</div>
				<div className="owl-mail-sidebar-footer">
					<span className="owl-mail-account-avatar" aria-hidden="true">
						G
					</span>
					<div>
						<strong>Gmail</strong>
						<small>{t("mail.clientPrivacy")}</small>
					</div>
				</div>
			</aside>
			<main className="owl-mail-main" aria-label={t("mail.title")}>
				<header className="owl-mail-main-header">
					<h1>{t("mail.title")}</h1>
					<span className="owl-mail-breadcrumb">{currentAccount?.label || t("mail.allAccounts")}</span>
					<div className="owl-mail-header-actions">
						<span className="owl-mail-connection">
							<span className={connected ? "owl-mail-dot" : "owl-mail-dot is-offline"} />
							{t(connected ? "mail.local" : "mail.offline")}
						</span>
						<button
							type="button"
							className="owl-mail-button owl-mail-mobile-manage"
							onClick={() => setManaging(true)}
						>
							{t("mail.manageAccounts")}
						</button>
						<button
							type="button"
							className="owl-mail-icon-button"
							title={t("mail.refresh")}
							aria-label={t("mail.refresh")}
							onClick={() => void refresh()}
							disabled={!connected || initialLoading}
						>
							↻
						</button>
						<button
							type="button"
							className="owl-mail-button owl-mail-agent-toggle"
							aria-pressed={agentOpen && panel === "agent"}
							onClick={() => {
								setAgentOpen((value) => !value || panel !== "agent");
								setPanel(panel === "agent" ? "reader" : "agent");
							}}
						>
							{t("mail.openAgent")} ✦
						</button>
					</div>
				</header>
				<div className="owl-mail-mobile-nav">
					<label>
						<span className="sr-only">{t("mail.accountPicker")}</span>
						<select value={scope} onChange={(event) => chooseScope(event.target.value)}>
							<option value="all">{t("mail.allAccounts")}</option>
							{accounts.map((account) => (
								<option key={account.id} value={account.id}>
									{account.label || account.email}
								</option>
							))}
						</select>
					</label>
					<label>
						<span className="sr-only">{t("mail.folders")}</span>
						<select value={folder} onChange={(event) => chooseFolder(event.target.value as MailFolder)}>
							{FOLDERS.map((value) => (
								<option value={value} key={value}>
									{t(`mail.folder.${value}`)}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="owl-mail-link-button"
						onClick={() => beginConnection()}
						disabled={!connected}
					>
						+ {t("mail.addAccount")}
					</button>
				</div>
				{error && (
					<div role="alert" className="owl-mail-top-error">
						<span>{error}</span>
						<button
							type="button"
							className="owl-mail-icon-button"
							aria-label={t("mail.close")}
							onClick={() => setError(undefined)}
						>
							×
						</button>
					</div>
				)}
				{scopedAccounts
					.filter((account) => account.status !== "connected")
					.map((account) => (
						<div className="owl-mail-expired-banner" key={account.id}>
							<span>
								{account.email} · {t(`mail.${account.status}`)}
							</span>
							<button
								type="button"
								className="owl-mail-link-button"
								disabled={!connected}
								onClick={() => beginConnection(account.id, account.capabilities.send ? "send" : "read")}
							>
								{t("mail.reconnect")}
							</button>
						</div>
					))}
				{initialLoading ? (
					<div className="owl-mail-empty" role="status">
						<span className="owl-mail-spinner" />
						{t("mail.loading")}
					</div>
				) : accounts.length === 0 ? (
					<div className="owl-mail-onboarding">
						<span className="owl-mail-onboarding-icon">
							<MailGlyph />
						</span>
						<div className="owl-mail-eyebrow">OWL MAIL</div>
						<h2>{t("mail.onboardTitle")}</h2>
						<p>{t("mail.onboardHint")}</p>
						<button
							type="button"
							className="owl-mail-button is-primary"
							onClick={() => beginConnection()}
							disabled={!connected}
						>
							{t("mail.connectGoogle")}
						</button>
						<small>{t("mail.onboardPermission")}</small>
						<div className="owl-mail-onboarding-features">
							{(["Read", "Agent", "Confirm"] as const).map((value) => (
								<div key={value}>
									<strong>{t(`mail.onboard${value}`)}</strong>
									<p>{t(`mail.onboard${value}Hint`)}</p>
								</div>
							))}
						</div>
					</div>
				) : (
					<>
						<nav className="owl-mail-compact-tabs" aria-label={t("mail.title")}>
							{(["list", "reader", "agent"] as const).map((value) => (
								<button
									type="button"
									key={value}
									aria-pressed={panel === value}
									onClick={() => {
										setPanel(value);
										if (value === "agent") setAgentOpen(true);
									}}
								>
									{t(
										value === "list"
											? "mail.viewList"
											: value === "reader"
												? "mail.viewReader"
												: "mail.viewAgent",
									)}
								</button>
							))}
						</nav>
						<div className={`owl-mail-columns is-${panel}${agentOpen ? " has-agent" : ""}`}>
							<section className="owl-mail-list" aria-label={t("mail.viewList")}>
								<div className="owl-mail-list-top">
									<div>
										<h2>{t(`mail.folder.${folder}`)}</h2>
										<span>{t("mail.loadedCount", { n: list.threads.length })}</span>
									</div>
									<form
										className="owl-mail-search"
										onSubmit={(event) => {
											event.preventDefault();
											if (search.trim() !== query) setSelected(undefined);
											setQuery(search.trim());
										}}
									>
										<IconSearch />
										<input
											value={search}
											onChange={(event) => setSearch(event.target.value)}
											placeholder={t("mail.search")}
											aria-label={t("mail.search")}
											title={t("mail.searchHint")}
										/>
										<button
											type="submit"
											className="owl-mail-icon-button"
											aria-label={t("mail.searchSubmit")}
										>
											↵
										</button>
									</form>
									<button
										type="button"
										className="owl-mail-link-button"
										disabled={agentDisabled || available.length === 0}
										onClick={() =>
											void ask(
												t("mail.promptMailboxSummary", {
													query: `${FOLDER_SEARCH[folder]} ${query}`.trim(),
												}),
												{
													mode: "accounts",
													accountIds: available.map((account) => account.id),
												},
											).catch(() => {})
										}
									>
										{t("mail.summarizeInbox")} <span aria-hidden="true">→</span>
									</button>
								</div>
								{checked.length > 0 && (
									<div className="owl-mail-selection-bar">
										<span>{t("mail.selectedCount", { n: checked.length })}</span>
										<button
											type="button"
											className="owl-mail-link-button"
											disabled={agentDisabled}
											onClick={() => quickAction("summary", checked)}
										>
											{t("mail.discussSelection")}
										</button>
										<button
											type="button"
											className="owl-mail-icon-button"
											aria-label={t("mail.clearSelection")}
											onClick={() => setChecked([])}
										>
											×
										</button>
									</div>
								)}
								<div className="owl-mail-list-scroll">
									{list.errors.length > 0 && (
										<div className="owl-mail-list-errors">
											<p>{t("mail.partialFailure")}</p>
											{list.errors.map((entry) => (
												<p key={entry.accountId}>
													<strong>
														{accounts.find((account) => account.id === entry.accountId)?.email ??
															entry.accountId}
													</strong>
													<br />
													{entry.error}
												</p>
											))}
											<button
												type="button"
												className="owl-mail-link-button"
												onClick={() => void refresh()}
												disabled={!connected || listLoading}
											>
												{t("mail.retry")}
											</button>
										</div>
									)}
									{listError && (
										<div role="alert" className="owl-mail-list-errors">
											<p>{listError}</p>
											<button
												type="button"
												className="owl-mail-link-button"
												onClick={() => void refresh()}
												disabled={!connected}
											>
												{t("mail.retry")}
											</button>
										</div>
									)}
									{list.threads.map((entry) => {
										const ref = summaryRef(entry);
										const key = mailThreadKey(ref);
										const account = accounts.find((value) => value.id === entry.accountId);
										return (
											<div
												className={`owl-mail-list-row${key === selectedKey ? " is-selected" : ""}`}
												key={key}
											>
												<input
													type="checkbox"
													checked={checked.some((value) => mailThreadKey(value) === key)}
													aria-label={t("mail.selectThread", {
														subject: entry.subject || t("mail.noSubject"),
													})}
													onChange={(event) =>
														setChecked((current) =>
															event.target.checked
																? [...current, ref]
																: current.filter((value) => mailThreadKey(value) !== key),
														)
													}
												/>
												<button
													type="button"
													className="owl-mail-list-item"
													onClick={() => chooseThread(ref)}
													aria-current={key === selectedKey ? "true" : undefined}
												>
													<div className="owl-mail-row-top">
														{entry.unread && <span className="owl-mail-dot" title={t("mail.unread")} />}
														<strong>{entry.from}</strong>
														<time dateTime={entry.date}>{displayDate(entry.date)}</time>
													</div>
													<strong className="owl-mail-row-subject">
														{entry.subject || t("mail.noSubject")}
													</strong>
													<p>{entry.snippet}</p>
													<div className="owl-mail-row-tags">
														<span className="owl-mail-account-chip" title={account?.email}>
															{account?.label || account?.email}
														</span>
														{entry.messageCount > 1 && (
															<span>{t("mail.messagesCount", { n: entry.messageCount })}</span>
														)}
														{entry.attachmentCount > 0 && (
															<span>{t("mail.attachmentsCount", { n: entry.attachmentCount })}</span>
														)}
													</div>
												</button>
											</div>
										);
									})}
									{listLoading && (
										<div className="owl-mail-empty is-small" role="status">
											<span className="owl-mail-spinner" />
											{t("mail.loading")}
										</div>
									)}
									{!listLoading && !listError && list.threads.length === 0 && (
										<div className="owl-mail-empty is-small">
											<h3>{t(available.length ? "mail.noMail" : "mail.noAvailableAccount")}</h3>
											<p>{t("mail.noMailHint")}</p>
										</div>
									)}
								</div>
								<div className="owl-mail-list-footer">
									<span>{t("mail.loadedCount", { n: list.threads.length })}</span>
									{Object.keys(list.nextPageTokens).length > 0 && (
										<button
											type="button"
											className="owl-mail-link-button"
											onClick={() => void loadMore()}
											disabled={listLoading || !connected}
										>
											{t("mail.loadMore")}
										</button>
									)}
								</div>
							</section>
							<section className="owl-mail-reader" aria-label={t("mail.viewReader")}>
								<div className="owl-mail-reader-toolbar">
									<span>{t("mail.original")}</span>
									{thread && (
										<span className="owl-mail-account-chip" title={selectedAccount?.email}>
											{selectedAccount?.label || selectedAccount?.email}
										</span>
									)}
								</div>
								<div className="owl-mail-reader-scroll">
									{threadError && (
										<p role="alert" className="owl-mail-error">
											{threadError}
										</p>
									)}
									{threadLoading && !thread && (
										<div className="owl-mail-empty" role="status">
											{t("mail.loading")}
										</div>
									)}
									{!thread && !threadLoading && (
										<div className="owl-mail-empty">
											<MailGlyph />
											<h2>{t("mail.chooseMail")}</h2>
											<p>{t("mail.chooseMailHint")}</p>
										</div>
									)}
									{thread && (
										<>
											<div className="owl-mail-eyebrow">{t("mail.original")}</div>
											<h2 className="owl-mail-subject">{thread.subject || t("mail.noSubject")}</h2>
											<div className="owl-mail-reader-account">
												<span>{t("mail.sourceAccount")}</span>
												<strong>
													{selectedAccount?.email ??
														agent.active?.accounts.find((account) => account.id === thread.accountId)
															?.email}
												</strong>
											</div>
											{thread.messages.map((message, index) => (
												<article className="owl-mail-message" key={`${thread.accountId}-${message.id}`}>
													<div className="owl-mail-message-heading">
														<span className="owl-mail-sender-avatar" aria-hidden="true">
															{message.from.slice(0, 1)}
														</span>
														<div>
															<strong>{message.from}</strong>
															<p>
																{t("mail.to")}: {message.to}
															</p>
															{message.cc && (
																<p>
																	{t("mail.cc")}: {message.cc}
																</p>
															)}
														</div>
														<time dateTime={message.date}>{displayDate(message.date)}</time>
													</div>
													{index > 0 && message.subject !== thread.subject && <h3>{message.subject}</h3>}
													<div className="owl-mail-message-body">
														{message.bodyText || message.snippet}
													</div>
													{message.attachments.length > 0 && (
														<div className="owl-mail-attachments">
															<h3>{t("mail.attachmentsMetadata")}</h3>
															{message.attachments.map((attachment, attachmentIndex) => (
																<div key={`${attachment.id ?? attachment.name}-${attachmentIndex}`}>
																	<span aria-hidden="true">▤</span>
																	<span>
																		<strong>{attachment.name}</strong>
																		<small>
																			{attachment.mimeType} ·{" "}
																			{Math.max(1, Math.round(attachment.size / 1024))} KB
																		</small>
																	</span>
																</div>
															))}
															<p>{t("mail.attachmentsHint")}</p>
														</div>
													)}
												</article>
											))}
										</>
									)}
								</div>
								{thread && (
									<div className="owl-mail-reader-actions">
										<button
											type="button"
											className="owl-mail-button is-primary"
											disabled={agentDisabled || threadLoading || selectedAccount?.status !== "connected"}
											onClick={() => quickAction("summary")}
										>
											{t("mail.summarize")}
										</button>
										<button
											type="button"
											className="owl-mail-button"
											disabled={agentDisabled || threadLoading || selectedAccount?.status !== "connected"}
											onClick={() => quickAction("tasks")}
										>
											{t("mail.tasks")}
										</button>
										<button
											type="button"
											className="owl-mail-button"
											disabled={agentDisabled || threadLoading || selectedAccount?.status !== "connected"}
											onClick={() => quickAction("reply")}
										>
											{t("mail.reply")}
										</button>
									</div>
								)}
							</section>
							{agentOpen && (
								<MailAgentPanel
									agent={agent}
									accounts={accounts}
									connected={connected}
									draftBusy={draftBusy}
									onClose={() => {
										setAgentOpen(false);
										setPanel("reader");
									}}
									onAsk={ask}
									onUseCurrent={selected ? () => void useCurrent() : undefined}
									onSource={openSource}
									onSave={(draft) => void saveDraft(draft)}
									onPreview={(draft) => void previewSend(draft)}
									onAuthorize={(account) => beginConnection(account.id, "send")}
									onStop={() =>
										void agent
											.stop()
											.catch((failure: unknown) =>
												setError(failure instanceof Error ? failure.message : t("mail.error")),
											)
									}
								/>
							)}
						</div>
					</>
				)}
			</main>
			{notice && (
				<div className="owl-mail-notice" role="status">
					{notice}
				</div>
			)}
			{managing && (
				<MailAccountsDialog
					accounts={accounts}
					busy={manageBusy}
					connected={connected}
					onClose={() => setManaging(false)}
					onAdd={() => beginConnection()}
					onRename={(account, label) => void renameAccount(account, label)}
					onReconnect={(account) => beginConnection(account.id, account.capabilities.send ? "send" : "read")}
					onDisconnect={(account) => {
						setManaging(false);
						setDisconnecting(account);
					}}
				/>
			)}
			{disconnecting && (
				<MailDialog
					title={t("mail.confirmDisconnect")}
					onClose={() => setDisconnecting(undefined)}
					busy={manageBusy}
				>
					<p>{t("mail.disconnectHint", { email: disconnecting.email })}</p>
					<div className="owl-mail-dialog-actions">
						<button
							type="button"
							className="owl-mail-button"
							disabled={manageBusy}
							onClick={() => setDisconnecting(undefined)}
						>
							{t("mail.cancel")}
						</button>
						<button
							type="button"
							className="owl-mail-button is-danger"
							disabled={manageBusy || !connected}
							onClick={() => void disconnectAccount()}
						>
							{t(manageBusy ? "mail.busy" : "mail.disconnect")}
						</button>
					</div>
				</MailDialog>
			)}
			{connection && (
				<MailConnectionDialog
					settings={settings}
					target={accounts.find((account) => account.id === connection.accountId)}
					permission={connection.permission}
					pending={auth}
					busy={authBusy}
					error={authError}
					onClose={closeConnection}
					onFile={(file) => void importClient(file)}
					onStart={() => void startAuth()}
					onOpen={() => {
						if (auth)
							void openUrl(auth.authorizationUrl).catch((failure: unknown) =>
								setAuthError(failure instanceof Error ? failure.message : t("mail.error")),
							);
					}}
					onConsole={() =>
						void openUrl("https://console.cloud.google.com/apis/credentials").catch((failure: unknown) =>
							setAuthError(failure instanceof Error ? failure.message : t("mail.error")),
						)
					}
				/>
			)}
			{confirmation && (
				<MailDialog title={t("mail.sendReview")} onClose={() => setConfirmation(undefined)} busy={sendBusy}>
					<p>{t("mail.sendReviewHint")}</p>
					<div className="owl-mail-review-field">
						<span>{t("mail.from")}</span>
						<strong>{confirmation.preview.accountEmail}</strong>
					</div>
					{(["to", "cc", "bcc", "subject"] as const).map((field) =>
						confirmation.preview.draft[field] ? (
							<div className="owl-mail-review-field" key={field}>
								<span>{t(`mail.${field}`)}</span>
								<strong>{confirmation.preview.draft[field]}</strong>
							</div>
						) : null,
					)}
					<div className="owl-mail-review-body" aria-label={t("mail.body")}>
						{confirmation.preview.draft.body}
					</div>
					{clock >= Date.parse(confirmation.preview.expiresAt) && (
						<p role="alert" className="owl-mail-error">
							{t("mail.confirmExpired")}
						</p>
					)}
					{sendError && (
						<p role="alert" className="owl-mail-error">
							{sendError}
						</p>
					)}
					<div className="owl-mail-dialog-actions">
						<button
							type="button"
							className="owl-mail-button"
							onClick={() => setConfirmation(undefined)}
							disabled={sendBusy}
						>
							{t("mail.cancel")}
						</button>
						<button
							type="button"
							className="owl-mail-button is-primary"
							onClick={() => void confirmSend()}
							disabled={
								sendBusy ||
								!connected ||
								sendUsed.current.has(confirmation.preview.confirmationId) ||
								clock >= Date.parse(confirmation.preview.expiresAt)
							}
						>
							{t(sendBusy ? "mail.sending" : "mail.confirmSend")}
						</button>
					</div>
				</MailDialog>
			)}
		</div>
	);
}
