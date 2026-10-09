/**
 * Multi-account store for Cursor OAuth credentials.
 *
 * Owl auth.json still holds one active `cursor` credential (CredentialStore
 * contract). Extra accounts live in `cursor-accounts.json` beside auth.json;
 * switch copies the chosen account into the active `cursor` slot.
 */

import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { atomicWriteFileSync } from "../utils/atomic-file.ts";

export interface CursorAccountRecord {
	id: string;
	label: string;
	email?: string;
	access: string;
	refresh: string;
	expires: number;
	addedAt: string;
}

export interface CursorAccountsFile {
	activeId: string | null;
	accounts: CursorAccountRecord[];
}

export interface CursorAccountPublic {
	id: string;
	label: string;
	email?: string;
	active: boolean;
	expires: number;
}

function emptyStore(): CursorAccountsFile {
	return { activeId: null, accounts: [] };
}

export function cursorAccountsPath(agentDir: string): string {
	return join(agentDir, "cursor-accounts.json");
}

export function readCursorAccounts(agentDir: string): CursorAccountsFile {
	const path = cursorAccountsPath(agentDir);
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CursorAccountsFile>;
		const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter(isAccountRecord) : [];
		const activeId = typeof raw.activeId === "string" ? raw.activeId : null;
		return {
			activeId: activeId && accounts.some((a) => a.id === activeId) ? activeId : (accounts[0]?.id ?? null),
			accounts,
		};
	} catch {
		return emptyStore();
	}
}

function isAccountRecord(value: unknown): value is CursorAccountRecord {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.label === "string" &&
		typeof row.access === "string" &&
		typeof row.refresh === "string" &&
		typeof row.expires === "number" &&
		typeof row.addedAt === "string"
	);
}

export function writeCursorAccounts(agentDir: string, store: CursorAccountsFile): void {
	const path = cursorAccountsPath(agentDir);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	atomicWriteFileSync(path, `${JSON.stringify(store, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
}

function accountIdFromCredential(credential: OAuthCredential): string {
	if (typeof credential.accountId === "string" && credential.accountId) return credential.accountId;
	if (typeof credential.email === "string" && credential.email) return `email:${credential.email.toLowerCase()}`;
	// Fallback: stable-ish id from refresh token prefix
	return `tok:${credential.refresh.slice(0, 16)}`;
}

function labelFromCredential(credential: OAuthCredential, id: string): string {
	if (typeof credential.email === "string" && credential.email) return credential.email;
	return id.startsWith("email:") ? id.slice("email:".length) : `Cursor ${id.slice(0, 8)}`;
}

export function listCursorAccountsPublic(agentDir: string): CursorAccountPublic[] {
	const store = readCursorAccounts(agentDir);
	return store.accounts.map((account) => ({
		id: account.id,
		label: account.label,
		...(account.email ? { email: account.email } : {}),
		active: account.id === store.activeId,
		expires: account.expires,
	}));
}

/** Upsert a logged-in credential into the pool and mark it active. */
export function upsertCursorAccount(agentDir: string, credential: OAuthCredential): CursorAccountsFile {
	const store = readCursorAccounts(agentDir);
	const id = accountIdFromCredential(credential);
	const record: CursorAccountRecord = {
		id,
		label: labelFromCredential(credential, id),
		...(typeof credential.email === "string" && credential.email ? { email: credential.email } : {}),
		access: credential.access,
		refresh: credential.refresh,
		expires: credential.expires,
		addedAt: new Date().toISOString(),
	};
	const index = store.accounts.findIndex((entry) => entry.id === id);
	if (index >= 0)
		store.accounts[index] = { ...store.accounts[index], ...record, addedAt: store.accounts[index]!.addedAt };
	else store.accounts.push(record);
	store.activeId = id;
	writeCursorAccounts(agentDir, store);
	return store;
}

export function credentialFromAccount(account: CursorAccountRecord): OAuthCredential {
	return {
		type: "oauth",
		access: account.access,
		refresh: account.refresh,
		expires: account.expires,
		...(account.email ? { email: account.email } : {}),
		accountId: account.id,
	};
}

export function getActiveCursorAccount(agentDir: string): CursorAccountRecord | undefined {
	const store = readCursorAccounts(agentDir);
	if (!store.activeId) return undefined;
	return store.accounts.find((entry) => entry.id === store.activeId);
}

export function switchCursorAccount(agentDir: string, accountId: string): CursorAccountRecord {
	const store = readCursorAccounts(agentDir);
	const account = store.accounts.find((entry) => entry.id === accountId);
	if (!account) throw new Error(`未知 Cursor 账号：${accountId}`);
	store.activeId = accountId;
	writeCursorAccounts(agentDir, store);
	return account;
}

export function removeCursorAccount(agentDir: string, accountId: string): CursorAccountsFile {
	const store = readCursorAccounts(agentDir);
	store.accounts = store.accounts.filter((entry) => entry.id !== accountId);
	if (store.activeId === accountId) store.activeId = store.accounts[0]?.id ?? null;
	writeCursorAccounts(agentDir, store);
	return store;
}

/** Wipe the multi-account pool (e.g. when removing the Cursor provider). */
export function clearCursorAccounts(agentDir: string): void {
	writeCursorAccounts(agentDir, emptyStore());
}

/**
 * Keep `cursor-accounts.json` in sync when auth.json's active `cursor` OAuth
 * credential is written (login or token refresh). Without this, switching back
 * to an account after a refresh would restore a rotated-out refresh token.
 */
export function withCursorAccountSync(store: CredentialStore, agentDir: string): CredentialStore {
	return {
		read: (providerId, options) => store.read(providerId, options),
		list: (options) => store.list(options),
		async modify(providerId, fn, options) {
			const result = await store.modify(providerId, fn, options);
			if (providerId === "cursor" && result?.type === "oauth") {
				upsertCursorAccount(agentDir, result);
			}
			return result;
		},
		delete: (providerId, options) => store.delete(providerId, options),
	};
}
