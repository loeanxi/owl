/** OpenAI Images API and compatible response adapter. Ported from dsh-image-gen src/openai-compatible.ts (Apache-2.0). */
import { doFetch } from "./config.ts";
import {
	detectImageMediaType,
	extensionOf,
	type GeneratedImage,
	type ImageMediaType,
	imageMediaTypeOf,
} from "./media.ts";
import { redactSecrets } from "./redact.ts";
import { type ArkOutputOptions, arkOutputBody } from "./shared.ts";

const ERROR_LIMIT = 4096;

export interface CompatibleReferenceImage {
	data: Uint8Array;
	mediaType: ImageMediaType;
}

export interface OpenAICompatibleInput {
	proxy?: string;
}

export async function generateOpenAICompatibleImage(input: {
	provider: "openai" | "openai-compat" | "seedream" | "xai" | "zhipu";
	apiKey: string;
	baseURL: string;
	model: string;
	prompt: string;
	/**
	 * Pixel size or tier string. Optional because not every channel accepts
	 * `size` at all — xAI takes aspect_ratio+resolution via `extraBody` and
	 * simply ignores unknown fields, so the parameter is omitted for it.
	 */
	size?: string;
	/** Vendor quality tier (e.g. OpenAI low/medium/high); omitted when unset. */
	quality?: string;
	/** Extra JSON fields merged last into the generations body (xAI aspect_ratio/resolution). */
	extraBody?: Readonly<Record<string, unknown>>;
	maxBytes: number;
	signal: AbortSignal;
	/** Ark-only output controls; ignored by every other provider. */
	arkOptions?: ArkOutputOptions;
	proxy?: string;
}): Promise<GeneratedImage> {
	const response = await doFetch(
		imageEndpoint(input.baseURL, "generations"),
		{
			method: "POST",
			redirect: "error",
			signal: input.signal,
			headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: input.model,
				prompt: input.prompt,
				...(input.size === undefined ? {} : { size: input.size }),
				...(input.quality === undefined ? {} : { quality: input.quality }),
				// `background: false` — Ark rejects `transparent` on this endpoint
				// outright (it needs exactly one input image), so it is the edit path's
				// option alone.
				...(input.provider === "seedream"
					? { response_format: "url", ...arkOutputBody(input.arkOptions, { background: false }) }
					: {}),
				...(input.extraBody ?? {}),
			}),
		},
		input.proxy,
	);
	return parseImageResponse(response, input.provider, input);
}

/** How the edits endpoint expects its request body. */
export type CompatEditFormat = "multipart" | "jsonImageUrlArray" | "formReferenceImages" | "xaiJson";

export async function editOpenAICompatibleImage(input: {
	apiKey: string;
	baseURL: string;
	model: string;
	prompt: string;
	sourceImages: CompatibleReferenceImage[];
	size?: string;
	maxBytes: number;
	signal: AbortSignal;
	/**
	 * Request shape for the edits call. Most OpenAI-compatible channels take
	 * the standard multipart form; some (e.g. SenseNova) accept OpenAI's
	 * generations endpoint but run edits on their own JSON contract.
	 */
	editFormat?: CompatEditFormat;
	/** Channel-specific extra fields merged into the JSON edit body last. Ignored in multipart mode. */
	editExtra?: Readonly<Record<string, unknown>>;
	/** Vendor quality tier sent with the edit request when set. */
	quality?: string;
	/** Extra fields for the edit request, e.g. xAI's aspect_ratio/resolution pair. */
	extraBody?: Readonly<Record<string, unknown>>;
	proxy?: string;
}): Promise<GeneratedImage> {
	if (input.editFormat === "xaiJson") {
		const references = input.sourceImages.map((image) => ({ type: "image_url", url: toDataUrl(image) }));
		const response = await doFetch(
			imageEndpoint(input.baseURL, "edits"),
			{
				method: "POST",
				redirect: "error",
				signal: input.signal,
				headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: input.model,
					prompt: input.prompt,
					...(references.length === 1 ? { image: references[0] } : { images: references }),
					...(input.quality === undefined ? {} : { quality: input.quality }),
					...(input.extraBody ?? {}),
				}),
			},
			input.proxy,
		);
		return parseImageResponse(response, "xai", input);
	}
	if (input.editFormat === "jsonImageUrlArray") {
		const body = {
			model: input.model,
			images: input.sourceImages.map((sourceImage) => ({ image_url: toDataUrl(sourceImage) })),
			prompt: input.prompt,
			n: 1,
			// Channels of this shape (SenseNova) document `size: "auto"` as the
			// only accepted value on the edits endpoint, so the caller's
			// generation size is deliberately NOT forwarded here. editExtra
			// (merged last) can still override it for other channels.
			size: "auto" as const,
			response_format: "url",
			...(input.quality === undefined ? {} : { quality: input.quality }),
			...(input.editExtra ?? {}),
			...(input.extraBody ?? {}),
		};
		const response = await doFetch(
			imageEndpoint(input.baseURL, "edits"),
			{
				method: "POST",
				redirect: "error",
				signal: input.signal,
				headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			},
			input.proxy,
		);
		return parseImageResponse(response, "openai", input);
	}
	if (input.editFormat === "formReferenceImages") {
		// Some relays take edits as a multipart form whose `reference_images`
		// field is a JSON array of base64 strings instead of file uploads.
		const form = new FormData();
		form.append("model", input.model);
		form.append("prompt", input.prompt);
		if (input.size !== undefined && input.size.length > 0) form.append("size", input.size);
		if (input.quality !== undefined) form.append("quality", input.quality);
		for (const [key, value] of Object.entries(input.extraBody ?? {})) form.append(key, String(value));
		form.append("response_format", "b64_json");
		form.append(
			"reference_images",
			JSON.stringify(input.sourceImages.map((sourceImage) => Buffer.from(sourceImage.data).toString("base64"))),
		);
		const response = await doFetch(
			imageEndpoint(input.baseURL, "edits"),
			{
				method: "POST",
				redirect: "error",
				signal: input.signal,
				headers: { authorization: `Bearer ${input.apiKey}` },
				body: form,
			},
			input.proxy,
		);
		return parseImageResponse(response, "openai", input);
	}
	const form = new FormData();
	const imageField = input.sourceImages.length > 1 ? "image[]" : "image";
	input.sourceImages.forEach((sourceImage, index) => {
		const uploadBytes = new Uint8Array(sourceImage.data);
		const blob = new Blob([uploadBytes], { type: sourceImage.mediaType });
		const filename = `reference-${index + 1}.${extensionOf(sourceImage.mediaType)}`;
		form.append(imageField, blob, filename);
	});
	form.append("prompt", input.prompt);
	form.append("model", input.model);
	if (input.size !== undefined && input.size.length > 0) form.append("size", input.size);
	if (input.quality !== undefined) form.append("quality", input.quality);
	for (const [key, value] of Object.entries(input.extraBody ?? {})) form.append(key, String(value));

	const response = await doFetch(
		imageEndpoint(input.baseURL, "edits"),
		{
			method: "POST",
			redirect: "error",
			signal: input.signal,
			headers: { authorization: `Bearer ${input.apiKey}` },
			body: form,
		},
		input.proxy,
	);
	return parseImageResponse(response, "openai", input);
}

async function parseImageResponse(
	response: Response,
	provider: string,
	input: { maxBytes: number; signal: AbortSignal; apiKey?: string; proxy?: string },
): Promise<GeneratedImage> {
	const text = await readBoundedText(response, Math.ceil(input.maxBytes * 1.4) + ERROR_LIMIT);
	if (!response.ok)
		throw new Error(
			`${provider} image request failed (${response.status}): ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`,
		);
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`${provider} image request returned invalid JSON`);
	}
	const image = firstImage(payload);
	if (image === undefined)
		throw new Error(
			`${provider} image request returned no image: ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`,
		);
	if (image.b64_json !== undefined) {
		// Relays may omit mime_type while returning non-PNG bytes (Ark jpeg), so
		// sniff before trusting the header.
		const data = decodeBase64(image.b64_json, provider);
		return { data, mediaType: detectImageMediaType(data) ?? imageMediaTypeOf(image.mime_type) ?? "image/png" };
	}
	return downloadImage(image.url, provider, input);
}

function imageEndpoint(baseURL: string, operation: "generations" | "edits"): string {
	try {
		return new URL(`images/${operation}`, baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString();
	} catch {
		throw new Error("Image endpoint must be an absolute URL");
	}
}

function toDataUrl(image: CompatibleReferenceImage): string {
	return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}

function firstImage(value: unknown): { b64_json?: string; url?: string; mime_type?: string } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as { data?: unknown; images?: unknown; output?: unknown };
	const data = Array.isArray(record.data)
		? record.data
		: Array.isArray(record.images)
			? record.images
			: Array.isArray(record.output)
				? record.output
				: undefined;
	if (data === undefined || data.length === 0) return undefined;
	const candidate = data[0];
	if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
	const item = candidate as { b64_json?: unknown; url?: unknown; mime_type?: unknown; mime?: unknown };
	const mime =
		typeof item.mime_type === "string" ? item.mime_type : typeof item.mime === "string" ? item.mime : undefined;
	// Length checks matter: some channels send `b64_json: ""` (or an empty
	// `url`) alongside the real field, and an empty string would shadow a
	// usable sibling value and fail later as "no image / invalid base64".
	return typeof item.b64_json === "string" && item.b64_json.length > 0
		? { b64_json: item.b64_json, ...(mime === undefined ? {} : { mime_type: mime }) }
		: typeof item.url === "string" && item.url.length > 0
			? { url: item.url, ...(mime === undefined ? {} : { mime_type: mime }) }
			: undefined;
}

async function downloadImage(
	url: string | undefined,
	provider: string,
	input: { maxBytes: number; signal: AbortSignal; apiKey?: string; proxy?: string },
): Promise<GeneratedImage> {
	if (url === undefined) throw new Error(`${provider} image request returned no image data`);
	if (url.startsWith("data:")) {
		const parsed = parseDataUrl(url);
		if (parsed === undefined) throw new Error(`${provider} image request returned invalid data URL`);
		const data = decodeBase64(parsed.base64, provider);
		return { data, mediaType: detectImageMediaType(data) ?? imageMediaTypeOf(parsed.mediaType) ?? "image/png" };
	}
	let response = await doFetch(
		url,
		{
			redirect: "follow",
			signal: input.signal,
			...(input.apiKey === undefined ? {} : { headers: { authorization: `Bearer ${input.apiKey}` } }),
		},
		input.proxy,
	);
	// Some relay CDNs (e.g. SenseNova's OSS) reject image downloads that carry
	// an Authorization header (WAF rules), even though the URL is public — and
	// not always with 401/403. Retrying without the header is safe (downgraded
	// request, no secret sent) and only turns a guaranteed failure into a
	// possible success: URLs that genuinely need auth failed anyway.
	if (!response.ok && input.apiKey !== undefined) {
		response = await doFetch(url, { redirect: "follow", signal: input.signal }, input.proxy);
	}
	if (!response.ok) throw new Error(`${provider} image download failed (${response.status})`);
	const data = await readBoundedBytes(response, input.maxBytes);
	const mediaType = detectImageMediaType(data) ?? imageMediaTypeOf(response.headers.get("content-type"));
	if (mediaType === undefined) throw new Error(`${provider} image download returned unsupported content type`);
	return { data, mediaType };
}

function parseDataUrl(value: string): { mediaType: string; base64: string } | undefined {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(value.trim());
	return match?.[1] !== undefined && match[2] !== undefined ? { mediaType: match[1], base64: match[2] } : undefined;
}

function decodeBase64(value: string, provider: string): Uint8Array {
	const parsed = parseDataUrl(value);
	const clean = (parsed?.base64 ?? value).replace(/\s+/g, "");
	if (clean.length === 0) throw new Error(`${provider} image request returned invalid base64 image data`);
	const decoded = Buffer.from(clean, "base64");
	if (decoded.length === 0) throw new Error(`${provider} image request returned invalid base64 image data`);
	return new Uint8Array(decoded);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maxBytes) throw new Error(`Image response exceeded the ${String(maxBytes)} byte limit`);
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const joined = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}
