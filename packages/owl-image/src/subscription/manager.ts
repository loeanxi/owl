/**
 * Antigravity subscription account manager: login flow (PKCE loopback),
 * token refresh with single-flight locking, and image generation on the
 * logged-in account. Trimmed from dsh-image-gen src/subscription/manager.ts
 * (Apache-2.0) to the google-sub vendor only; blob storage goes through the
 * local file store instead of the DSH Credentials service.
 *
 * Isolation invariants carried over from upstream:
 * - The OAuth blob lives under the auth file, never an API-key location, and
 *   the API-key paths never consult subscription state.
 * - Login/logout changes nothing except this vendor's own blob.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDirOf } from "../config.ts";
import { parseBlob, type SubscriptionBlob } from "./blob.ts";
import { startLoopback } from "./loopback.ts";
import { createPkce, type Pkce } from "./oauth.ts";
import { clearStoredBlob, writeStoredBlob } from "./store.ts";
import {
	ANTIGRAVITY_REDIRECT_URI,
	antigravityAuthorizeUrl,
	antigravityConfig,
	antigravityExchangeCode,
	antigravityGenerateImage,
	antigravityRefresh,
	antigravityResolveProject,
} from "./vendors/antigravity.ts";

/** Reference image passed to edit calls. */
export interface SubscriptionReferenceImage {
	data: Uint8Array;
	mediaType: string;
}

/** Reference images per edit call (Antigravity accepts up to 10; shared guard keeps 5). */
export const SUBSCRIPTION_MAX_REFERENCE_IMAGES = 5;

/** Login status for the status command. */
export type SubscriptionLoginStatus = { state: "logged-in"; email: string } | { state: "logged-out" };

/**
 * Per-application manager instance. Owns the pending-login session (PKCE
 * state) and the refresh lock; nothing here is persisted except the blob.
 */
export class SubscriptionManager {
	private pending: { pkce: Pkce } | undefined;
	private refreshLock: Promise<SubscriptionBlob> | undefined;
	/** Antigravity needs a per-account project id on every generation call. */
	private readonly projectCache = new Map<string, string>();

	/** Read the stored blob, or undefined when signed out. */
	readBlob(): SubscriptionBlob | undefined {
		try {
			const raw = readStoredBlobText();
			if (raw === undefined || raw.trim().length === 0) return undefined;
			return parseBlob(raw);
		} catch {
			return undefined;
		}
	}

	loginStatus(): SubscriptionLoginStatus {
		const blob = this.readBlob();
		if (blob === undefined) return { state: "logged-out" };
		return { state: "logged-in", email: blob.email };
	}

	/**
	 * Begin a login: register the PKCE state, start the loopback catch server
	 * on the vendor-fixed redirect port, and return the authorize URL for the
	 * browser to open. Completion lands in the loopback callback.
	 */
	async beginLogin(): Promise<{ url: string }> {
		const pkce = await createPkce();
		this.pending = { pkce };
		const url = antigravityAuthorizeUrl(antigravityConfig(), pkce);
		// The catch server must be listening before the browser opens, otherwise
		// the redirect to localhost:<port> hits a dead port and the login hangs.
		startLoopback({
			redirectUri: ANTIGRAVITY_REDIRECT_URI,
			onCode: async (params) =>
				await this.completeLoginFromCallback(params.get("code") ?? "", params.get("state") ?? ""),
		}).catch(() => {
			/* the login result surfaces through /image-status; nothing to do here */
		});
		return { url };
	}

	/** Loopback callback: validate state, exchange the code, store the blob. */
	private async completeLoginFromCallback(code: string, state: string): Promise<string> {
		if (code.length === 0) throw new Error("callback carried no authorization code");
		const row = this.pending;
		if (row === undefined || row.pkce.state !== state) throw new Error("login session expired; start again");
		this.pending = undefined;
		const blob = await antigravityExchangeCode(antigravityConfig(), row.pkce, code);
		this.saveBlob(blob);
		const email = escapeHtml(blob.email);
		return `<!doctype html><meta charset="utf-8"><title>owl-image</title><p lang="zh-CN">Google 订阅登录成功（${email}），可以关闭此页回到 Owl。</p><p lang="en">Google subscription sign-in successful (${email}). You can close this page and return to Owl.</p>`;
	}

	/** Sign out: clear the blob and the caches. No other setting changes. */
	logout(): void {
		clearStoredBlob();
		this.projectCache.clear();
	}

	private saveBlob(blob: SubscriptionBlob): void {
		writeStoredBlob(blob);
	}

	/**
	 * Return a blob whose access token is usable; refreshes first when the
	 * stored one is expired (or expiring within the skew window). Single-flight
	 * so concurrent generate calls share one refresh.
	 */
	async ensureFresh(): Promise<SubscriptionBlob> {
		const blob = this.readBlob();
		if (blob === undefined) throw new Error("Google 订阅（Antigravity）未登录：请先执行 /image-login 完成登录");
		if (blob.refreshToken.length === 0) return blob;
		const SKEW_MS = 60_000;
		if (blob.expiresAt !== 0 && blob.expiresAt - SKEW_MS > Date.now()) return blob;
		const inflight = this.refreshLock;
		if (inflight !== undefined) return inflight;
		const refresh = (async () => {
			const next = await antigravityRefresh(blob);
			const merged: SubscriptionBlob = {
				...next,
				refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
			};
			this.saveBlob(merged);
			return merged;
		})().finally(() => {
			this.refreshLock = undefined;
		});
		this.refreshLock = refresh;
		return refresh;
	}

	/** Generate one image through the logged-in account; b64 reply decoded host-side. */
	async generate(options: {
		prompt: string;
		size?: string;
		quality?: string;
		referenceImages?: ReadonlyArray<SubscriptionReferenceImage>;
		signal?: AbortSignal;
		proxy?: string;
	}): Promise<{ b64: string }> {
		const session = await this.ensureFresh();
		const text = options.prompt.trim();
		if (text.length === 0) throw new Error("prompt must be a non-empty string");
		const references = options.referenceImages ?? [];
		if (references.length > SUBSCRIPTION_MAX_REFERENCE_IMAGES) {
			throw new Error(
				`订阅生图最多支持 ${String(SUBSCRIPTION_MAX_REFERENCE_IMAGES)} 张参考图，当前 ${String(references.length)} 张`,
			);
		}
		const projectId = await this.ensureAntigravityProject(session);
		const aspectRatio = antigravityAspectRatioOf(options.size);
		const result = await antigravityGenerateImage({
			blob: session,
			projectId,
			prompt: text,
			...(aspectRatio !== undefined ? { aspectRatio } : {}),
			hd: options.quality === "hd" || options.quality === "high",
			...(references.length > 0 ? { referenceImages: references } : {}),
			...(options.signal !== undefined ? { signal: options.signal } : {}),
			...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
		});
		return { b64: result.b64 };
	}

	/**
	 * Resolve (and cache per refresh token) the managed project id the
	 * Antigravity generation envelope needs. Re-resolved when the account
	 * signs out or a different account logs in.
	 */
	private async ensureAntigravityProject(blob: SubscriptionBlob): Promise<string> {
		const cacheKey = blob.refreshToken.length > 0 ? blob.refreshToken : blob.accessToken.slice(0, 32);
		const cached = this.projectCache.get(cacheKey);
		if (cached !== undefined) return cached;
		const projectId = await antigravityResolveProject(blob);
		this.projectCache.set(cacheKey, projectId);
		return projectId;
	}
}

/** Map an OpenAI-style size onto the aspect ratio Antigravity accepts (upstream manager logic). */
export function antigravityAspectRatioOf(size: string | undefined): string | undefined {
	const table: Record<string, string> = {
		"1024x1024": "1:1",
		"1024x1536": "2:3",
		"1536x1024": "3:2",
		"768x1398": "9:16",
		"1398x768": "16:9",
	};
	if (size === undefined) return undefined;
	// `auto` means the model picks; omitting imageConfig.aspectRatio entirely
	// is the only way to express that, so no ratio is forwarded.
	if (size === "auto") return undefined;
	const mapped = table[size];
	if (mapped !== undefined) return mapped;
	// Already a ratio like 16:9 passes through; anything else falls back to 1:1.
	return /^\d+:\d+$/.test(size) ? size : "1:1";
}

function readStoredBlobText(): string | undefined {
	try {
		return readFileSync(join(agentDirOf(), "image-gen-auth.json"), "utf8");
	} catch {
		return undefined;
	}
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
	);
}
