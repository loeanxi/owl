/** Google Gemini Interactions API adapter. Ported from dsh-image-gen src/google.ts (Apache-2.0). */

import type { AspectRatio, ImageSize } from "./config.ts";
import { doFetch } from "./config.ts";
import { detectImageMediaType, type GeneratedImage, type ImageMediaType, imageMediaTypeOf } from "./media.ts";
import { redactSecrets } from "./redact.ts";

const ERROR_LIMIT = 4096;
const REQUESTED_MEDIA_TYPE = "image/jpeg";

interface GoogleRequestBase {
	apiKey: string;
	endpoint: string;
	model: string;
	aspectRatio: AspectRatio;
	imageSize: ImageSize;
	maxBytes: number;
	signal: AbortSignal;
	/** Proxy override from the calling config; undefined honors the ambient proxy. */
	proxy?: string;
}

/** Send one native Google text-to-image request. */
export function generateGoogleImage(input: GoogleRequestBase & { prompt: string }): Promise<GeneratedImage> {
	return requestGoogleImage({
		...input,
		operation: "generation",
		interactionInput: input.prompt,
	});
}

/** Send one native Google image-editing request using already-resolved bytes. */
export function editGoogleImage(
	input: GoogleRequestBase & {
		prompt: string;
		sourceImages: Array<{ data: Uint8Array; mediaType: ImageMediaType }>;
	},
): Promise<GeneratedImage> {
	const parts: Array<Record<string, string>> = [];
	if (input.sourceImages.length === 1) {
		parts.push({
			type: "image",
			mime_type: input.sourceImages[0]!.mediaType,
			data: Buffer.from(input.sourceImages[0]!.data).toString("base64"),
		});
	} else {
		input.sourceImages.forEach((sourceImage, index) => {
			parts.push({ type: "text", text: `图 ${index + 1} (Image ${index + 1}):` });
			parts.push({
				type: "image",
				mime_type: sourceImage.mediaType,
				data: Buffer.from(sourceImage.data).toString("base64"),
			});
		});
	}
	parts.push({ type: "text", text: input.prompt });

	return requestGoogleImage({
		...input,
		operation: "editing",
		interactionInput: parts,
	});
}

/** Shared Google request, response parsing, decoding, and size enforcement. */
async function requestGoogleImage(
	input: GoogleRequestBase & {
		operation: "generation" | "editing";
		interactionInput: string | Array<Record<string, string>>;
	},
): Promise<GeneratedImage> {
	const label = `Google image ${input.operation}`;
	const response = await doFetch(
		input.endpoint,
		{
			method: "POST",
			redirect: "error",
			signal: input.signal,
			headers: { "content-type": "application/json", "x-goog-api-key": input.apiKey },
			body: JSON.stringify({
				model: input.model,
				input: input.interactionInput,
				response_format: {
					type: "image",
					mime_type: REQUESTED_MEDIA_TYPE,
					aspect_ratio: input.aspectRatio,
					image_size: input.imageSize,
				},
			}),
		},
		input.proxy,
	);
	const text = await readBoundedText(response, Math.ceil(input.maxBytes * 1.4) + ERROR_LIMIT, label);
	if (!response.ok)
		throw new Error(
			`${label} failed (${response.status}): ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`,
		);
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
	const image = outputImage(payload);
	if (image === undefined)
		throw new Error(`${label} returned no image: ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`);
	const data = decodeBase64(image.data, label);
	if (data.byteLength > input.maxBytes)
		throw new Error(`${label} exceeded the ${String(input.maxBytes)} byte image limit`);
	// Bytes are the ground truth: sniff before honoring the declared type so a
	// proxy that drops or lies about mime_type cannot poison downstream handling.
	const declared = typeof image.mime_type === "string" ? image.mime_type : REQUESTED_MEDIA_TYPE;
	const mediaType = detectImageMediaType(data) ?? imageMediaTypeOf(declared);
	if (mediaType === undefined)
		throw new Error(`${label} returned unsupported media type ${JSON.stringify(image.mime_type)}`);
	return { data, mediaType };
}

function outputImage(value: unknown): { data: string; mime_type?: unknown } | undefined {
	const interaction = record(value);
	if (interaction === undefined) return undefined;
	const direct = imageContent(interaction.output_image, false);
	if (direct !== undefined) return direct;
	if (!Array.isArray(interaction.steps)) return undefined;
	for (const step of interaction.steps) {
		const modelOutput = record(step);
		if (modelOutput?.type !== "model_output" || !Array.isArray(modelOutput.content)) continue;
		for (const content of modelOutput.content) {
			const image = imageContent(content, true);
			if (image !== undefined) return image;
		}
	}
	return undefined;
}

function imageContent(value: unknown, requiresImageType: boolean): { data: string; mime_type?: unknown } | undefined {
	const image = record(value);
	if (image === undefined || (requiresImageType && image.type !== "image") || typeof image.data !== "string")
		return undefined;
	return { data: image.data, mime_type: image.mime_type };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function decodeBase64(data: string, label: string): Uint8Array {
	const clean = data.replace(/\s+/g, "");
	if (clean.length === 0) throw new Error(`${label} returned invalid base64 image data`);
	const decoded = Buffer.from(clean, "base64");
	if (decoded.length === 0) throw new Error(`${label} returned invalid base64 image data`);
	return new Uint8Array(decoded);
}

async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maxBytes) throw new Error(`${label} response exceeded the ${String(maxBytes)} byte limit`);
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
	return new TextDecoder().decode(joined);
}
