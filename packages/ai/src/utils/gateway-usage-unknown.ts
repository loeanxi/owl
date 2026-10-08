const UNKNOWN_USAGE_CODES = new Set([
	"upstream_timeout",
	"upstream_stream_idle_timeout",
	"upstream_stream_interrupted",
]);

function codeFromBody(body: unknown): string | undefined {
	if (typeof body === "string") {
		const start = body.indexOf("{");
		if (start < 0) return undefined;
		try {
			body = JSON.parse(body.slice(start));
		} catch {
			return undefined;
		}
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
	const record = body as Record<string, unknown>;
	const inner = record.error;
	const fields =
		inner !== null && typeof inner === "object" && !Array.isArray(inner)
			? (inner as Record<string, unknown>)
			: record;
	return fields.billing_state === "unknown" && typeof fields.code === "string" && UNKNOWN_USAGE_CODES.has(fields.code)
		? fields.code
		: undefined;
}

/** Only the gateway's explicit unknown-usage marker and allowlisted code make a request terminal. */
export function gatewayUsageUnknownCode(value: unknown): string | undefined {
	const direct = codeFromBody(value);
	if (direct) return direct;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const error = value as Record<string, unknown>;
	return codeFromBody(error.error) ?? codeFromBody(error.body);
}
