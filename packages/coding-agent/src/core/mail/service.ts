import { createHash, randomUUID } from "node:crypto";
import { buildMime, type GmailThread, parseThread, summarizeThread, validateDraft } from "./mime.ts";
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GoogleMailOAuth, MailOAuthError } from "./oauth.ts";
import { MailStore, type MailStoreData, type SecretTransform, type StoredMailAccount } from "./store.ts";
import type {
	MailAccount,
	MailAccountStatus,
	MailDraft,
	MailPermission,
	MailRequest,
	MailSendConfirmation,
	MailSettings,
	MailThread,
	MailThreadList,
} from "./types.ts";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const FULL_SCOPE = "https://mail.google.com/";
const KNOWN_SCOPES = new Set([READ_SCOPE, COMPOSE_SCOPE, SEND_SCOPE, MODIFY_SCOPE, FULL_SCOPE]);

async function mapConcurrent<T, R>(items: T[], limit: number, transform: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(items.length, limit) }, async () => {
			while (cursor < items.length) {
				const index = cursor++;
				results[index] = await transform(items[index]);
			}
		}),
	);
	return results;
}

interface GoogleTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
}

interface PreparedSend {
	accountId: string;
	accountEmail: string;
	draft: MailDraft;
	gmailThreadId?: string;
	raw: string;
	expiresAt: number;
}

export interface MailServiceOptions {
	agentDir: string;
	fetch?: typeof fetch;
	now?: () => number;
	seal?: SecretTransform;
	unseal?: SecretTransform;
	authTtlMs?: number;
	confirmationTtlMs?: number;
}

export class MailService {
	private readonly store: MailStore;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly oauth: GoogleMailOAuth;
	private readonly ready: Promise<void>;
	private readonly confirmationTtl: number;
	private readonly confirmations = new Map<string, PreparedSend>();
	private readonly refreshes = new Map<string, Promise<string>>();
	private readonly generations = new Map<string, number>();
	private data: MailStoreData = { accounts: [] };
	private disposed = false;

	constructor(options: MailServiceOptions) {
		this.store = new MailStore(options.agentDir, options.seal, options.unseal);
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.oauth = new GoogleMailOAuth(this.now, options.authTtlMs);
		this.confirmationTtl = options.confirmationTtlMs ?? 5 * 60_000;
		this.ready = this.store.load().then((data) => {
			this.data = data;
		});
	}

	async handle(request: MailRequest): Promise<unknown> {
		await this.ready;
		if (this.disposed) throw new Error("邮箱服务已关闭。");
		if (!request || typeof request.action !== "string") throw new Error("邮箱请求无效。");
		switch (request.action) {
			case "settings":
				return this.settings();
			case "configure":
				return this.configure(request.clientJson);
			case "accounts":
				return this.data.accounts.map((account) => this.publicAccount(account));
			case "auth.start":
				return this.startAuth(request.accountId, request.permission);
			case "auth.status":
				return this.oauth.status(request.authId);
			case "auth.cancel":
				return this.oauth.cancel(request.authId);
			case "disconnect":
				return this.disconnect(request.accountId);
			case "rename": {
				const account = this.account(request.accountId);
				if (typeof request.label !== "string" || !request.label.trim() || request.label.length > 80) {
					throw new Error("账号名称需为 1 至 80 个字符。");
				}
				account.label = request.label.trim();
				await this.store.save(this.data);
				return this.publicAccount(account);
			}
			case "threads.list":
				return this.listThreads(request);
			case "thread.get":
				return this.getThread(request.accountId, request.threadId);
			case "draft.save":
				return this.saveDraft(request.draft);
			case "send.prepare":
				return this.prepareSend(request.draft);
			case "send.confirm":
				return this.confirmSend(request.confirmationId);
			default:
				throw new Error("不支持的邮箱操作。");
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.confirmations.clear();
		await this.oauth.dispose();
	}

	private settings(): MailSettings {
		return { configured: Boolean(this.data.client), clientId: this.data.client?.clientId };
	}

	private async configure(clientJson: string): Promise<MailSettings> {
		let parsed: { installed?: { client_id?: unknown; client_secret?: unknown } };
		try {
			if (typeof clientJson !== "string" || clientJson.length > 100_000) throw new Error("Invalid client");
			parsed = JSON.parse(clientJson) as typeof parsed;
		} catch {
			throw new Error("请导入 Google 下载的桌面应用 OAuth 客户端 JSON。");
		}
		const client = parsed?.installed;
		if (
			!client ||
			typeof client.client_id !== "string" ||
			!client.client_id.endsWith(".apps.googleusercontent.com") ||
			typeof client.client_secret !== "string" ||
			!client.client_secret ||
			/[\r\n\0]/.test(client.client_id + client.client_secret)
		) {
			throw new Error("客户端类型必须是 Google 桌面应用，并包含 client_id 和 client_secret。");
		}
		if (
			this.data.client &&
			this.data.client.clientId !== client.client_id &&
			this.data.accounts.some((account) => account.refreshToken || account.accessToken)
		) {
			throw new Error("更换 Google 客户端前，请先断开已连接邮箱。");
		}
		this.data.client = { clientId: client.client_id, clientSecret: client.client_secret };
		await this.store.save(this.data);
		return this.settings();
	}

	private publicAccount(account: StoredMailAccount): MailAccount {
		const broad = account.scopes.includes(MODIFY_SCOPE) || account.scopes.includes(FULL_SCOPE);
		const usable = account.status !== "disconnected";
		return {
			id: account.id,
			email: account.email,
			label: account.label,
			status: account.status,
			capabilities: {
				read: usable && (broad || account.scopes.includes(READ_SCOPE)),
				compose: usable && (broad || account.scopes.includes(COMPOSE_SCOPE)),
				send: usable && (broad || account.scopes.includes(COMPOSE_SCOPE) || account.scopes.includes(SEND_SCOPE)),
				modify: usable && broad,
			},
			lastSyncedAt: account.lastSyncedAt,
			unreadCount: account.unreadCount,
			error: account.error,
		};
	}

	private account(id: string): StoredMailAccount {
		const account = this.data.accounts.find((entry) => entry.id === id);
		if (!account) throw new Error("邮箱账号不存在，请重新选择。");
		return account;
	}

	private requireCapability(account: StoredMailAccount, capability: "read" | "compose" | "send"): void {
		if (account.status === "disconnected") throw new Error("此邮箱已断开，请重新连接。");
		if (account.status === "expired") throw new Error("此邮箱授权已过期，请重新连接。");
		if (!this.publicAccount(account).capabilities[capability]) {
			throw new Error(
				capability === "read"
					? "此邮箱缺少读取权限，请重新授权。"
					: "此邮箱为只读权限，请先授权保存草稿与发送邮件。",
			);
		}
	}

	private async startAuth(accountId: string | undefined, permission: MailPermission) {
		if (permission !== "read" && permission !== "send") throw new Error("邮箱授权类型无效。");
		const client = this.data.client;
		if (!client) throw new Error("请先导入 Google 桌面应用 OAuth 客户端 JSON。");
		const expected = accountId ? this.account(accountId) : undefined;
		const scopes = [
			...new Set([
				READ_SCOPE,
				...(permission === "send" ? [COMPOSE_SCOPE, SEND_SCOPE] : []),
				...(expected?.scopes.filter((scope) => KNOWN_SCOPES.has(scope)) ?? []),
			]),
		];
		const generation = expected ? (this.generations.get(expected.id) ?? 0) : 0;
		return this.oauth.start({
			client,
			scopes,
			loginHint: expected?.email,
			authorize: async (code, redirectUri, verifier, isActive) => {
				const response = await this.fetch(GOOGLE_TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: client.clientId,
						client_secret: client.clientSecret,
						code,
						code_verifier: verifier,
						redirect_uri: redirectUri,
						grant_type: "authorization_code",
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (!response.ok) throw new MailOAuthError("Google 未接受此授权，请检查客户端配置后重试。");
				const token = (await response.json()) as GoogleTokenResponse;
				if (!token.access_token) throw new MailOAuthError("Google 未返回有效授权。");
				const profileResponse = await this.fetch(`${GMAIL_API}/profile`, {
					headers: { Authorization: `Bearer ${token.access_token}` },
					signal: AbortSignal.timeout(30_000),
				});
				if (!profileResponse.ok) throw new MailOAuthError("无法读取 Gmail 账号，请启用 Gmail API 并授予读取权限。");
				const profile = (await profileResponse.json()) as { emailAddress?: string };
				const email = profile.emailAddress?.trim().toLowerCase();
				if (!email || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) {
					throw new MailOAuthError("Google 未返回有效 Gmail 邮箱地址。");
				}
				if (expected && email !== expected.email.toLowerCase()) {
					throw new MailOAuthError("登录邮箱与要重新连接的账号不同，请使用原邮箱授权。");
				}
				if (
					!isActive() ||
					this.disposed ||
					this.data.client?.clientId !== client.clientId ||
					(expected && (this.generations.get(expected.id) ?? 0) !== generation)
				) {
					throw new MailOAuthError("授权已取消或账号连接已变更，请重新连接。");
				}
				const existing = this.data.accounts.find((account) => account.email.toLowerCase() === email);
				const previous = existing ? structuredClone(existing) : undefined;
				const granted = token.scope ? token.scope.split(/\s+/).filter(Boolean) : scopes;
				if (!granted.some((scope) => [READ_SCOPE, MODIFY_SCOPE, FULL_SCOPE].includes(scope))) {
					throw new MailOAuthError("此 Gmail 授权缺少读取权限，请重新授权。");
				}
				const account: StoredMailAccount = {
					id: existing?.id ?? `gmail-${createHash("sha256").update(email).digest("hex").slice(0, 24)}`,
					email,
					label: existing?.label ?? email.split("@")[0],
					status: "connected",
					scopes: granted,
					accessToken: token.access_token,
					refreshToken: token.refresh_token ?? existing?.refreshToken,
					expiresAt: this.now() + Math.max(1, Number(token.expires_in) || 3600) * 1000,
					lastSyncedAt: new Date(this.now()).toISOString(),
					unreadCount: existing?.unreadCount,
				};
				if (existing) Object.assign(existing, account, { error: undefined });
				else this.data.accounts.push(account);
				const committedGeneration = (this.generations.get(account.id) ?? 0) + 1;
				this.generations.set(account.id, committedGeneration);
				try {
					await this.store.save(this.data);
					if (!isActive() || this.disposed) throw new MailOAuthError("授权已取消或过期，请重新连接。");
				} catch (error) {
					// DPAPI/file persistence can take time. A cancelled or failed auth
					// must not leave a newly connected account behind after that write.
					// A newer reconnect/disconnect owns its own state and is preserved.
					if ((this.generations.get(account.id) ?? 0) === committedGeneration) {
						this.data.accounts = previous
							? this.data.accounts.map((current) => (current.id === account.id ? previous : current))
							: this.data.accounts.filter((current) => current.id !== account.id);
						this.generations.set(account.id, committedGeneration + 1);
						await this.store.save(this.data).catch(() => undefined);
					}
					throw error;
				}
				return this.publicAccount(account);
			},
		});
	}

	private async expireAccount(account: StoredMailAccount): Promise<never> {
		if (account.status !== "disconnected") {
			account.status = "expired";
			account.error = "邮箱授权已失效，请重新连接。";
			account.accessToken = undefined;
			await this.store.save(this.data);
		}
		throw new Error("此邮箱授权已过期，请重新连接。");
	}

	private async accessToken(account: StoredMailAccount, force = false): Promise<string> {
		if (account.status !== "connected") this.requireCapability(account, "read");
		if (!force && account.accessToken && (account.expiresAt ?? 0) > this.now() + 60_000) return account.accessToken;
		const inProgress = this.refreshes.get(account.id);
		if (inProgress) return inProgress;
		const operation = this.refreshToken(account);
		this.refreshes.set(account.id, operation);
		try {
			return await operation;
		} finally {
			if (this.refreshes.get(account.id) === operation) this.refreshes.delete(account.id);
		}
	}

	private async refreshToken(account: StoredMailAccount): Promise<string> {
		const client = this.data.client;
		const refreshToken = account.refreshToken;
		if (!client || !refreshToken) return this.expireAccount(account);
		const generation = this.generations.get(account.id) ?? 0;
		let response: Response;
		try {
			response = await this.fetch(GOOGLE_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: client.clientId,
					client_secret: client.clientSecret,
					refresh_token: refreshToken,
					grant_type: "refresh_token",
				}),
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new Error("暂时无法刷新此邮箱授权，请检查网络后重试。");
		}
		if (account.status === "disconnected" || (this.generations.get(account.id) ?? 0) !== generation) {
			if (account.status === "connected" && account.accessToken) return account.accessToken;
			throw new Error("邮箱连接已变更，请重新操作。");
		}
		const token = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
		// await 之后状态可能已被并发改写；重新读宽类型，避免沿用上面的收窄
		const statusAfterFetch = account.status as MailAccountStatus;
		if (statusAfterFetch === "disconnected" || (this.generations.get(account.id) ?? 0) !== generation) {
			if (statusAfterFetch === "connected" && account.accessToken) return account.accessToken;
			throw new Error("邮箱连接已变更，请重新操作。");
		}
		if (!response.ok || !token.access_token) {
			if (response.status === 400 || response.status === 401 || token.error === "invalid_grant")
				return this.expireAccount(account);
			throw new Error("Google 暂时无法刷新授权，请稍后重试。");
		}
		account.accessToken = token.access_token;
		account.refreshToken = token.refresh_token ?? refreshToken;
		account.expiresAt = this.now() + Math.max(1, Number(token.expires_in) || 3600) * 1000;
		if (token.scope) account.scopes = token.scope.split(/\s+/).filter(Boolean);
		account.error = undefined;
		await this.store.save(this.data);
		return account.accessToken;
	}

	private async gmail<T>(account: StoredMailAccount, path: string, init?: RequestInit, retryRead = true): Promise<T> {
		const generation = this.generations.get(account.id) ?? 0;
		let token = await this.accessToken(account);
		const invoke = async (): Promise<Response> => {
			if (account.status !== "connected" || (this.generations.get(account.id) ?? 0) !== generation) {
				throw new Error("邮箱连接已变更，请重新操作。");
			}
			let response: Response;
			try {
				response = await this.fetch(`${GMAIL_API}${path}`, {
					...init,
					headers: { "Content-Type": "application/json", ...init?.headers, Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(30_000),
				});
			} catch {
				throw new Error(
					retryRead
						? "暂时无法连接 Gmail，请检查网络后重试。"
						: "无法确认 Gmail 是否完成此操作。请先在 Gmail 中查看结果，避免重复操作。",
				);
			}
			if (account.status !== "connected" || (this.generations.get(account.id) ?? 0) !== generation) {
				throw new Error("邮箱连接已变更，请重新操作。");
			}
			return response;
		};
		let response = await invoke();
		if (response.status === 401 && retryRead && (!init?.method || init.method === "GET")) {
			token = await this.accessToken(account, true);
			response = await invoke();
		}
		if (response.status === 401) return this.expireAccount(account);
		if (!response.ok) {
			if (response.status === 403) throw new Error("Gmail 拒绝此操作，请检查此账号授权范围以及 Gmail API 设置。");
			if (response.status === 404) throw new Error("邮件或草稿不存在，可能已被删除。");
			if (response.status === 429) throw new Error("Gmail 请求过于频繁，请稍后重试。");
			throw new Error(
				retryRead
					? "Gmail 暂时无法完成此操作，请稍后重试。"
					: "无法确认 Gmail 是否完成此操作。请先在 Gmail 中查看结果，避免重复操作。",
			);
		}
		try {
			return (await response.json()) as T;
		} catch {
			throw new Error(
				retryRead ? "Gmail 返回了无效数据。" : "Gmail 返回结果无法确认。请先查看 Gmail，避免重复操作。",
			);
		}
	}

	private async disconnect(accountId: string): Promise<MailAccount> {
		const account = this.account(accountId);
		const token = account.refreshToken ?? account.accessToken;
		// Clear locally before attempting revocation, including when Google is offline.
		account.accessToken = undefined;
		account.refreshToken = undefined;
		account.expiresAt = undefined;
		account.unreadCount = undefined;
		account.status = "disconnected";
		account.error = undefined;
		this.generations.set(account.id, (this.generations.get(account.id) ?? 0) + 1);
		for (const [id, confirmation] of this.confirmations) {
			if (confirmation.accountId === accountId) this.confirmations.delete(id);
		}
		await this.store.save(this.data);
		if (token) {
			await this.fetch(GOOGLE_REVOKE_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ token }),
				signal: AbortSignal.timeout(10_000),
			}).catch(() => undefined);
		}
		return this.publicAccount(account);
	}

	private async listThreads(request: Extract<MailRequest, { action: "threads.list" }>): Promise<MailThreadList> {
		if (!Array.isArray(request.accountIds) || request.accountIds.some((id) => typeof id !== "string"))
			throw new Error("邮箱范围无效。");
		const accountIds = [...new Set(request.accountIds)];
		const result: MailThreadList = { threads: [], nextPageTokens: {}, errors: [] };
		const folders: Record<string, string> = {
			inbox: "INBOX",
			unread: "UNREAD",
			starred: "STARRED",
			sent: "SENT",
			drafts: "DRAFT",
		};
		const label = Object.hasOwn(folders, request.folder) ? folders[request.folder] : undefined;
		if (!label) throw new Error("邮箱文件夹无效。");
		const maxResults = Math.min(50, Math.max(1, Math.floor(Number(request.maxResults) || 20)));
		await mapConcurrent(accountIds, 4, async (accountId) => {
			try {
				const account = this.account(accountId);
				this.requireCapability(account, "read");
				const query = new URLSearchParams({ labelIds: label, maxResults: String(maxResults) });
				if (typeof request.query === "string" && request.query.trim()) query.set("q", request.query.trim());
				if (request.pageTokens?.[accountId]) query.set("pageToken", request.pageTokens[accountId]);
				const list = await this.gmail<{ threads?: Array<{ id: string }>; nextPageToken?: string }>(
					account,
					`/threads?${query}`,
				);
				const ids = (list.threads ?? []).slice(0, maxResults);
				const threads = await mapConcurrent(ids, 5, (thread) =>
					this.gmail<GmailThread>(account, `/threads/${encodeURIComponent(thread.id)}?format=full`),
				);
				result.threads.push(...threads.map((thread) => summarizeThread(thread, accountId)));
				if (list.nextPageToken) result.nextPageTokens[accountId] = list.nextPageToken;
				account.lastSyncedAt = new Date(this.now()).toISOString();
				try {
					const inbox = await this.gmail<{ threadsUnread?: unknown }>(
						account,
						"/labels/INBOX?fields=threadsUnread",
					);
					if (
						typeof inbox.threadsUnread === "number" &&
						Number.isInteger(inbox.threadsUnread) &&
						inbox.threadsUnread >= 0
					) {
						account.unreadCount = inbox.threadsUnread;
					}
				} catch {
					// This badge counts unread INBOX conversations, not loaded messages.
					// A failed count leaves it unknown/cached and never discards the page.
					// An auth failure is still reflected by the account's expired status.
				}
			} catch (error) {
				result.errors.push({
					accountId,
					error: error instanceof Error ? error.message : "此邮箱暂时无法读取。",
				});
			}
		});
		await this.store.save(this.data);
		result.threads.sort((left, right) => (Date.parse(right.date) || 0) - (Date.parse(left.date) || 0));
		return result;
	}

	private async getThread(accountId: string, threadId: string): Promise<MailThread> {
		if (typeof threadId !== "string" || !/^[a-z0-9_-]{1,256}$/i.test(threadId)) throw new Error("邮件会话标识无效。");
		const account = this.account(accountId);
		this.requireCapability(account, "read");
		const thread = await this.gmail<GmailThread>(account, `/threads/${encodeURIComponent(threadId)}?format=full`);
		return parseThread(thread, accountId);
	}

	private async boundDraft(
		input: MailDraft,
		capability: "compose" | "send",
	): Promise<{ account: StoredMailAccount; draft: MailDraft; gmailThreadId?: string }> {
		const draft = validateDraft(input);
		const account = this.account(draft.accountId);
		this.requireCapability(account, capability);
		let gmailThreadId: string | undefined;
		if (draft.threadId) {
			const thread = await this.getThread(account.id, draft.threadId);
			const parent = draft.inReplyTo
				? thread.messages.find((message) => message.messageId === draft.inReplyTo)
				: thread.messages.at(-1);
			if (!parent) throw new Error("回复来源不属于此邮箱会话，请重新打开原邮件。");
			const [subject, parentSubject, originalSubject] = [draft.subject, parent.subject, thread.subject].map(
				(value) => value.replace(/^(?:\s*re\s*:\s*)+/i, "").trim(),
			);
			// Gmail requires matching subjects to join a thread. The UI retains the
			// original source binding even when an edited subject starts a new thread.
			if (subject === parentSubject || subject === originalSubject) gmailThreadId = draft.threadId;
			draft.inReplyTo = parent.messageId;
			draft.references =
				[
					...new Set([
						...(parent.references?.split(/\s+/).filter(Boolean) ?? []),
						...(parent.messageId ? [parent.messageId] : []),
					]),
				].join(" ") || undefined;
		} else if (draft.inReplyTo || draft.references) {
			throw new Error("回复邮件必须关联原邮箱会话。");
		}
		validateDraft(draft);
		return { account, draft, gmailThreadId };
	}

	private async saveDraft(input: MailDraft): Promise<MailDraft> {
		const { account, draft, gmailThreadId } = await this.boundDraft(input, "compose");
		// Refresh before the write and recheck scopes in case the grant changed.
		await this.accessToken(account);
		this.requireCapability(account, "compose");
		const saved = await this.gmail<{ id?: string }>(
			account,
			draft.id ? `/drafts/${encodeURIComponent(draft.id)}` : "/drafts",
			{
				method: draft.id ? "PUT" : "POST",
				body: JSON.stringify({
					message: {
						raw: buildMime(draft, account.email),
						...(gmailThreadId ? { threadId: gmailThreadId } : {}),
					},
				}),
			},
			false,
		);
		if (!saved.id) throw new Error("Gmail 草稿保存结果无法确认，请先查看 Gmail 草稿。");
		return { ...draft, id: saved.id };
	}

	private async prepareSend(input: MailDraft): Promise<MailSendConfirmation> {
		const { account, draft, gmailThreadId } = await this.boundDraft(input, "send");
		for (const [id, confirmation] of this.confirmations) {
			if (confirmation.expiresAt <= this.now()) this.confirmations.delete(id);
		}
		if (this.confirmations.size >= 100) throw new Error("待确认邮件过多，请完成已有发送确认。");
		const confirmationId = randomUUID();
		const expiresAt = this.now() + this.confirmationTtl;
		this.confirmations.set(confirmationId, {
			accountId: account.id,
			accountEmail: account.email,
			draft: structuredClone(draft),
			gmailThreadId,
			raw: buildMime(draft, account.email),
			expiresAt,
		});
		return {
			confirmationId,
			expiresAt: new Date(expiresAt).toISOString(),
			accountEmail: account.email,
			draft: structuredClone(draft),
		};
	}

	private async confirmSend(confirmationId: string): Promise<{ id: string; threadId?: string }> {
		const confirmation = this.confirmations.get(confirmationId);
		// Consume before any network work: uncertain responses can never reuse this ID.
		this.confirmations.delete(confirmationId);
		if (!confirmation || confirmation.expiresAt <= this.now())
			throw new Error("发送确认已过期或已使用，请重新查看完整邮件后确认。");
		const account = this.account(confirmation.accountId);
		if (account.email !== confirmation.accountEmail) throw new Error("发件账号已变更，请重新确认。");
		this.requireCapability(account, "send");
		await this.accessToken(account);
		this.requireCapability(account, "send");
		if (confirmation.draft.id) this.requireCapability(account, "compose");
		const message = {
			raw: confirmation.raw,
			...(confirmation.gmailThreadId ? { threadId: confirmation.gmailThreadId } : {}),
		};
		const sent = await this.gmail<{ id?: string; threadId?: string }>(
			account,
			confirmation.draft.id ? "/drafts/send" : "/messages/send",
			{
				method: "POST",
				// Google supports replacing a saved draft's MIME in drafts.send. This
				// sends the previewed content and removes the saved Gmail draft.
				body: JSON.stringify(confirmation.draft.id ? { id: confirmation.draft.id, message } : message),
			},
			false,
		);
		if (!sent.id) throw new Error("Gmail 发送结果无法确认，请先查看已发送邮件，避免重复发送。");
		return { id: sent.id, threadId: sent.threadId };
	}
}
