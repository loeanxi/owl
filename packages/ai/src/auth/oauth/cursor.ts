/**
 * Cursor subscription OAuth (loginDeepControl + poll).
 *
 * Flow mirrors community pi-cursor / oh-my-pi clients:
 * 1. PKCE challenge + uuid → https://cursor.com/loginDeepControl
 * 2. Poll https://api2.cursor.sh/auth/poll until tokens arrive
 * 3. Refresh via https://api2.cursor.sh/auth/exchange_user_api_key
 *
 * Unofficial wire protocol — Cursor may change endpoints without notice.
 */

import { sleep } from "../../utils/sleep.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { generatePKCE } from "./pkce.ts";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const CURSOR_PROFILE_URL = "https://cursor.com/api/auth/me";
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;
const REQUEST_TIMEOUT_MS = 15_000;

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

function getTokenExpiry(token: string): number {
	try {
		const parts = token.split(".");
		const payload = parts[1];
		if (!payload) return Date.now() + 3600_000;
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
		if (typeof decoded.exp === "number") return decoded.exp * 1000 - 5 * 60 * 1000;
	} catch {
		// fall through
	}
	return Date.now() + 3600_000;
}

function extractUserId(accessToken: string): string | undefined {
	try {
		const parts = accessToken.split(".");
		const payload = parts[1];
		if (!payload) return undefined;
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
			sub?: string;
			userId?: string;
		};
		if (typeof decoded.sub === "string" && decoded.sub) return decoded.sub;
		if (typeof decoded.userId === "string" && decoded.userId) return decoded.userId;
	} catch {
		// ignore
	}
	return undefined;
}

async function fetchAccountEmail(accessToken: string, signal: AbortSignal): Promise<string | undefined> {
	const userId = extractUserId(accessToken);
	if (!userId) return undefined;
	try {
		const response = await fetch(CURSOR_PROFILE_URL, {
			headers: {
				Accept: "application/json",
				Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
			},
			signal: requestSignal(signal),
		});
		if (!response.ok) return undefined;
		const json = (await response.json()) as { email?: string };
		return typeof json.email === "string" && json.email ? json.email : undefined;
	} catch {
		return undefined;
	}
}

function parseTokenResponse(value: unknown, endpoint: string): { accessToken: string; refreshToken?: string } {
	if (!value || typeof value !== "object") {
		throw new Error(`${endpoint} returned an invalid token response`);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.accessToken !== "string" || !record.accessToken.trim()) {
		throw new Error(`${endpoint} returned no access token`);
	}
	if (record.refreshToken !== undefined && typeof record.refreshToken !== "string") {
		throw new Error(`${endpoint} returned an invalid refresh token`);
	}
	return {
		accessToken: record.accessToken,
		...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {}),
	};
}

async function pollForTokens(
	uuid: string,
	verifier: string,
	signal: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY_MS;
	let consecutiveErrors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await sleep(delay, signal);

		try {
			const response = await fetch(
				`${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
				{
					signal: requestSignal(signal),
				},
			);

			if (response.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
				continue;
			}

			if (response.ok) {
				const data = parseTokenResponse(await response.json(), "Cursor authentication polling");
				if (!data.refreshToken) {
					throw new Error("Cursor authentication polling returned no refresh token");
				}
				return { accessToken: data.accessToken, refreshToken: data.refreshToken };
			}

			throw new Error(`Cursor auth poll failed (HTTP ${response.status})`);
		} catch (error) {
			if (signal.aborted) throw new Error("Login cancelled");
			consecutiveErrors += 1;
			if (consecutiveErrors >= 3) {
				throw new Error(
					`Cursor authentication polling failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	throw new Error("Cursor authentication polling timeout");
}

async function refreshCursorCredential(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credential.refresh}`,
			"Content-Type": "application/json",
		},
		body: "{}",
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Cursor token refresh failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
	}
	const data = parseTokenResponse(await response.json(), "Cursor token refresh");
	const access = data.accessToken;
	const nextRefresh = data.refreshToken || credential.refresh;
	const email = (await fetchAccountEmail(access, signal)) ?? credential.email;
	const accountId = extractUserId(access) ?? credential.accountId;
	return {
		type: "oauth",
		access,
		refresh: nextRefresh,
		expires: getTokenExpiry(access),
		...(email ? { email } : {}),
		...(accountId ? { accountId } : {}),
	};
}

async function loginCursor(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();
	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});
	const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;

	interaction.notify({
		type: "auth_url",
		url: loginUrl,
		instructions: "在浏览器中登录 Cursor 账号以授权 Owl。",
	});
	interaction.notify({ type: "progress", message: "等待浏览器完成 Cursor 登录…" });

	const { accessToken, refreshToken } = await pollForTokens(uuid, verifier, interaction.signal);
	const email = await fetchAccountEmail(accessToken, interaction.signal);
	return {
		type: "oauth",
		access: accessToken,
		refresh: refreshToken,
		expires: getTokenExpiry(accessToken),
		...(email ? { email } : {}),
		...(extractUserId(accessToken) ? { accountId: extractUserId(accessToken) } : {}),
	};
}

export const cursorOAuth: OAuthAuth = {
	name: "Cursor",
	isSubscription: true,
	loginLabel: "Sign in with Cursor",
	login: loginCursor,
	refresh: (credential, signal) => refreshCursorCredential(credential, signal),
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
