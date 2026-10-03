/**
 * Redact secret-shaped content from provider error messages.
 *
 * Error bodies from providers and relays surface in the conversation. A relay
 * may echo request headers — including the API key — inside its error body, so
 * every adapter passes response text through here before embedding it in a
 * thrown error, and also passes the live key so its exact value cannot survive
 * even in non-standard formats.
 * Ported from dsh-image-gen src/redact.ts (Apache-2.0).
 */
const REDACTED = "[REDACTED]"

const KEY_SHAPED_PATTERNS: readonly RegExp[] = [
	// OpenAI / DashScope style keys, e.g. sk-abc123...
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	// Google API keys, e.g. AIzaSy...
	/\bAIza[A-Za-z0-9_-]{10,}/g,
	// Authorization header values echoed by relays.
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	// echoed key/value pairs, e.g. "api_key": "..." or token=...
	/\b(?:api[_-]?key|apikey|token|secret)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
	// secret keywords followed directly by a quoted value, e.g. invalid token "..."
	/\b(?:api[_-]?key|apikey|token|secret)\s*["'][A-Za-z0-9._~+/=-]{8,}["']/gi,
]

/** Replace every occurrence of a known secret plus key-shaped values. */
export function redactSecrets(text: string, ...secrets: Array<string | undefined>): string {
	let redacted = text
	for (const secret of secrets) {
		// Very short values would mangle ordinary words if substituted blindly.
		if (secret !== undefined && secret.length >= 8) redacted = redacted.split(secret).join(REDACTED)
	}
	for (const pattern of KEY_SHAPED_PATTERNS) redacted = redacted.replace(pattern, REDACTED)
	return redacted
}
