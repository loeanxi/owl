/** Image media-type sniffing shared by every adapter. Ported from dsh-image-gen (Apache-2.0). */

/** The image media types every owl-image path accepts and emits. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"

/** Provider-neutral image bytes produced by an adapter or read from a reference. */
export interface GeneratedImage {
	data: Uint8Array
	mediaType: ImageMediaType
}

/**
 * Detect the media type from the bytes themselves. Bytes are the ground truth:
 * relays and CDNs drop or lie about content-type headers, so adapters sniff
 * before honoring any declared type.
 */
export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
	if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
	if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg"
	if (ascii(data, 0, 6) === "GIF87a" || ascii(data, 0, 6) === "GIF89a") return "image/gif"
	if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") return "image/webp"
	return undefined
}

/** Parse a declared media-type string; undefined when unsupported. */
export function imageMediaTypeOf(value: string | null | undefined): ImageMediaType | undefined {
	const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase()
	return mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp" || mediaType === "image/gif"
		? mediaType
		: undefined
}

function startsWith(data: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((byte, index) => data[index] === byte)
}

function ascii(data: Uint8Array, offset: number, length: number): string {
	return String.fromCharCode(...data.subarray(offset, offset + length))
}

/** File extension for each supported image media type. */
export function extensionOf(mediaType: ImageMediaType): string {
	switch (mediaType) {
		case "image/jpeg":
			return "jpg"
		case "image/webp":
			return "webp"
		case "image/gif":
			return "gif"
		case "image/png":
			return "png"
	}
}
