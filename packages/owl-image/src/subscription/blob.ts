/**
 * OAuth token blob persistence for the Antigravity subscription account.
 * Adapted from dsh-image-gen src/subscription/blob.ts (Apache-2.0), which
 * adapts @goodandready/dsh-subscriptions (MIT).
 */

function asString(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

/** Everything the vendor needs to call its API plus display identity. */
export interface SubscriptionBlob {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms when the access token stops working; 0 when unknown. */
	expiresAt: number;
	label: string;
	email: string;
	/** Antigravity 托管项目 id(项目引导成功后持久化,跨会话复用,免重复引导)。 */
	projectId?: string;
}

/** Serialize a blob for storage; at least one token must be present. */
export function serializeBlob(obj: Partial<SubscriptionBlob>): string {
	const accessToken = asString(obj.accessToken);
	const refreshToken = asString(obj.refreshToken);
	if (accessToken.length === 0 && refreshToken.length === 0) {
		throw new Error("oauth blob needs accessToken or refreshToken");
	}
	const projectId = asString(obj.projectId);
	return JSON.stringify({
		accessToken,
		refreshToken,
		expiresAt: Number(obj.expiresAt) || 0,
		label: asString(obj.label),
		email: asString(obj.email),
		...(projectId.length > 0 ? { projectId } : {}),
	});
}

/** Parse a stored blob back; invalid input throws. */
export function parseBlob(text: string): SubscriptionBlob {
	const obj: unknown = typeof text === "string" ? JSON.parse(text) : text;
	if (typeof obj !== "object" || obj === null) throw new Error("invalid oauth blob");
	const row = obj as Record<string, unknown>;
	return {
		accessToken: asString(row.accessToken),
		refreshToken: asString(row.refreshToken),
		expiresAt: Number(row.expiresAt) || 0,
		label: asString(row.label),
		email: asString(row.email),
		...(typeof row.projectId === "string" && row.projectId.length > 0 ? { projectId: row.projectId } : {}),
	};
}
