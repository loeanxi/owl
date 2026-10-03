/**
 * File-backed token store for the Antigravity subscription account. Replaces
 * the DSH Credentials service of the upstream bundle: the blob lives in
 * `<agentDir>/image-gen-auth.json` (0600 where the OS honors it) and never
 * leaves the host process.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDirOf } from "../config.ts";
import { parseBlob, type SubscriptionBlob, serializeBlob } from "./blob.ts";

function authPath(): string {
	return join(agentDirOf(), "image-gen-auth.json");
}

/** Read the stored blob, or undefined when signed out or unreadable. */
export function readStoredBlob(): SubscriptionBlob | undefined {
	try {
		const raw = readFileSync(authPath(), "utf8");
		if (raw.trim().length === 0) return undefined;
		return parseBlob(raw);
	} catch {
		return undefined;
	}
}

/** Persist the blob; at least one token must be present. */
export function writeStoredBlob(blob: Partial<SubscriptionBlob>): void {
	const serialized = serializeBlob(blob);
	const dir = agentDirOf();
	mkdirSync(dir, { recursive: true });
	writeFileSync(authPath(), serialized, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(authPath(), 0o600);
	} catch {
		// Windows filesystems commonly ignore chmod; the user-profile ACL still applies.
	}
}

/** Sign out: remove the stored blob. Missing file counts as success. */
export function clearStoredBlob(): void {
	try {
		rmSync(authPath(), { force: true });
	} catch {
		// already gone
	}
}

/** True when a stored blob exists on disk. */
export function hasStoredBlob(): boolean {
	return existsSync(authPath());
}
