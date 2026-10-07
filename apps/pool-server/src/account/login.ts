/**
 * 账号登录入口 —— 移植自 manager `AccountAuthorizationController`。
 * CURSOR / COPILOT / QODER 走官方 SDK 桥；CLAUDE 走 PKCE 粘贴；
 * TRAE 的可见浏览器登录依赖本机 Playwright，这里保持同一组 URL，并说明要在浏览器里完成。
 */
import type { Account, AccountStore } from "owl-pool";
import { BusinessError, GatewayFault } from "owl-pool";
import type { SdkBridgeManager } from "../gateway/sdk-bridge.ts";
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
}

const SDK = new Set(["CURSOR", "COPILOT", "QODER"]);

export class AccountLoginService {
	readonly #bridge: SdkBridgeManager;
	readonly #claude: ClaudeOauthLogin;
	readonly #jobs = new Map<string, StoredJob>();

	constructor(_accounts: AccountStore, bridge: SdkBridgeManager, claude: ClaudeOauthLogin) {
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
			};
			this.#jobs.set(account.id, job);
			return view(job);
		}
		if (!SDK.has(account.platform)) {
			throw BusinessError.of("account.loginUnsupported", `${account.platform} 没有浏览器登录流程`);
		}
		const client = await this.#bridge.clientFor(account);
		const job: StoredJob = {
			accountId: account.id,
			platform: account.platform,
			requestId: "",
			status: "PENDING",
			message: "正在等待官方登录",
			url: "",
			userCode: "",
			authenticated: false,
		};
		this.#jobs.set(account.id, job);
		const requestId = client.start("login", {}, (event) => {
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
			try {
				const client = await this.#bridge.clientFor(account);
				const live = await client.request("auth_status", {}, 20_000);
				const authenticated = live.authenticated === true;
				if (job !== undefined && !["FAILED", "COMPLETED", "CANCELLED"].includes(job.status)) {
					return view(job);
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
		const client = await this.#bridge.clientFor(account);
		const result = await client.request("cancel", { requestId: job?.requestId ?? jobId ?? "" }, 20_000);
		if (job !== undefined) {
			job.status = "CANCELLED";
			job.message = "登录已取消";
		}
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
		if (job === undefined || job.requestId.length === 0) {
			throw BusinessError.of("account.loginNotWaiting", "没有正在等待输入的登录");
		}
		const client = await this.#bridge.clientFor(account);
		await client.request("login_input", { requestId: job.requestId, text }, 20_000);
		return view(job);
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
