/** xAI's image routes use aspect_ratio/resolution rather than OpenAI's size. Ported from dsh-image-gen (Apache-2.0). */
const RATIOS = new Set(["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2"]);

export function xaiToolParameters(options: { aspectRatio?: string; imageSize?: string; size?: string }): Record<string, string> {
	let ratio = options.aspectRatio;
	if (options.size !== undefined) {
		const match = /^(\d+)x(\d+)$/.exec(options.size);
		if (match === null) throw new Error("xAI size 请使用 WIDTHxHEIGHT；也可直接传 aspect_ratio");
		const width = Number(match[1]);
		const height = Number(match[2]);
		if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("xAI size 必须是正整数宽高");
		let divisor = width;
		let remainder = height;
		while (remainder !== 0) {
			const next = divisor % remainder;
			divisor = remainder;
			remainder = next;
		}
		const fromSize = `${String(width / divisor)}:${String(height / divisor)}`;
		if (ratio !== undefined && ratio !== fromSize) throw new Error("xAI size 与 aspect_ratio 不一致");
		ratio = fromSize;
	}
	if (ratio !== undefined && !RATIOS.has(ratio)) throw new Error(`xAI 不支持比例 ${ratio}`);
	const resolution = options.imageSize?.toLowerCase();
	if (resolution !== undefined && resolution !== "1k" && resolution !== "2k") throw new Error(`xAI 不支持清晰度 ${options.imageSize ?? ""}`);
	return { ...(ratio === undefined || ratio === "auto" ? {} : { aspect_ratio: ratio }), ...(resolution === undefined ? {} : { resolution }) };
}
