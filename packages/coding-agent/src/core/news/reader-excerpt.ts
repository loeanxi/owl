import { createHash } from "node:crypto";
import { DOMParser } from "linkedom";
import {
	extractNewsArticleResponse,
	fetchNewsText,
	isNewsChallengeContent,
	type NewsFetchOptions,
	newsPlainText,
} from "./sources.ts";
import type { NewsMaterial } from "./types.ts";

export interface ReaderExcerptCacheEntry {
	excerpt: string | null;
	expiresAt: number;
}

export interface ReaderExcerptOptions extends NewsFetchOptions {
	/** Share one budget across a complete feed refresh, including concurrent sources. */
	budget: { remaining: number };
	readCache?: (key: string) => ReaderExcerptCacheEntry | null;
	writeCache?: (key: string, entry: ReaderExcerptCacheEntry) => void;
}

/** Fill missing publisher excerpts without generating text or retaining the full article. */
export async function enrichNewsReaderExcerpts(
	materials: NewsMaterial[],
	options: ReaderExcerptOptions,
): Promise<NewsMaterial[]> {
	const result = [...materials];
	const queue = materials.map((material, index) => ({ material, index }));
	await Promise.all(
		Array.from({ length: Math.min(2, queue.length) }, async () => {
			for (;;) {
				const entry = queue.shift();
				if (!entry || options.signal?.aborted) return;
				const { material, index } = entry;
				const current = newsPlainText(material.summary || material.body || "");
				// Short image captions are common in official feeds; useful short descriptions stay intact.
				if (current.length >= 24) continue;
				const key = createHash("sha256")
					.update(JSON.stringify([material.url, material.title, material.publishedAt ?? null]))
					.digest("hex");
				const cached = options.readCache?.(key);
				if (cached && cached.expiresAt > Date.now()) {
					if (cached.excerpt && cached.excerpt.length > current.length)
						result[index] = { ...material, summary: cached.excerpt };
					continue;
				}
				if (!(options.budget.remaining > 0)) continue;
				options.budget.remaining--;
				let excerpt: string | null = null;
				try {
					const response = await fetchNewsText(
						material.url,
						{ headers: { accept: "text/html,application/xhtml+xml" } },
						{
							...options,
							allowPrivateNetwork: false,
							timeoutMs: Math.min(5000, options.timeoutMs ?? 5000),
							maxBytes: Math.min(512 * 1024, options.maxBytes ?? 512 * 1024),
						},
					);
					if (
						response.status < 200 ||
						response.status >= 300 ||
						isNewsChallengeContent(response.text, response.headers) ||
						(response.headers["content-type"] &&
							!/text\/html|application\/xhtml\+xml/i.test(response.headers["content-type"]))
					)
						throw new Error("Publisher excerpt unavailable");
					const document = new DOMParser().parseFromString(response.text, "text/html");
					const metadata = [...document.querySelectorAll("meta")];
					for (const name of ["og:description", "description", "twitter:description"]) {
						const value = metadata
							.find(
								(node) => (node.getAttribute("property") || node.getAttribute("name"))?.toLowerCase() === name,
							)
							?.getAttribute("content");
						const text = value ? newsPlainText(value) : "";
						if (
							text.length >= 24 &&
							text.length > current.length &&
							text !== material.title &&
							!/^A blog post by .+ on Hugging Face\.?$/i.test(text)
						) {
							excerpt = text.slice(0, 600);
							break;
						}
					}
					if (!excerpt) {
						const text = newsPlainText(extractNewsArticleResponse(response).body);
						if (text.length >= 24 && text.length > current.length) excerpt = text.slice(0, 600);
					}
				} catch {
					// A blocked article never hides the already available feed card.
				}
				if (options.signal?.aborted) return;
				options.writeCache?.(key, {
					excerpt,
					expiresAt: Date.now() + (excerpt ? 7 * 86400000 : 2 * 3600000),
				});
				if (excerpt) result[index] = { ...material, summary: excerpt };
			}
		}),
	);
	return result;
}
