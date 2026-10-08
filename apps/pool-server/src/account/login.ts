/**
 * 账号登录入口 —— 移植自 manager `AccountAuthorizationController`。
 * CURSOR / COPILOT / QODER 走官方 SDK 桥；CLAUDE 走 PKCE 粘贴；
 * TRAE 的可见浏览器登录依赖本机 Playwright，这里保持同一组 URL，并说明要在浏览器里完成。
 */
import type { Account, AccountStore } from "owl-pool";
import { BusinessError, GatewayFault, parseCredentials } from "owl-pool";
import type { SdkBridgeManager } from "../gateway/sdk-bridge.ts";
import type { SdkRuntimeClient } from "../gateway/sdk-runtime.ts";
import type { ClaudeOauthLogin } from "./claude-oauth.ts";

export interface LoginJob {
	id: string;
	status: string;
	message: string;
	url?: string;
	userCode?: string;
	authorizeUrl?: string;
	authenticated?: boolean;
}

interface StoredJob {
	accountId: string;
	platform: string;
	requestId: string;
	status: string;
	message: string;
	url: string;
	userCode: string;
	authenticated: boolean;
	expectedCredentials: string;
}

const SDK = new Set(["CURSOR", "COPILOT", "QODER"]);

export class AccountLoginService {
	readonly #accounts: AccountStore;
	readonly #bridge: SdkBridgeManager;
	readonly #claude: ClaudeOauthLogin;
	readonly #jobs = new Map<string, StoredJob>();

	constructor(accounts: AccountStore, bridge: SdkBridgeManager, claude: ClaudeOauthLogin) {
		this.#accounts = accounts;
		this.#bridge = bridge;
		this.#claude = claude;
	}

	async login(account: Account): Promise<Record<string, unknown>> {
		if (account.platform === "CLAUDE") {
			const started = this.#claude.login(account.id);
			return { authenticated: false, login: started, ...started };
		}
		if (account.platform === "TRAE") {
			const job: StoredJob = {
				accountId: account.id,
				platform: "TRAE",
				requestId: `trae-${account.id}`,
				status: "FAILED",
				message: "Trae 请在独立浏览器窗口完成登录后，把新的 session 写入账号。当前服务没有内嵌浏览器。",
				url: "https://www.trae.cn/",
				userCode: "",
				authenticated: false,
				expectedCredentials: JSON.stringify(parseCredentials(account)),
			};
			this.#jobs.set(account.id, job);
			return view(job);
		}
		if (!SDK.has(account.platform)) {
			throw BusinessError.of("account.loginUnsupported", `${account.platform} 没有浏览器登录流程`);
		}
		const expectedCredentials = JSON.stringify(parseCredentials(account));
		const existing = this.#jobs.get(account.id);
		if (
			existing?.status === "PENDING" &&
			existing.expectedCredentials === expectedCredentials &&
			this.#current(existing)
		) {
			return view(existing);
		}
		const job: StoredJob = {
			accountId: account.id,
			platform: account.platform,
			requestId: "",
			status: "PENDING",
			message: "正在等待官方登录",
			url: "",
			userCode: "",
			authenticated: false,
			expectedCredentials,
		};
		this.#jobs.set(account.id, job);
		let client: SdkRuntimeClient;
		try {
			client = await this.#bridge.clientFor(account);
		} catch (error) {
			job.status = "FAILED";
			job.message = "登录组件不可用，请重试";
			throw error;
		}
		if (job.status !== "PENDING" || !this.#current(job)) return view(job);
		const requestId = client.start("login", {}, (event) => {
			// A cancelled/replaced request may still deliver its final SDK event.
			if (job.status !== "PENDING" || !this.#current(job)) return;
			if (typeof event.url === "string") {
				job.url = event.url;
			}
			if (typeof event.userCode === "string") {
				job.userCode = event.userCode;
			}
			if (event.event === "error") {
				job.status = "FAILED";
				job.message = typeof event.message === "string" ? event.message : "登录失败";
			} else if (event.event === "result") {
				const data =
					event.data !== null && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
				job.authenticated = data.authenticated === true;
				if (job.authenticated && data.credentialSource === "ACCOUNT_HOME" && data.sdkAuthenticated !== false) {
					this.#authenticated(account, "ACCOUNT_HOME", job.expectedCredentials);
					job.expectedCredentials = JSON.stringify(parseCredentials(this.#accounts.require(account.id)));
				}
				job.status = job.authenticated ? "COMPLETED" : "FAILED";
				job.message =
					typeof data.message === "string" ? data.message : job.authenticated ? "登录完成" : "登录未完成";
				if (typeof data.url === "string") {
					job.url = data.url;
				}
				if (typeof data.userCode === "string") {
					job.userCode = data.userCode;
				}
			}
		});
		job.requestId = requestId;
		return view(job);
	}

	async status(account: Account): Promise<Record<string, unknown>> {
		if (account.platform === "CLAUDE") {
			const current = this.#claude.status(account.id);
			return { authenticated: current.authenticated === true, login: current, ...current };
		}
		if (SDK.has(account.platform)) {
			const job = this.#jobs.get(account.id);
			if (job?.status === "CANCELLED" || (job?.status === "PENDING" && !this.#current(job))) return view(job);
			if (job?.status === "PENDING" && !job.requestId) return view(job);
			const expectedCredentials = JSON.stringify(parseCredentials(account));
			try {
				const client = await this.#bridge.clientFor(account);
				const live = await client.request("auth_status", {}, 20_000);
				const current = this.#accounts.get(account.id);
				if (
					current?.platform !== account.platform ||
					JSON.stringify(parseCredentials(current)) !== expectedCredentials
				) {
					// A login result can persist its own marker while this status request is in flight.
					if (job?.status === "COMPLETED" && this.#current(job)) return view(job);
					if (job?.status === "PENDING") this.#current(job);
					return {
						authenticated: false,
						login: { status: "CANCELLED", message: "账号凭证已变更，请重新发起授权" },
					};
				}
				const authenticated =
					live.authenticated === true && (account.platform !== "CURSOR" || live.sdkAuthenticated === true);
				if (job?.status === "CANCELLED") return view(job);
				if (job !== undefined && !["FAILED", "COMPLETED", "CANCELLED"].includes(job.status)) {
					return view(job);
				}
				// Desktop balance queries are separate from this account's SDK login.
				if (
					live.sdkAuthenticated === true &&
					(live.credentialSource === "ACCOUNT_HOME" || live.credentialSource === "ACCOUNT_TOKEN")
				) {
					this.#authenticated(account, live.credentialSource, expectedCredentials, false);
				}
				return {
					authenticated,
					login: {
						status: authenticated ? "COMPLETED" : "FAILED",
						message:
							typeof live.message === "string" ? live.message : authenticated ? "官方登录状态有效" : "尚未登录",
					},
				};
			} catch (error) {
				if (job !== undefined) {
					return view(job);
				}
				throw error instanceof GatewayFault
					? error
					: new GatewayFault(
							502,
							"runtime_unavailable",
							error instanceof Error ? error.message : "登录状态不可用",
						);
			}
		}
		const job = this.#jobs.get(account.id);
		return job === undefined
			? { authenticated: false, login: { status: "FAILED", message: "没有进行中的登录" } }
			: view(job);
	}

	async cancel(account: Account, jobId: string | null): Promise<Record<string, unknown>> {
		if (account.platform === "CLAUDE") {
			this.#claude.cancel(account.id);
			return { cancelled: true };
		}
		if (account.platform === "TRAE") {
			if (jobId === null || jobId.length === 0) {
				throw BusinessError.of("trae_login_job_required", "取消 Trae 登录需要 jobId");
			}
			this.#jobs.delete(account.id);
			return { cancelled: true };
		}
		const job = this.#jobs.get(account.id);
		if (job !== undefined) {
			// Mark before awaiting the bridge so an in-flight result cannot undo cancellation.
			job.status = "CANCELLED";
			job.authenticated = false;
			job.message = "登录已取消";
		}
		const client = await this.#bridge.clientFor(account);
		const result = await client.request("cancel", { requestId: job?.requestId ?? jobId ?? "" }, 20_000);
		return {
			cancelled: result.cancelled === true,
			login: job === undefined ? { status: "CANCELLED" } : view(job).login,
		};
	}

	async input(account: Account, text: string): Promise<Record<string, unknown>> {
		if (account.platform === "TRAE") {
			throw BusinessError.of("unsupported_login_input", "Trae 请在独立浏览器窗口完成登录");
		}
		if (account.platform === "CLAUDE") {
			await this.#claude.input(account.id, text);
			return this.status(account);
		}
		const job = this.#jobs.get(account.id);
		if (job === undefined || job.status !== "PENDING" || !this.#current(job) || job.requestId.length === 0) {
			throw BusinessError.of("account.loginNotWaiting", "没有正在等待输入的登录");
		}
		const client = await this.#bridge.clientFor(account);
		if (job.status !== "PENDING" || !this.#current(job)) {
			throw BusinessError.of("account.loginNotWaiting", "没有正在等待输入的登录");
		}
		await client.request("login_input", { requestId: job.requestId, text }, 20_000);
		return view(job);
	}

	#current(job: StoredJob): boolean {
		if (this.#jobs.get(job.accountId) !== job) return false;
		const current = this.#accounts.get(job.accountId);
		if (current?.platform === job.platform && JSON.stringify(parseCredentials(current)) === job.expectedCredentials) {
			return true;
		}
		job.status = "CANCELLED";
		job.authenticated = false;
		job.message = "账号凭证已变更，请重新发起授权";
		return false;
	}

	#authenticated(account: Account, source: string, expectedCredentials: string, recordSource = true): void {
		const current = this.#accounts.get(account.id);
		if (current?.platform !== account.platform || JSON.stringify(parseCredentials(current)) !== expectedCredentials)
			return;
		if (recordSource && source === "ACCOUNT_HOME" && parseCredentials(current).authSource !== source) {
			this.#accounts.updateFields(
				account.id,
				{ credentials: { ...parseCredentials(current), authSource: source } },
				Date.now(),
			);
		}
		this.#accounts.patchState(account.id, {
			credentialStatus: "OK",
			credentialCheckedAt: Date.now(),
			credentialExpiresAt: null,
			credentialMessage: "官方 SDK 登录状态有效",
		});
	}
}

function view(job: StoredJob): Record<string, unknown> {
	const login = {
		id: job.requestId,
		status: job.status,
		message: job.message,
		url: job.url,
		userCode: job.userCode,
		authorizeUrl: job.url,
	};
	return { authenticated: job.authenticated, message: job.message, login, job: login };
}
