/**
 * Model used for compaction summaries and cross-session memory extraction.
 * An unset or unresolvable configuration keeps `fallback` (the session model).
 */
export function resolveHarnessModel<T>(
	configured: { provider?: string; modelId?: string } | undefined,
	getModel: (provider: string, modelId: string) => T | undefined,
	fallback: T,
): T {
	const provider = configured?.provider?.trim();
	const modelId = configured?.modelId?.trim();
	if (!provider || !modelId) return fallback;
	return getModel(provider, modelId) ?? fallback;
}
