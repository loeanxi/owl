/**
 * 对话框拖放分类：图片进预览，其余任意类型按本地路径附进本回合。
 * 系统拖放在 Windows 上由 Tauri 原生事件给出路径；网页拖放则从 File.path / file URI 取路径。
 */

const IMAGE_EXT_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

export function fileBasename(path: string): string {
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	return parts.at(-1) ?? path;
}

/** 扩展名或浏览器给出的 image/* 都算图片（资源管理器拖入时 type 经常是空的）。 */
export function imageMimeOfName(name: string, type = ""): string | undefined {
	if (type.startsWith("image/")) return type;
	return IMAGE_EXT_MIME[fileBasename(name).split(".").pop()?.toLowerCase() ?? ""];
}

export function fileUrlToPath(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "file:") return undefined;
	let path = decodeURIComponent(parsed.pathname);
	if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
	return path.length > 0 ? path : undefined;
}

export function pathsFromUriList(uriList: string): string[] {
	const paths: string[] = [];
	for (const line of uriList.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const path = trimmed.startsWith("file:") ? fileUrlToPath(trimmed) : undefined;
		if (path) paths.push(path);
	}
	return paths;
}

export type HtmlDropFile = { name: string; type?: string; path?: string };

/** 网页 drop：图片留下标给 FileReader；其余文件只要拿得到本地路径就当附件。 */
export function classifyHtmlDrop(files: readonly HtmlDropFile[], uriList = ""): {
	imageIndexes: number[];
	attachmentPaths: string[];
	unnamedCount: number;
} {
	const imageIndexes: number[] = [];
	const attachmentPaths: string[] = [];
	const seen = new Set<string>();
	const unnamed: string[] = [];
	const remember = (path: string): void => {
		if (seen.has(path)) return;
		seen.add(path);
		attachmentPaths.push(path);
	};
	files.forEach((file, index) => {
		if (imageMimeOfName(file.name, file.type ?? "") !== undefined) {
			imageIndexes.push(index);
			if (file.path) seen.add(file.path);
			return;
		}
		if (file.path && file.path.length > 0) remember(file.path);
		else unnamed.push(file.name);
	});
	for (const path of pathsFromUriList(uriList)) {
		if (imageMimeOfName(path) !== undefined) continue;
		remember(path);
		const covered = unnamed.indexOf(fileBasename(path));
		if (covered >= 0) unnamed.splice(covered, 1);
	}
	return { imageIndexes, attachmentPaths, unnamedCount: unnamed.length };
}

/** 系统拖放只给路径：图片单独读成预览，其他类型（含无扩展名、目录）全部作为附件。 */
export function splitDroppedPaths(paths: readonly string[]): { images: string[]; attachments: string[] } {
	const images: string[] = [];
	const attachments: string[] = [];
	const seen = new Set<string>();
	for (const raw of paths) {
		const path = raw.trim();
		if (path.length === 0 || seen.has(path)) continue;
		seen.add(path);
		if (imageMimeOfName(path) !== undefined) images.push(path);
		else attachments.push(path);
	}
	return { images, attachments };
}

function contains(rect: { left: number; top: number; right: number; bottom: number }, x: number, y: number): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Tauri 给的是相对 webview 的物理像素。CSS 矩形是逻辑像素。
 * 两种刻度都试一次：缩放或调试器打开时刻度可能对不上，命中任一即算落在对话框里。
 */
export function dropPointHits(
	rect: { left: number; top: number; right: number; bottom: number },
	position: { x: number; y: number },
	devicePixelRatio: number,
): boolean {
	if (rect.right <= rect.left || rect.bottom <= rect.top) return false;
	const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
	return contains(rect, position.x, position.y) || contains(rect, position.x / scale, position.y / scale);
}
