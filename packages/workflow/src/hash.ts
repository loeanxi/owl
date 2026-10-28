/** Deterministic input identity: canonical JSON, then 32-bit FNV-1a (matches ZCode's choice). */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

export function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function inputHash(value: unknown): string {
	return fnv1a(canonicalJson(value));
}
